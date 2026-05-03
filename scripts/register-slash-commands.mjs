#!/usr/bin/env node
/**
 * Register slash commands with Discord. Run after adding/changing any
 * slash command. Guild-scoped registrations propagate instantly; global
 * registrations take ~1 hour. We use guild-scoped against production.
 *
 * Usage:
 *   node scripts/register-slash-commands.mjs           — production guild
 *   GUILD_ID=<test-guild-id> node scripts/...          — override target
 */

import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID || process.env.APPLICATION_ID;
const GUILD_ID = process.env.GUILD_ID || '862139045974638612'; // production

if (!TOKEN) { console.error('DISCORD_BOT_TOKEN missing'); process.exit(2); }
if (!APPLICATION_ID) {
    console.error('DISCORD_APPLICATION_ID missing — set in .env. Find it in the Discord Developer Portal under your bot application.');
    process.exit(2);
}

// All slash commands are Akivili-only. We restrict via Discord's
// default_member_permissions (admin) AND a runtime role check in each
// handler — defense in depth.
const ADMIN_ONLY = PermissionFlagsBits.Administrator;

const commands = [
    // /op <command-string> — universal dispatcher
    new SlashCommandBuilder()
        .setName('op')
        .setDescription('Run a legacy ops command (universal dispatcher)')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption((opt) => opt
            .setName('command')
            .setDescription('e.g. "queue close", "battle start \\"My Product\\" 20", "sync"')
            .setRequired(true)),

    // /queue open|close|history
    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Manage the live queue session')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s.setName('open').setDescription('Open a fresh queue session'))
        .addSubcommand((s) => s.setName('close').setDescription('Close the active session'))
        .addSubcommand((s) => s.setName('history').setDescription('Show recent sessions')),

    // /reset (button confirmation in handler)
    new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Wipe transactional state for next stream (with confirmation)')
        .setDefaultMemberPermissions(ADMIN_ONLY),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    console.log(`Registering ${commands.length} slash command(s) to guild ${GUILD_ID}...`);
    try {
        const data = await rest.put(
            Routes.applicationGuildCommands(APPLICATION_ID, GUILD_ID),
            { body: commands },
        );
        console.log(`✓ Registered:`);
        for (const c of data) console.log(`  /${c.name}`);
    } catch (e) {
        console.error('✗ Registration failed:', e.message);
        process.exit(1);
    }
})();
