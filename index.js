/**
 * Nous — Discord bot for itzenzo.tv.
 *
 * Features:
 *  - Order notifications (Stripe → #order-feed)
 *  - Low-stock alerts (Stripe → #deals)
 *  - Going-live / stream-ended (Twitch → #announcements)
 *  - Livestream mode (!live / !offline — master switches for stream sessions)
 *  - Pack battle system (!battle commands + Stripe payment verification)
 *  - Queue system (!queue open/close + auto-entries from Stripe purchases)
 *  - Duck race (!duckrace — one entry per unique buyer in queue)
 *  - Account linking (auto via Stripe metadata, manual via #welcome Link Account button)
 *  - Role promotion (Xipe at 1+ purchases, Long at 5+)
 *  - New product alerts (POST /alerts/products → #deals)
 *  - Duck race winner closes queue, opens next for pre-orders
 *  - Real-time queue embed updated in #queue
 *  - Shipping notifications (!dropped-off → DMs buyers, posts to #order-feed + #ops)
 *  - Analytics (!snapshot → on-demand snapshots, auto stream recaps on !offline)
 *  - Giveaway system (!giveaway — reaction-based entries, social funnel, duck race draw)
 *  - Product sync (!sync — Sheets → Stripe → WordPress pipeline)
 *  - Coupons (!coupon — create, activate, deactivate promo codes for Stripe checkout)
 *
 * Usage:
 *   node bot/index.js
 *   npm start (from bot/ directory)
 */

import config from './config.js';
import { client } from './discord.js';
import { startServer } from './server.js';
import { initGiveaways } from './commands/giveaway.js';
import { syncBotCommands } from './sync-bot-commands.js';
import { initCommunityGoals } from './community-goals.js';
import { initWelcome } from './commands/welcome.js';
import { initMinecraftChannel, handleMinecraftReaction } from './commands/minecraft.js';
import { initLfgChannel } from './commands/lfg.js';
// =========================================================================
// Legacy !command text dispatcher removed 2026-05-03 — all ops commands
// run as Discord slash commands now (see SLASH_HANDLERS below). Clean
// state: never went live with the legacy path post-cutover.
// =========================================================================

// =========================================================================
// Slash command dispatcher
// =========================================================================

import { handleOp } from './commands/slash/op.js';
import { handleQueueSlash } from './commands/slash/queue.js';
import { handleResetSlash } from './commands/slash/reset.js';
import { handleLiveSlash, handleOfflineSlash } from './commands/slash/live.js';
import { handleSyncSlash } from './commands/slash/sync.js';
import { handleHypeSlash } from './commands/slash/hype.js';
import { handleBattleSlash } from './commands/slash/battle.js';
import { handleDuckRaceSlash } from './commands/slash/duckrace.js';
import { handleSpinSlash } from './commands/slash/spin.js';
import {
    handleLinkSlash,
    handlePullSlash,
    handleGiveawaySlash,
    handleCouponSlash,
    handleTrackingSlash,
    handleShipmentsSlash,
    handleRefundSlash,
    handleWaiveSlash,
    handleSnapshotSlash,
    handleCaptureSlash,
    handleNousSlash,
    handleShippingAdminSlash,
    handleShippingAuditSlash,
    handleIntlSlash,
    handleIntlShipSlash,
    handleDroppedOffSlash,
    handleRequestsSlash,
    handleRequestSlash,
    handleSellSlash,
    handleListSlash,
    handleSoldSlash,
} from './commands/slash/phase-c.js';
import { withAudit } from './lib/op-audit.js';

