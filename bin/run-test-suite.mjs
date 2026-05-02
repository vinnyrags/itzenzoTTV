#!/usr/bin/env node
/**
 * Critical-path test suite — terminal entrypoint.
 *
 * Drives the Nous test flows from the command line against the dedicated
 * test Discord guild (itzenzoTTV (Test)). Embeds land in real channels
 * (#order-feed, #queue, #pack-battles, etc.) — there's no #test-suite
 * funnel because the test guild itself is the funnel.
 *
 * Usage:
 *   node bin/run-test-suite.mjs                    — runs every flow
 *   node bin/run-test-suite.mjs card-night         — runs a single flow
 *   node bin/run-test-suite.mjs --funnel           — funnel embeds to #test-suite
 *                                                    (legacy behavior, parity with `!test`)
 *
 * Flow names: card-night, giveaway, race, shipping, loadtest, minecraft
 *
 * Env requirements (loaded from Nous/.env.test, gitignored):
 *   DISCORD_TEST_BOT_TOKEN
 *   DISCORD_TEST_GUILD_ID
 *   plus everything Nous's normal config requires (Stripe keys, etc.) — these
 *   come from .env. We layer .env.test ON TOP so test-only values win.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Step 1 — load .env first, then layer .env.test on top
// ---------------------------------------------------------------------------
function loadEnvFile(filePath) {
    if (!existsSync(filePath)) return;
    for (const raw of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const line = raw.replace(/^\s*export\s+/, '');
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (!m) continue;
        let val = m[2];
        // strip surrounding quotes
        val = val.replace(/^['"]|['"]$/g, '');
        process.env[m[1]] = val;
    }
}

loadEnvFile(path.join(ROOT, '.env'));
loadEnvFile(path.join(ROOT, '.env.test'));

if (!process.env.DISCORD_TEST_BOT_TOKEN || !process.env.DISCORD_TEST_GUILD_ID) {
    console.error('Missing DISCORD_TEST_BOT_TOKEN or DISCORD_TEST_GUILD_ID — populate .env.test.');
    process.exit(2);
}

// Force config to use the test bot token. config.js reads
// DISCORD_BOT_TOKEN at import time, so this must happen BEFORE the
// dynamic import below.
process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_TEST_BOT_TOKEN;

// Stub required-but-unused env vars so config.js's required() doesn't
// fail on a developer laptop with no .env. The test suite uses
// fakeCheckoutSession() and never makes real Stripe API calls — but
// config.js still exits if the key is missing at import time.
if (!process.env.STRIPE_SECRET_KEY) {
    process.env.STRIPE_SECRET_KEY = 'sk_test_critical_path_suite_dummy_no_real_calls';
}

// Isolate the SQLite database to a test-only file so the suite can wipe
// tables without touching whatever data.db happens to be next to the
// repo. Override with NOUS_TEST_DB_PATH if you need a specific file.
process.env.NOUS_DB_PATH =
    process.env.NOUS_TEST_DB_PATH ||
    path.join(ROOT, 'data.test.db');

// ---------------------------------------------------------------------------
// Step 2 — import config + Discord client
// ---------------------------------------------------------------------------
const { default: config } = await import('../config.js');
config.GUILD_ID = process.env.DISCORD_TEST_GUILD_ID;

const { client } = await import('../discord.js');

console.log(`> Logging in as test bot…`);
await client.login(config.DISCORD_BOT_TOKEN);
await new Promise((resolve) => client.once('clientReady', resolve));
console.log(`> Connected as ${client.user.tag} → guild ${config.GUILD_ID}`);

// ---------------------------------------------------------------------------
// Step 3 — resolve test guild's channels + roles by name; mutate config
// ---------------------------------------------------------------------------
const guild = await client.guilds.fetch(config.GUILD_ID);
await guild.channels.fetch();
await guild.roles.fetch();

const expectedChannelKeys = Object.keys(config.CHANNELS);
const newChannels = {};
for (const ch of guild.channels.cache.values()) {
    if (ch.type !== 0 && ch.type !== 2) continue; // text + voice only
    const key = ch.name.toUpperCase().replace(/-/g, '_');
    if (expectedChannelKeys.includes(key) && !newChannels[key]) {
        newChannels[key] = ch.id;
    }
}
const missingChannels = expectedChannelKeys.filter((k) => !newChannels[k]);
if (missingChannels.length) {
    console.warn(`> Warning: test guild missing channels: ${missingChannels.join(', ')}`);
    console.warn(`  flows that depend on these will skip their relevant steps.`);
}
config.CHANNELS = newChannels;

const expectedRoleKeys = Object.keys(config.ROLES);
const newRoles = {};
for (const r of guild.roles.cache.values()) {
    const key = r.name.toUpperCase();
    if (expectedRoleKeys.includes(key)) newRoles[key] = r.id;
}
const missingRoles = expectedRoleKeys.filter((k) => !newRoles[k]);
if (missingRoles.length) {
    console.warn(`> Warning: test guild missing roles: ${missingRoles.join(', ')}`);
}
config.ROLES = { ...config.ROLES, ...newRoles };

console.log(`> Mapped ${Object.keys(newChannels).length} channels, ${Object.keys(newRoles).length} roles to test guild.`);

// ---------------------------------------------------------------------------
// Step 4 — run the requested flow(s)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flow = args[0] || null; // null = all
const useFunnel = process.argv.includes('--funnel');
const dryRun = process.argv.includes('--dry-run');

if (dryRun) {
    console.log('');
    console.log(`> Dry run — connection + channel mapping verified. Skipping flows.`);
    await client.destroy();
    process.exit(0);
}

const { runTestSuite } = await import('../commands/test.js');

console.log('');
console.log(`> Running flow: ${flow || 'ALL'}${useFunnel ? '  (funneling embeds to #test-suite)' : '  (real channels, no funnel)'}`);
console.log('');

const startedAt = Date.now();
let exitCode = 0;
try {
    await runTestSuite(flow, {
        useChannelOverrides: useFunnel,
        resultsChannel: useFunnel ? 'TEST_SUITE' : 'OPS',
    });
    console.log('');
    console.log(`> Suite finished in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
} catch (e) {
    console.error('');
    console.error(`> Suite failed: ${e.message}`);
    console.error(e.stack);
    exitCode = 1;
}

await client.destroy();
process.exit(exitCode);
