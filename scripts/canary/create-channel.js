#!/usr/bin/env node
/**
 * One-shot: create a #canary channel in a guild via Discord REST.
 *
 * Reuses the same bot-token resolution as run-canary.js: reads
 * DISCORD_BOT_TOKEN from /opt/nous-bot/.env on the production droplet,
 * or honors CANARY_BOT_TOKEN / DISCORD_BOT_TOKEN env vars when run
 * elsewhere (e.g., from a laptop with the test bot token).
 *
 * Usage:
 *   node scripts/canary/create-channel.js <guild-id> [channel-name]
 *
 * Examples (production droplet — uses /opt/nous-bot/.env automatically):
 *   node scripts/canary/create-channel.js 862139045974638612
 *
 * Local against test guild (export the test bot token first):
 *   DISCORD_BOT_TOKEN=<test-bot-token> node scripts/canary/create-channel.js 1499939395778904184
 *
 * Prints the new channel id to stdout — drop it straight into
 * /etc/canary.env as CANARY_CHANNEL_ID=<id>.
 */

import fs from 'node:fs';

function resolveBotToken() {
    if (process.env.CANARY_BOT_TOKEN) return process.env.CANARY_BOT_TOKEN;
    if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
    try {
        const env = fs.readFileSync('/opt/nous-bot/.env', 'utf8');
        const match = env.match(/^DISCORD_BOT_TOKEN=(.+)$/m);
        if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
    } catch {
        // file not readable
    }
    return null;
}

const guildId = process.argv[2];
const channelName = process.argv[3] || 'canary';

if (!guildId) {
    console.error('Usage: node create-channel.js <guild-id> [channel-name]');
    process.exit(2);
}

const token = resolveBotToken();
if (!token) {
    console.error('No bot token. Set DISCORD_BOT_TOKEN or run on a host with /opt/nous-bot/.env readable.');
    process.exit(2);
}

const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        name: channelName,
        type: 0, // GUILD_TEXT
        topic: 'Production health probe — every 15 min HTTP check across itzenzo.tv + vincentragosta.io. Red = something is broken; yellow = SLO breach (informational).',
    }),
});

if (!res.ok) {
    console.error(`Failed: HTTP ${res.status}`);
    console.error(await res.text());
    process.exit(1);
}

const channel = await res.json();
console.log(`Created #${channel.name} in guild ${guildId}`);
console.log(`Channel ID: ${channel.id}`);
console.log('');
console.log('Next:');
console.log(`  echo "CANARY_CHANNEL_ID=${channel.id}" > /etc/canary.env`);
console.log(`  chmod 600 /etc/canary.env`);
