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
            .setRequired(true)
            .setAutocomplete(true)),

    // /queue open|close|history|next|skip
    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Manage the live queue session')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s.setName('open').setDescription('Open a fresh queue session'))
        .addSubcommand((s) => s.setName('close').setDescription('Close the active session'))
        .addSubcommand((s) => s.setName('history').setDescription('Show recent sessions'))
        .addSubcommand((s) => s.setName('next').setDescription('Advance to the next entry'))
        .addSubcommand((s) => s.setName('skip').setDescription('Skip the current entry')),

    // /reset (button confirmation in handler)
    new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Wipe transactional state for next stream (with confirmation)')
        .setDefaultMemberPermissions(ADMIN_ONLY),

    // /live — go live
    new SlashCommandBuilder()
        .setName('live')
        .setDescription('Announce stream start; set live state')
        .setDefaultMemberPermissions(ADMIN_ONLY),

    // /offline — go offline
    new SlashCommandBuilder()
        .setName('offline')
        .setDescription('Announce stream end; clear live state')
        .setDefaultMemberPermissions(ADMIN_ONLY),

    // /sync mode:full|stripe
    new SlashCommandBuilder()
        .setName('sync')
        .setDescription('Sync catalog (Sheets → Stripe → WordPress)')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption((opt) => opt
            .setName('mode')
            .setDescription('full = Sheets+Stripe+WP (default), stripe = Stripe-only (faster)')
            .addChoices(
                { name: 'full (default)', value: 'full' },
                { name: 'stripe', value: 'stripe' },
            )),

    // /hype — pre-stream hype, looks up products in Stripe
    new SlashCommandBuilder()
        .setName('hype')
        .setDescription('Pre-stream hype: look up products in Stripe, post embed + checkout URLs')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption((o) => o
            .setName('products')
            .setDescription('Comma-separated product names, e.g. "Crown Zenith, Prismatic Evolutions"')
            .setRequired(true)),

    // /battle <subcommand>
    new SlashCommandBuilder()
        .setName('battle')
        .setDescription('Manage pack battles')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s
            .setName('start')
            .setDescription('Start a new pack battle')
            .addStringOption((o) => o.setName('product').setDescription('Product name').setRequired(true))
            .addIntegerOption((o) => o.setName('max').setDescription('Max entries (default 20, capped at 50)').setMinValue(2).setMaxValue(50)))
        .addSubcommand((s) => s.setName('close').setDescription('Close the active battle'))
        .addSubcommand((s) => s.setName('cancel').setDescription('Cancel the active battle'))
        .addSubcommand((s) => s.setName('status').setDescription('Show battle status'))
        .addSubcommand((s) => s
            .setName('winner')
            .setDescription('Declare the battle winner')
            .addUserOption((o) => o.setName('user').setDescription('Winning user').setRequired(true))),

    // /duckrace <subcommand>
    new SlashCommandBuilder()
        .setName('duckrace')
        .setDescription('Run the duck race for the active queue')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s.setName('show').setDescription('Show current duck race state'))
        .addSubcommand((s) => s.setName('start').setDescription('Start the duck race'))
        .addSubcommand((s) => s
            .setName('winner')
            .setDescription('Declare the duck race winner')
            .addUserOption((o) => o.setName('user').setDescription('Winning user').setRequired(true)))
        .addSubcommand((s) => s
            .setName('pick')
            .setDescription('Owner-only: rig the duck race outcome')
            .addUserOption((o) => o.setName('user').setDescription('User to pick').setRequired(true))),

    // /spin — pick giveaway winner
    new SlashCommandBuilder()
        .setName('spin')
        .setDescription('Pick a giveaway winner')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s.setName('random').setDescription('Random pick from giveaway entrants'))
        .addSubcommand((s) => s
            .setName('pick')
            .setDescription('Owner-only: pick a specific winner')
            .addUserOption((o) => o.setName('user').setDescription('User to pick').setRequired(true))),

    // ----- Phase C — mid/low frequency native commands -----

    // /link — user-facing (everyone), buyer self-link email ↔ Discord ID
    new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link your email to your Discord ID for purchase tracking')
        .addStringOption((o) => o.setName('email').setDescription('Email used at checkout').setRequired(true)),

    // /pull — pull-box admin
    new SlashCommandBuilder()
        .setName('pull')
        .setDescription('Pull-box lifecycle')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s.setName('open').setDescription('Open a pull box')
            .addStringOption((o) => o.setName('args').setDescription('Optional args (tier, slot count, etc)')))
        .addSubcommand((s) => s.setName('close').setDescription('Close active pull box')
            .addStringOption((o) => o.setName('args').setDescription('Optional args')))
        .addSubcommand((s) => s.setName('replenish').setDescription('Add slots to a pull box')
            .addStringOption((o) => o.setName('args').setDescription('Args (tier, count, etc)')))
        .addSubcommand((s) => s.setName('status').setDescription('Show current pull-box status')),

    // /giveaway — giveaway lifecycle
    new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Giveaway lifecycle')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s.setName('start').setDescription('Start a new giveaway')
            .addStringOption((o) => o.setName('args').setDescription('Title + optional duration')))
        .addSubcommand((s) => s.setName('close').setDescription('Close active giveaway'))
        .addSubcommand((s) => s.setName('cancel').setDescription('Cancel active giveaway'))
        .addSubcommand((s) => s.setName('status').setDescription('Show active giveaway state'))
        .addSubcommand((s) => s.setName('test').setDescription('Test giveaway flow')
            .addStringOption((o) => o.setName('args').setDescription('Optional test args')))
        .addSubcommand((s) => s.setName('clean').setDescription('Clean up old giveaways'))
        .addSubcommand((s) => s.setName('off').setDescription('Disable giveaway feature')),

    // /coupon — coupon lifecycle
    new SlashCommandBuilder()
        .setName('coupon')
        .setDescription('Coupon lifecycle')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s
            .setName('create')
            .setDescription('Create a new coupon')
            .addIntegerOption((o) => o.setName('amount').setDescription('Discount amount in cents').setRequired(true).setMinValue(1)))
        .addSubcommand((s) => s.setName('off').setDescription('Disable active coupon'))
        .addSubcommand((s) => s.setName('status').setDescription('Show active coupon')),

    // /tracking — package tracking
    new SlashCommandBuilder()
        .setName('tracking')
        .setDescription('Package tracking lookup')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s
            .setName('lookup')
            .setDescription('Look up tracking by reference')
            .addStringOption((o) => o.setName('reference').setDescription('Order ref or Stripe session id').setRequired(true)))
        .addSubcommand((s) => s.setName('list').setDescription('List recent tracked shipments'))
        .addSubcommand((s) => s.setName('clear').setDescription('Clear tracking cache')),

    // /shipments — shipments overview
    new SlashCommandBuilder()
        .setName('shipments')
        .setDescription('Shipments overview')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s.setName('list').setDescription('List all recent shipments'))
        .addSubcommand((s) => s.setName('status').setDescription('Status summary'))
        .addSubcommand((s) => s.setName('ready').setDescription('Shipments ready to send')),

    // /refund — process a Stripe refund
    new SlashCommandBuilder()
        .setName('refund')
        .setDescription('Refund a Stripe checkout session')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s
            .setName('full')
            .setDescription('Full refund of a session')
            .addStringOption((o) => o.setName('session').setDescription('Stripe checkout session id').setRequired(true)))
        .addSubcommand((s) => s
            .setName('partial')
            .setDescription('Partial refund of a session')
            .addStringOption((o) => o.setName('session').setDescription('Stripe checkout session id').setRequired(true))
            .addIntegerOption((o) => o.setName('amount').setDescription('Refund amount in cents').setRequired(true).setMinValue(1))),

    // /waive — waive shipping fee for a buyer
    new SlashCommandBuilder()
        .setName('waive')
        .setDescription('Waive shipping fee for a buyer')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addUserOption((o) => o.setName('user').setDescription('Buyer to waive shipping for').setRequired(true)),

    // /snapshot — capture state
    new SlashCommandBuilder()
        .setName('snapshot')
        .setDescription('Snapshot bot state')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption((o) => o.setName('action').setDescription('Optional action (e.g. save, restore)')),

    // /capture — capture stream moments
    new SlashCommandBuilder()
        .setName('capture')
        .setDescription('Capture a stream moment')
        .setDefaultMemberPermissions(ADMIN_ONLY),

    // /nous — bot self-management
    new SlashCommandBuilder()
        .setName('nous')
        .setDescription('Bot self-management')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption((o) => o.setName('action').setDescription('Action to perform')),

    // /shipping — shipping admin
    new SlashCommandBuilder()
        .setName('shipping')
        .setDescription('Shipping admin')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption((o) => o.setName('args').setDescription('Action + args')),

    // /shipping-audit — audit shipping coverage
    new SlashCommandBuilder()
        .setName('shipping-audit')
        .setDescription('Audit shipping coverage / payments')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption((o) => o.setName('args').setDescription('Optional args')),

    // /intl — international shipping
    new SlashCommandBuilder()
        .setName('intl')
        .setDescription('International shipping admin')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s.setName('show').setDescription('Show current intl-flagged buyers'))
        .addSubcommand((s) => s.setName('list').setDescription('List intl buyers')),

    // /intl-ship — auto-DM intl buyers shipping difference
    new SlashCommandBuilder()
        .setName('intl-ship')
        .setDescription('Auto-DM intl buyers about shipping difference')
        .setDefaultMemberPermissions(ADMIN_ONLY),

    // /dropped-off — mark batch dropped off at carrier
    new SlashCommandBuilder()
        .setName('dropped-off')
        .setDescription('Mark batch dropped off at carrier')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addBooleanOption((o) => o.setName('intl').setDescription('International batch')),

    // /requests — list card requests
    new SlashCommandBuilder()
        .setName('requests')
        .setDescription('List card requests')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption((o) => o.setName('mode').setDescription('Filter mode')
            .addChoices(
                { name: 'pending (default)', value: 'pending' },
                { name: 'all', value: 'all' },
                { name: 'recent', value: 'recent' },
            )),

    // /request — act on a single request
    new SlashCommandBuilder()
        .setName('request')
        .setDescription('Act on a single card request')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption((o) => o.setName('action').setDescription('Action')
            .setRequired(true)
            .addChoices(
                { name: 'next', value: 'next' },
                { name: 'shown', value: 'shown' },
                { name: 'skip', value: 'skip' },
            ))
        .addIntegerOption((o) => o.setName('id').setDescription('Request id (for shown/skip)')),

    // /sell — list a card for sale
    new SlashCommandBuilder()
        .setName('sell')
        .setDescription('List a card for sale')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption((o) => o.setName('args').setDescription('Card details (depends on legacy syntax)').setRequired(true)),

    // /list — list-session lifecycle
    new SlashCommandBuilder()
        .setName('list')
        .setDescription('List-session lifecycle')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addSubcommand((s) => s.setName('open').setDescription('Open a list session')
            .addStringOption((o) => o.setName('args').setDescription('Session details')))
        .addSubcommand((s) => s.setName('add').setDescription('Add a card to active list session')
            .addStringOption((o) => o.setName('args').setDescription('Card details').setRequired(true)))
        .addSubcommand((s) => s.setName('close').setDescription('Close active list session')),

    // /sold — mark a listing sold
    new SlashCommandBuilder()
        .setName('sold')
        .setDescription('Mark a listing as sold')
        .setDefaultMemberPermissions(ADMIN_ONLY)
        .addStringOption((o) => o.setName('args').setDescription('Listing id + buyer details').setRequired(true)),
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
