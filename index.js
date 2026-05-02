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
import { handleLive, handleOffline } from './commands/live.js';
import { handleBattle } from './commands/battle.js';
import { handleQueue, handleDuckRace } from './commands/queue.js';
import { handleLink } from './commands/link.js';
import { handleSell, handleList, handleSold } from './commands/card-shop.js';
import { handleShipping } from './commands/shipping.js';
import { handleHype } from './commands/hype.js';
import { handleDroppedOff } from './commands/dropped-off.js';
import { handleSnapshot } from './commands/snapshot.js';
import { handleGiveaway, initGiveaways } from './commands/giveaway.js';
import { handleSync } from './commands/sync.js';
import { handleCoupon } from './commands/coupon.js';
import { handleIntl, handleIntlShip } from './commands/intl.js';
import { handleShippingAudit } from './commands/shipping-audit.js';
import { handleWaive } from './commands/waive.js';
import { handleRefund } from './commands/refund.js';
import { handleNous } from './commands/nous.js';
import { handlePull } from './commands/pull.js';
import { handleReset } from './commands/reset.js';
import { handleSpin } from './commands/spin.js';
import { handleCapture } from './commands/capture.js';
import { handleTracking } from './commands/tracking.js';
import { handleShipments } from './commands/shipments.js';
import { syncBotCommands } from './sync-bot-commands.js';
import { initCommunityGoals } from './community-goals.js';
import { initWelcome } from './commands/welcome.js';
import { initMinecraftChannel, handleMinecraftReaction } from './commands/minecraft.js';
import { initLfgChannel } from './commands/lfg.js';
import { handleRequests, handleRequest } from './commands/card-requests.js';
const PREFIX = '!';

// =========================================================================
// Message handler — route commands
// =========================================================================

client.on('messageCreate', async (message) => {
    // Ignore own messages (prevent self-loops) and DMs
    if (message.author.id === client.user.id) return;
    if (!message.guild) return;

    // Only respond to messages with the prefix
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    try {
        switch (command) {
            case 'live':
                await handleLive(message);
                break;
            case 'offline':
                await handleOffline(message);
                break;
            case 'battle':
                await handleBattle(message, args);
                break;
            case 'queue':
                await handleQueue(message, args);
                break;
            case 'duckrace':
                await handleDuckRace(message, args);
                break;
            case 'link':
                await handleLink(message, args);
                break;
            case 'sell':
                await handleSell(message, args);
                break;
            case 'list':
                await handleList(message, args);
                break;
            case 'sold':
                await handleSold(message, args);
                break;
            case 'shipping':
                await handleShipping(message, args);
                break;
            case 'hype':
                await handleHype(message, args);
                break;
            case 'dropped-off':
                await handleDroppedOff(message, args);
                break;
            case 'snapshot':
                await handleSnapshot(message, args);
                break;
            case 'giveaway':
                await handleGiveaway(message, args);
                break;
            case 'spin':
                await handleSpin(message, args);
                break;
            case 'capture':
                await handleCapture(message, args);
                break;
            case 'sync':
                await handleSync(message, args);
                break;
            case 'coupon':
                await handleCoupon(message, args);
                break;
            case 'intl':
                await handleIntl(message, args);
                break;
            case 'intl-ship':
                await handleIntlShip(message);
                break;
            case 'shipping-audit':
                await handleShippingAudit(message, args);
                break;
            case 'waive':
                await handleWaive(message, args);
                break;
            case 'refund':
                await handleRefund(message, args);
                break;
            case 'nous':
                await handleNous(message, args);
                break;
            case 'pull':
                await handlePull(message, args);
                break;
            case 'reset':
                await handleReset(message);
                break;
            case 'tracking':
                await handleTracking(message, args);
                break;
            case 'shipments':
                await handleShipments(message, args);
                break;
            case 'ship-status':
                await handleShipments(message, ['status', ...args]);
                break;
            case 'requests':
                await handleRequests(message, args);
                break;
            case 'request':
                await handleRequest(message, args);
                break;
            default:
                // Unknown command — silently ignore
                break;
        }
    } catch (e) {
        console.error(`Error handling command !${command}:`, e.message);
        try {
            await message.reply('Something went wrong. Try again or ping a mod.');
        } catch { /* can't reply */ }
    }
});

// =========================================================================
// Button interaction handler — identity-aware checkouts
// =========================================================================

client.on('interactionCreate', async (interaction) => {
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
