/**
 * Audit Stripe products against WordPress catalog references.
 *
 * Symptom this prevents:
 *   A buyer adds an item to the cart whose `stripe_product_id` points at
 *   a Stripe product that has been archived (or deleted in test mode).
 *   Stripe rejects the entire checkout session with
 *   "Price `…` is not available because its product is not active",
 *   silently killing the cart.
 *
 * What this script does:
 *   1. Lists every INACTIVE Stripe product (paginated).
 *   2. For each, runs `wp db query` over SSH against production to find
 *      any WP card or product with that stripe_product_id in postmeta.
 *   3. Reports the matches.
 *   4. With --apply, updates each affected post: stock_quantity = 0
 *      (so it falls out of catalog and cart), and clears the stale
 *      stripe_price_id / stripe_product_id meta so a future re-push can
 *      attach a fresh active price without colliding.
 *
 * Why we don't also delete in this script:
 *   Going from archived → deleted is push-cards.js / push-products.js
 *   `--clean` territory. Those scripts have been updated to delete
 *   instead of archive (env-gated via STRIPE_DELETE_WHEN_REMOVING).
 *   This script's job is the *catalog-side* cleanup so existing stale
 *   references stop tripping buyers.
 *
 * Usage:
 *   node scripts/shop/audit-stripe-active.js               # dry-run, full report
 *   node scripts/shop/audit-stripe-active.js --apply       # write fixes
 *   node scripts/shop/audit-stripe-active.js --json        # JSON output (machine-readable)
 *   node scripts/shop/audit-stripe-active.js --remote=...  # override SSH host (default: prod)
 *
 * Exit codes:
 *   0 — no stale references found
 *   1 — stale references exist (use --apply to fix, or run again after cleanup)
 *   2 — runtime error (Stripe / SSH / WP-CLI failure)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Stripe = require('stripe');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const JSON_OUT = args.includes('--json');
const REMOTE_ARG = args.find((a) => a.startsWith('--remote='));
const REMOTE = REMOTE_ARG ? REMOTE_ARG.split('=')[1] : 'root@174.138.70.29';
// Pass --remote=local (or --local) when running on the box itself so
// wp-cli runs in-process instead of looping back through SSH.
const LOCAL = args.includes('--local') || REMOTE === 'local' || REMOTE === 'localhost';
const WP_PATH = '/var/www/vincentragosta.io';

function wpCommand(wpArgs) {
    const wpInvocation = `cd ${WP_PATH} && wp ${wpArgs} --allow-root --skip-themes`;
    return LOCAL ? wpInvocation : `ssh ${REMOTE} "${wpInvocation.replace(/"/g, '\\"')}"`;
}

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || (() => {
    const envFile = path.join(__dirname, '../../wp-config-env.php');
    if (fs.existsSync(envFile)) {
        const content = fs.readFileSync(envFile, 'utf8');
        const match = content.match(/define\('STRIPE_SECRET_KEY',\s*'([^']+)'\)/);
        return match ? match[1] : '';
    }
    return '';
})();

if (!STRIPE_KEY) {
    console.error('Error: STRIPE_SECRET_KEY not found (set env var or wp-config-env.php define).');
    process.exit(2);
}

const stripe = new Stripe(STRIPE_KEY);
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

async function listInactiveProducts() {
    const inactive = [];
    let hasMore = true;
    let startingAfter = null;
    while (hasMore) {
        const params = { limit: 100, active: false };
        if (startingAfter) params.starting_after = startingAfter;
        const page = await stripe.products.list(params);
        for (const p of page.data) {
            inactive.push({ id: p.id, name: p.name, type: p.metadata?.type ?? null });
            startingAfter = p.id;
        }
        hasMore = page.has_more;
    }
    return inactive;
}

/**
 * One round-trip to production: hand WP-CLI the entire list of inactive
 * Stripe product IDs, get back every WP post that references any of them.
 * Beats N round-trips when the inactive list is large.
 */