const SLASH_HANDLERS = {
    // Phase A
    op: withAudit('op', handleOp),
    queue: withAudit('queue', handleQueueSlash),
    reset: withAudit('reset', handleResetSlash),
    // Phase B (high-frequency native)
    live: withAudit('live', handleLiveSlash),
    offline: withAudit('offline', handleOfflineSlash),
    sync: withAudit('sync', handleSyncSlash),
    hype: withAudit('hype', handleHypeSlash),
    battle: withAudit('battle', handleBattleSlash),
    duckrace: withAudit('duckrace', handleDuckRaceSlash),
    spin: withAudit('spin', handleSpinSlash),
    // Phase C (mid/low-frequency native)
    link: withAudit('link', handleLinkSlash),
    pull: withAudit('pull', handlePullSlash),
    giveaway: withAudit('giveaway', handleGiveawaySlash),
    coupon: withAudit('coupon', handleCouponSlash),
    tracking: withAudit('tracking', handleTrackingSlash),
    shipments: withAudit('shipments', handleShipmentsSlash),
    refund: withAudit('refund', handleRefundSlash),
    waive: withAudit('waive', handleWaiveSlash),
    snapshot: withAudit('snapshot', handleSnapshotSlash),
    capture: withAudit('capture', handleCaptureSlash),
    nous: withAudit('nous', handleNousSlash),
    shipping: withAudit('shipping', handleShippingAdminSlash),
    'shipping-audit': withAudit('shipping-audit', handleShippingAuditSlash),
    intl: withAudit('intl', handleIntlSlash),
    'intl-ship': withAudit('intl-ship', handleIntlShipSlash),
    'dropped-off': withAudit('dropped-off', handleDroppedOffSlash),
    requests: withAudit('requests', handleRequestsSlash),
    request: withAudit('request', handleRequestSlash),
    sell: withAudit('sell', handleSellSlash),
    list: withAudit('list', handleListSlash),
    sold: withAudit('sold', handleSoldSlash),
};

// =========================================================================
// Interaction handler — slash commands, buttons, modals, selects
// =========================================================================

client.on('interactionCreate', async (interaction) => {
    // Slash commands first (chat input)
    if (interaction.isChatInputCommand()) {
        const handler = SLASH_HANDLERS[interaction.commandName];
        if (!handler) {
            return interaction.reply({ content: `No handler for /${interaction.commandName}`, ephemeral: true });
        }
        try {
            await handler(interaction);
        } catch (e) {
            console.error(`Error handling /${interaction.commandName}:`, e.message);
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: `Failed: ${e.message}`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `Failed: ${e.message}`, ephemeral: true });
                }
            } catch { /* can't reply */ }
        }
        return;
    }

    if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isStringSelectMenu()) return;

    try {
        const { handleButtonInteraction, handleModalSubmit, handleSelectMenuInteraction } = await import('./commands/interactions.js');

        if (interaction.isButton()) {
            await handleButtonInteraction(interaction);
        } else if (interaction.isStringSelectMenu()) {
            await handleSelectMenuInteraction(interaction);
        } else if (interaction.isModalSubmit()) {
            await handleModalSubmit(interaction);
        }
    } catch (e) {
        console.error('Error handling interaction:', e.message);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'Something went wrong. Try again or ping a mod.', ephemeral: true });
            }
        } catch { /* can't reply */ }
    }
});

// =========================================================================
// Reaction handler — Minecraft react-for-DM invites
// =========================================================================

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) {
        try { await reaction.fetch(); } catch { return; }
    }
    if (user.partial) {
        try { await user.fetch(); } catch { return; }
    }

    try {
        await handleMinecraftReaction(reaction, user);
    } catch (e) {
        console.error('Error handling messageReactionAdd:', e.message);
    }
});

// =========================================================================
// Ready
// =========================================================================

client.once('ready', async () => {
    console.log(`Nous online as ${client.user.tag}`);
    console.log(`Guilds: ${client.guilds.cache.map((g) => g.name).join(', ')}`);

    // Start webhook server
    startServer();

    // Sync #bot-commands reference
    await syncBotCommands();

    // Initialize community goals pinned message
    await initCommunityGoals();

    // Initialize welcome embed in #welcome
    await initWelcome();

    // Initialize the persistent #minecraft react-for-DM embed
    await initMinecraftChannel();

    // Initialize the persistent #looking-for-group overview embed
    await initLfgChannel();

    // Initialize giveaways (close expired, schedule active timers)
    initGiveaways();
});

// =========================================================================
// Error handling
// =========================================================================

client.on('error', (e) => console.error('Discord client error:', e.message));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

// =========================================================================
// Login
// =========================================================================

client.login(config.DISCORD_BOT_TOKEN);
