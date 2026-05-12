/**
 * Audit WP product + card stripe_price_id values against the active
 * Stripe mode (live vs test).
 *
 * Symptom this prevents:
 *   After the May 2026 test→live cutover, some WP posts could still
 *   carry test-mode price IDs in postmeta. The cart's pre-flight
 *   (CreateCheckoutEndpoint::findFirstInactivePriceId) will catch it
 *   and surface a friendly 409, but the buyer still can't complete the
 *   purchase. This audit finds those drifted IDs *before* a buyer hits
 *   them, so we can re-push the missing items into live mode and the
 *   catalog-side meta gets refreshed.
 *
 * Why this is separate from audit-stripe-active.js:
 *   audit-stripe-active.js walks Stripe-side INACTIVE products and
 *   matches them to WP. That misses test-mode-only IDs entirely
 *   (Stripe live's `products.list({active:false})` won't return them).
 *   This script walks WP-side instead and probes each ID against the
 *   current Stripe mode.
 *
 * What this script does:
 *   1. Pulls every distinct stripe_price_id from wp_postmeta.
 *   2. For each, calls stripe.prices.retrieve(id).
 *   3. Bins each ID into: ok | inactive | not_found | error.
 *   4. For not_found IDs, runs a wp-cli query to list which
 *      post(s) reference them so the operator knows what to re-push.
 *
 * Usage (run from server, where the live key is in env):
 *   ssh root@174.138.70.29 'cd /opt/nous-bot && \
 *     STRIPE_SECRET_KEY=$(grep -E "^\s*STRIPE_SECRET_KEY" .env | cut -d= -f2 | tr -d "\"") \
 *     /root/.nvm/versions/node/v24.14.0/bin/node scripts/shop/audit-mode-drift.js'
 *
 * Exit codes:
 *   0 — every WP-stored price exists in the current Stripe mode
 *   1 — at least one drifted (not_found) reference
 *   2 — runtime error
 */

import { execSync } from 'child_process';
import Stripe from 'stripe';

const REMOTE = process.argv.find((a) => a.startsWith('--remote='))?.split('=')[1];
const LOCAL = process.argv.includes('--local') || REMOTE === 'local' || !REMOTE;
const REMOTE_HOST = REMOTE && !LOCAL ? REMOTE : null;
const WP_PATH = '/var/www/vincentragosta.io';

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_KEY) {
    console.error('STRIPE_SECRET_KEY missing.');
    process.exit(2);
}

const mode = STRIPE_KEY.startsWith('sk_live_') ? 'LIVE' : 'TEST';
console.log(`Stripe mode: ${mode} (${STRIPE_KEY.slice(0, 12)}...)`);

const stripe = new Stripe(STRIPE_KEY);

function wpExec(wpArgs) {
    const wpInvocation = `cd ${WP_PATH} && wp ${wpArgs} --allow-root --skip-themes --skip-plugins`;
    const cmd = LOCAL
        ? wpInvocation
        : `ssh ${REMOTE_HOST} "${wpInvocation.replace(/"/g, '\\"')}"`;
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

console.log('Fetching distinct stripe_price_id values from wp_postmeta...');
const sql = `SELECT DISTINCT meta_value FROM wp_postmeta WHERE meta_key = 'stripe_price_id' AND meta_value LIKE 'price_%' ORDER BY meta_value;`;
const raw = wpExec(`db query "${sql}" --skip-column-names`);
const priceIds = raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('price_'));

console.log(`Found ${priceIds.length} distinct stored price ID(s). Probing Stripe...`);

const buckets = { ok: [], inactive: [], not_found: [], error: [] };

for (const id of priceIds) {
    try {
        const price = await stripe.prices.retrieve(id, { expand: ['product'] });
        if (!price.active) {
            buckets.inactive.push({ id, reason: 'price.active=false' });
        } else if (price.product && typeof price.product !== 'string' && !price.product.active) {
            buckets.inactive.push({ id, reason: 'product.active=false' });
        } else {
            buckets.ok.push({ id });
        }
    } catch (e) {
        if (
            e.type === 'StripeInvalidRequestError' &&
            /No such price/i.test(e.message)
        ) {
            buckets.not_found.push({ id, message: e.message });
        } else {
            buckets.error.push({ id, message: e.message });
        }
    }
}

console.log('');
console.log(`OK:        ${buckets.ok.length}`);
console.log(`Inactive:  ${buckets.inactive.length}`);
console.log(`Not found: ${buckets.not_found.length}  ← drift / mode-mismatch`);
console.log(`Errors:    ${buckets.error.length}`);

if (buckets.not_found.length > 0) {
    console.log('');
    console.log('--- DRIFT (priceId stored in WP, missing from current Stripe mode) ---');
    for (const { id, message } of buckets.not_found) {
        console.log(`\n  ${id}`);
        console.log(`    ${message.split(';')[0]}${message.includes('test mode') ? '  [TEST-MODE ID]' : ''}`);
        // Find which post(s) reference this priceId.
        const refSql = `SELECT pm.post_id, p.post_title, p.post_type FROM wp_postmeta pm JOIN wp_posts p ON p.ID = pm.post_id WHERE pm.meta_key='stripe_price_id' AND pm.meta_value='${id}';`;
        try {
            const refs = wpExec(`db query "${refSql}" --skip-column-names`).trim();
            if (refs) {
                refs.split('\n').forEach((line) => console.log(`    → ${line}`));
            }
        } catch (refErr) {
            console.log(`    (could not look up references: ${refErr.message})`);
        }
    }
}

if (buckets.inactive.length > 0) {
    console.log('');
    console.log('--- INACTIVE (priceId exists but archived) ---');
    for (const { id, reason } of buckets.inactive) {
        console.log(`  ${id}  (${reason})`);
    }
}

if (buckets.error.length > 0) {
    console.log('');
    console.log('--- ERRORS (Stripe call failed for non-drift reason) ---');
    for (const { id, message } of buckets.error) {
        console.log(`  ${id}  ${message}`);
    }
}

console.log('');
process.exit(buckets.not_found.length > 0 ? 1 : 0);
