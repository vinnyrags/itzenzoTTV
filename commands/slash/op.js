/**
 * /op — universal dispatcher slash command.
 *
 * `/op queue close` runs the existing handleQueue() with args=['close'].
 * `/op battle start "Product Name" 20` parses tokens (quoted strings preserved).
 *
 * Handlers that don't yet have a native /<command> slash command go through
 * here. Once a native version ships, the dispatcher route is removed.
 *
 * Auth: the slash command itself is restricted via Discord permissions
 * (Akivili-only), but we double-check the role here for defense in depth.
 */

import config from '../../config.js';
import { buildSyntheticMessage } from '../../lib/synthetic-message.js';

import { handleLive, handleOffline } from '../live.js';
import { handleBattle } from '../battle.js';
import { handleQueue, handleDuckRace } from '../queue.js';
import { handleLink } from '../link.js';
import { handleSell, handleList, handleSold } from '../card-shop.js';
import { handleShipping } from '../shipping.js';
import { handleHype } from '../hype.js';
import { handleDroppedOff } from '../dropped-off.js';
import { handleSnapshot } from '../snapshot.js';
import { handleGiveaway } from '../giveaway.js';
import { handleSpin } from '../spin.js';
import { handleCapture } from '../capture.js';
import { handleSync } from '../sync.js';
import { handleCoupon } from '../coupon.js';
import { handleIntl, handleIntlShip } from '../intl.js';
import { handleShippingAudit } from '../shipping-audit.js';
import { handleWaive } from '../waive.js';
import { handleRefund } from '../refund.js';
import { handleNous } from '../nous.js';
import { handlePull } from '../pull.js';
import { handleTracking } from '../tracking.js';
import { handleShipments } from '../shipments.js';
import { handleRequests, handleRequest } from '../card-requests.js';

// Map of command name → handler. Anything in this map is dispatchable
// from /op. Native slash commands that supersede an entry here should
// have the entry removed once the migration is done.
const ROUTES = {
    live: (msg) => handleLive(msg),
    offline: (msg) => handleOffline(msg),
    battle: handleBattle,
    duckrace: handleDuckRace,
    link: handleLink,
    sell: handleSell,
    list: handleList,
    sold: handleSold,
    shipping: handleShipping,
    hype: handleHype,
    'dropped-off': handleDroppedOff,
    snapshot: handleSnapshot,
    giveaway: handleGiveaway,
    spin: handleSpin,
    capture: handleCapture,
    sync: handleSync,
    coupon: handleCoupon,
    intl: handleIntl,
    'intl-ship': (msg) => handleIntlShip(msg),
    'shipping-audit': handleShippingAudit,
    waive: handleWaive,
    refund: handleRefund,
    nous: handleNous,
    pull: handlePull,
    tracking: handleTracking,
    shipments: handleShipments,
    'ship-status': (msg, args) => handleShipments(msg, ['status', ...(args || [])]),
    requests: handleRequests,
    request: handleRequest,
};

// Quoted-string-aware token splitter. `start "Hello World" 20` →
// ['start', 'Hello World', '20'].
export function tokenize(raw) {
    if (!raw) return [];
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        tokens.push(m[1] ?? m[2] ?? m[3]);
    }
    return tokens;
}

export async function handleOp(interaction) {
    if (!interaction.member?.roles?.cache?.has(config.ROLES.AKIVILI)) {
        return interaction.reply({ content: 'Only Akivili can run ops commands.', ephemeral: true });
    }

    const raw = interaction.options.getString('command', true).trim();
    const [command, ...args] = tokenize(raw);

    if (!command) {
        return interaction.reply({
            content: `Usage: \`/op <command> [args...]\`\n\nAvailable: ${Object.keys(ROUTES).sort().join(', ')}`,
            ephemeral: true,
        });
    }

    const handler = ROUTES[command];
    if (!handler) {
        return interaction.reply({
            content: `Unknown command: \`${command}\`. Available: ${Object.keys(ROUTES).sort().join(', ')}`,
            ephemeral: true,
        });
    }

    // Defer immediately — many handlers take >3s, and Discord requires a
    // reply within 3s of an interaction or it errors. Ephemeral so only
    // the operator sees the confirmation.
    await interaction.deferReply({ ephemeral: true });

    const message = buildSyntheticMessage(interaction);
    try {
        await handler(message, args);
        // If the handler didn't follow up with anything, give the operator
        // a confirmation so the ephemeral spinner doesn't sit forever.
        if (!interaction.replied) {
            await interaction.followUp({ content: `✓ \`/op ${command}\` finished. Check the relevant channel for the result embed.`, ephemeral: true });
        }
        return `dispatched ${command} with [${args.join(', ')}]`;
    } catch (e) {
        await interaction.followUp({ content: `✗ \`/op ${command}\` failed: ${e.message}`, ephemeral: true });
        throw e;
    }
}

export const ROUTE_NAMES = Object.keys(ROUTES);
