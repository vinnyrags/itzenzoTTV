#!/usr/bin/env node
/**
 * Production canary — every-15-min health probe.
 *
 * Checks a small set of production endpoints. If any fail, the process
 * exits 1 AND posts a Discord embed describing what broke.
 *
 * Designed to run on a systemd timer or cron on the DO droplet, but
 * works anywhere with internet access (no bot token, no Nous import,
 * no DDEV — pure node + fetch).
 *
 * Env:
 *   CANARY_WEBHOOK_URL    Discord webhook URL (required for alerting).
 *                         Create via channel settings → Integrations →
 *                         Webhooks → New Webhook in #ops or #canary.
 *   CANARY_VERBOSE=1      Also notify on green (default: red-only).
 *   CANARY_SITE=...       Override base site (default: https://itzenzo.tv)
 *   CANARY_WP=...         Override WP host (default: https://vincentragosta.io)
 *
 * Exit codes:
 *   0  all checks passed
 *   1  one or more checks failed
 *   2  setup error (missing env, etc.)
 */

const SITE = process.env.CANARY_SITE || 'https://itzenzo.tv';
const WP = process.env.CANARY_WP || 'https://vincentragosta.io';
const WEBHOOK = process.env.CANARY_WEBHOOK_URL || null;
const VERBOSE = process.env.CANARY_VERBOSE === '1';

/**
 * The check list.
 *
 *   url    — full URL
 *   name   — short label for the embed
 *   expect — predicate against (status, body) returning true on success
 *   slo    — soft latency budget (ms); breach is reported but doesn't fail
 */
const CHECKS = [
    {
        url: `${SITE}/`,
        name: 'itzenzo.tv homepage',
        expect: ({ status }) => status === 200,
        slo: 3000,
    },
    {
        url: `${SITE}/cards`,
        name: 'itzenzo.tv /cards',
        expect: ({ status }) => status === 200,
        slo: 3000,
    },
    {
        url: `${SITE}/how-it-works/refund-policy`,
        name: 'itzenzo.tv refund-policy',
        expect: ({ status }) => status === 200,
        slo: 3000,
    },
    {
        url: `${SITE}/api/queue/snapshot`,
        name: 'itzenzo.tv /api/queue/snapshot',
        // 200 with JSON; 304 if ETag matches a prior request (also fine)
        expect: ({ status }) => status === 200 || status === 304,
        slo: 2000,
    },
    {
        url: `${WP}/wp-json/shop/v1/queue`,
        name: 'vincentragosta.io /wp-json/shop/v1/queue',
        expect: ({ status }) => status === 200,
        slo: 2000,
    },
    {
        url: `${WP}/`,
        name: 'vincentragosta.io homepage',
        expect: ({ status }) => status === 200,
        slo: 3000,
    },
];

async function runCheck(check) {
    const startedAt = Date.now();
    let status = 0;
    let bodyTail = '';
    let networkError = null;

    try {
        const res = await fetch(check.url, {
            method: 'GET',
            redirect: 'manual', // catch unexpected redirects
            headers: { 'User-Agent': 'itzenzo-canary/1.0' },
            signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        // Only read a tiny body tail for failure context
        const text = await res.text().catch(() => '');
        bodyTail = text.slice(0, 200);
    } catch (e) {
        networkError = e.message;
    }

    const elapsed = Date.now() - startedAt;
    const ok = !networkError && check.expect({ status, body: bodyTail });
    const sloBreach = !networkError && elapsed > check.slo;

    return {
        name: check.name,
        url: check.url,
        ok,
        status,
        elapsed,
        sloBreach,
        networkError,
        bodyTail: ok ? null : bodyTail,
    };
}

async function postWebhook(results) {
    if (!WEBHOOK) {
        console.log('CANARY_WEBHOOK_URL not set — skipping Discord notification.');
        return;
    }

    const failed = results.filter((r) => !r.ok);
    const sloBreached = results.filter((r) => r.ok && r.sloBreach);

    const isRed = failed.length > 0;
    if (!isRed && !VERBOSE) return;

    const totalMs = results.reduce((sum, r) => sum + r.elapsed, 0);
    const summary = isRed
        ? `❌ ${failed.length}/${results.length} checks failed`
        : sloBreached.length > 0
            ? `🟡 all green, ${sloBreached.length} slow`
            : `✅ all green (${totalMs}ms total)`;

    const lines = [];
    if (isRed) {
        for (const r of failed) {
            const detail = r.networkError
                ? `network error: ${r.networkError}`
                : `HTTP ${r.status}`;
            lines.push(`✗ **${r.name}** — ${detail} (${r.elapsed}ms)`);
            if (r.bodyTail && !r.networkError) {
                lines.push(`  \`${r.bodyTail.replace(/`/g, '\\`')}\``);
            }
        }
        if (sloBreached.length > 0) {
            lines.push('');
            lines.push('Also slow (within budget but worth noting):');
            for (const r of sloBreached) {
                lines.push(`• ${r.name} — ${r.elapsed}ms (budget ${results.find(x => x.name === r.name)?.elapsed}ms)`);
            }
        }
    } else {
        // Verbose green run — short OK list
        for (const r of results) {
            const flag = r.sloBreach ? '🟡' : '✓';
            lines.push(`${flag} ${r.name} — ${r.elapsed}ms`);
        }
    }

    const embed = {
        title: `Canary — ${summary}`,
        description: lines.join('\n'),
        color: isRed ? 0xe74c3c : sloBreached.length > 0 ? 0xf39c12 : 0x2ecc71,
        footer: { text: `${SITE} + ${WP}` },
        timestamp: new Date().toISOString(),
    };

    try {
        const res = await fetch(WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            console.error(`Webhook POST → ${res.status} ${await res.text()}`);
        }
    } catch (e) {
        console.error('Webhook POST failed:', e.message);
    }
}

(async () => {
    const results = await Promise.all(CHECKS.map(runCheck));
    const failed = results.filter((r) => !r.ok);
    const slow = results.filter((r) => r.ok && r.sloBreach);

    // Console output for systemd journal / cron logs
    for (const r of results) {
        const tag = !r.ok ? '✗' : r.sloBreach ? '🟡' : '✓';
        const detail = r.networkError ? `ERR ${r.networkError}` : `HTTP ${r.status}`;
        console.log(`${tag} ${r.name.padEnd(40)} ${detail.padEnd(15)} ${r.elapsed}ms`);
    }
    console.log(`\n${failed.length} failed, ${slow.length} slow (of ${results.length})`);

    await postWebhook(results);

    process.exit(failed.length > 0 ? 1 : 0);
})().catch((e) => {
    console.error('Canary error:', e);
    process.exit(2);
});