function findWpReferences(stripeProductIds) {
    if (stripeProductIds.length === 0) return [];

    const inClause = stripeProductIds
        .map((id) => `'${id.replace(/'/g, "''")}'`)
        .join(',');

    const sql = `
        SELECT p.ID, p.post_type, p.post_title, p.post_status,
               pm_pid.meta_value AS stripe_product_id,
               pm_pri.meta_value AS stripe_price_id,
               pm_stk.meta_value AS stock
        FROM wp_postmeta pm_pid
        JOIN wp_posts p ON p.ID = pm_pid.post_id
        LEFT JOIN wp_postmeta pm_pri ON pm_pri.post_id = p.ID AND pm_pri.meta_key = 'stripe_price_id'
        LEFT JOIN wp_postmeta pm_stk ON pm_stk.post_id = p.ID AND pm_stk.meta_key = 'stock_quantity'
        WHERE pm_pid.meta_key = 'stripe_product_id'
          AND pm_pid.meta_value IN (${inClause})
    `.trim().replace(/\s+/g, ' ');

    const cmd = wpCommand(`db query "${sql.replace(/"/g, '\\"')}"`);
    let raw;
    try {
        raw = execSync(cmd, { encoding: 'utf8' });
    } catch (e) {
        console.error('WP-CLI query failed:', e.message);
        process.exit(2);
    }

    const lines = raw.trim().split('\n');
    if (lines.length < 2) return [];
    const [header, ...rows] = lines;
    const cols = header.split('\t');
    return rows.map((row) => {
        const fields = row.split('\t');
        const obj = {};
        cols.forEach((c, i) => { obj[c] = fields[i]; });
        return obj;
    });
}

function applyFixes(refs) {
    if (refs.length === 0) return { updated: 0 };
    let updated = 0;
    for (const ref of refs) {
        const id = ref.ID;
        try {
            // Set stock=0, clear stale stripe_price_id and stripe_product_id.
            // We keep the post around (publish/draft is the user's call) so
            // the URL doesn't 404 — cart simply can't add it again.
            // Three writes per post — keep them sequential so a failure
            // on one doesn't masquerade as success.
            execSync(wpCommand(`post meta update ${id} stock_quantity 0`), { encoding: 'utf8', stdio: 'pipe' });
            execSync(wpCommand(`post meta delete ${id} stripe_price_id`), { encoding: 'utf8', stdio: 'pipe' });
            execSync(wpCommand(`post meta delete ${id} stripe_product_id`), { encoding: 'utf8', stdio: 'pipe' });
            updated++;
        } catch (e) {
            console.error(`  Failed to fix post ${id}:`, e.message);
        }
    }
    return { updated };
}

(async function main() {
    log('Listing inactive Stripe products…');
    const inactive = await listInactiveProducts();
    log(`  ${inactive.length} inactive product(s) in Stripe.\n`);

    log('Querying WP for references…');
    const refs = findWpReferences(inactive.map((p) => p.id));
    const refsByProductId = new Map();
    for (const r of refs) {
        const arr = refsByProductId.get(r.stripe_product_id) ?? [];
        arr.push(r);
        refsByProductId.set(r.stripe_product_id, arr);
    }

    const stale = inactive.filter((p) => refsByProductId.has(p.id));

    if (JSON_OUT) {
        console.log(JSON.stringify({ stale, refsByProductId: Object.fromEntries(refsByProductId) }, null, 2));
    } else {
        if (stale.length === 0) {
            log('Catalog is clean — no WP posts reference inactive Stripe products.');
            process.exit(0);
        }

        log(`\n!! Stale references found: ${stale.length} inactive Stripe product(s) referenced by WP catalog.\n`);
        for (const p of stale) {
            log(`  Stripe ${p.id} (${p.type ?? 'no-type'}): ${p.name}`);
            for (const r of refsByProductId.get(p.id)) {
                log(`    → WP ${r.post_type} #${r.ID} "${r.post_title}" status=${r.post_status} stock=${r.stock ?? '-'}`);
            }
        }
        log('');
    }

    if (APPLY) {
        log('Applying fixes (stock=0 + clear stripe_price_id/stripe_product_id)…');
        const allRefs = [].concat(...refsByProductId.values());
        const result = applyFixes(allRefs);
        log(`  ${result.updated}/${allRefs.length} post(s) updated.`);
        log('  Run `node scripts/shop/audit-stripe-active.js` again to verify.');
        process.exit(0);
    }

    log('Re-run with --apply to set stock=0 and clear stale stripe IDs on each affected post.');
    process.exit(stale.length > 0 ? 1 : 0);
})().catch((e) => {
    console.error('Fatal:', e.message);
    process.exit(2);
});
