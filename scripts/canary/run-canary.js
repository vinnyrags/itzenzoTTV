#!/usr/bin/env node
/**
 * Production canary — every-15-min health probe.
 *
 * Checks a small set of production endpoints. If any fail, the process
 * exits 1 AND posts a Discord embed describing what broke.
 *
 * Designed to run on a systemd timer or cron on the DO droplet, but
 * works anywhere with internet access (no Nous import, no DDEV — pure
 * node + fetch).
 *
 * Two alerting modes (cascading priority):
 *   Mode A — Bot + channel (preferred when running alongside Nous):
 *     CANARY_BOT_TOKEN and CANARY_CHANNEL_ID set → posts via the bot's
 *     existing Discord auth. No webhook URL setup needed; the production
 *     bot is already in your guild and authenticated.
 *   Mode B — Webhook URL (works anywhere):
 *     CANARY_WEBHOOK_URL set → posts via a channel webhook. Useful when
 *     running the canary off-box or with a separate alerting account.
 *
 * If neither is set, alerting is silent (exit code is the only signal).
 *
 * Env:
 *   CANARY_BOT_TOKEN      Discord bot token to post via bot REST API
 *   CANARY_CHANNEL_ID     Channel id (NOT name) to post canary alerts to
 *   CANARY_WEBHOOK_URL    Channel-webhook URL (alternative to bot token)
 *   CANARY_VERBOSE=1      Also notify on green (default: red-only)
 *   CANARY_SITE=...       Override base site (default: https://itzenzo.tv)
 *   CANARY_WP=...         Override WP host (default: https://vincentragosta.io)
 *
 * Exit codes:
 *   0  all checks passed
 *   1  one or more checks failed
 *   2  setup error
 */

const SITE = process.env.CANARY_SITE || 'https://itzenzo.tv';
const WP = process.env.CANARY_WP || 'https://vincentragosta.io';

/**
 * Bot-token resolution: prefer an explicit CANARY_BOT_TOKEN, otherwise
 * fall back to reading DISCORD_BOT_TOKEN from /opt/nous-bot/.env.
 *
 * On the production droplet this means a fresh canary install only needs
 * a CHANNEL_ID — the token is already on disk in the bot's existing
 * config and we reuse it. Off-box callers can still set CANARY_BOT_TOKEN
 * explicitly.
 */
import fs from 'node:fs';

function resolveBotToken() {
    if (process.env.CANARY_BOT_TOKEN) return process.env.CANARY_BOT_TOKEN;
    try {
        const env = fs.readFileSync('/opt/nous-bot/.env', 'utf8');
        const match = env.match(/^DISCORD_BOT_TOKEN=(.+)$/m);
        if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
    } catch {
        // file not readable — return null
    }
    return null;
}

const BOT_TOKEN = resolveBotToken();
const CHANNEL_ID = process.env.CANARY_CHANNEL_ID || null;
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
    const usingBot = !!(BOT_TOKEN && CHANNEL_ID);
    const usingWebhook = !!WEBHOOK;

    if (!usingBot && !usingWebhook) {
        console.log('No CANARY_BOT_TOKEN+CHANNEL_ID and no CANARY_WEBHOOK_URL — skipping Discord notification.');
        return;
    }

    const failed = results.filter((r) => !r.ok);
    const sloBreached = results.filter((r) => r.ok && r.sloBreach);

    const isRed = failed.length > 0;
    const isYellow = !isRed && sloBreached.length > 0;
    // Post on red (broken) and yellow (slow). Pure-green requires CANARY_VERBOSE=1.
    if (!isRed && !isYellow && !VERBOSE) return;

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

    // Mode A — Bot + channel: post via Discord REST as the bot
    if (usingBot) {
        try {
            const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
                method: 'POST',
                headers: {
                    Authorization: `Bot ${BOT_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ embeds: [embed] }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) {
                console.error(`Bot post → ${res.status} ${await res.text()}`);
            }
            return;
        } catch (e) {
            console.error('Bot post failed:', e.message);
            // Fall through to webhook fallback below if both are configured
            if (!usingWebhook) return;
        }
    }

    // Mode B — Channel webhook URL
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
    // Sequential, not parallel: a 6-way Promise.all creates connection-pool +
    // PHP-FPM worker contention that 2-3x's per-endpoint latency. The canary
    // should measure what a single buyer's request experiences, not what a
    // burst of self-traffic causes. Adds ~5s wallclock total (still trivial
    // for a 15-minute cadence) but the timings actually reflect production.
    const results = [];
    for (const check of CHECKS) results.push(await runCheck(check));
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
