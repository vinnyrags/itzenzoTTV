/**
 * Phase C — native slash command bindings for the remaining mid/low
 * frequency commands. Uses defineSlashCommand() factory so each
 * command is a small declarative spec.
 *
 * For commands with subcommands, the factory pattern wraps a single
 * dispatch shape: argsBuilder reads interaction.options.getSubcommand()
 * + relevant options, returns args[] for handleX(message, args).
 */

import { defineSlashCommand } from './factory.js';
import { handleSell, handleList, handleSold } from '../card-shop.js';
import { handlePull } from '../pull.js';
import { handleGiveaway } from '../giveaway.js';
import { handleDroppedOff } from '../dropped-off.js';
import { handleSnapshot } from '../snapshot.js';
import { handleCapture } from '../capture.js';
import { handleCoupon } from '../coupon.js';
import { handleIntl, handleIntlShip } from '../intl.js';
import { handleShippingAudit } from '../shipping-audit.js';
import { handleWaive } from '../waive.js';
import { handleRefund } from '../refund.js';
import { handleNous } from '../nous.js';
import { handleTracking } from '../tracking.js';
import { handleShipments } from '../shipments.js';
import { handleRequests, handleRequest } from '../card-requests.js';
import { handleShipping } from '../shipping.js';
import { handleLink } from '../link.js';

// /link is user-facing — buyers self-link their email to their Discord ID.
// Akivili check OFF so anyone can use it.
export const handleLinkSlash = defineSlashCommand({
    name: 'link',
    handler: handleLink,
    akiviliOnly: false,
    argsBuilder: (i) => [i.options.getString('email', true)],
});

// /pull — subcommands: open, close, replenish, status
export const handlePullSlash = defineSlashCommand({
    name: 'pull',
    handler: handlePull,
    argsBuilder: (i) => {
        const sub = i.options.getSubcommand();
        const extra = i.options.getString('args');
        return extra ? [sub, ...extra.split(/\s+/)] : [sub];
    },
});

// /giveaway — subcommands: start, close, cancel, status, test, clean, off
export const handleGiveawaySlash = defineSlashCommand({
    name: 'giveaway',
    handler: handleGiveaway,
    argsBuilder: (i) => {
        const sub = i.options.getSubcommand();
        const extra = i.options.getString('args');
        return extra ? [sub, ...extra.split(/\s+/)] : [sub];
    },
});

// /coupon — subcommands: create amount:<int>, off, status
export const handleCouponSlash = defineSlashCommand({
    name: 'coupon',
    handler: handleCoupon,
    argsBuilder: (i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'create') {
            const amount = i.options.getInteger('amount', true);
            return ['create', String(amount)];
        }
        return [sub];
    },
});

// /tracking — subcommands: lookup ref:<string>, list, clear
export const handleTrackingSlash = defineSlashCommand({
    name: 'tracking',
    handler: handleTracking,
    argsBuilder: (i) => {
        const sub = i.options.getSubcommand();
        if (sub === 'lookup') {
            return [i.options.getString('reference', true)];
        }
        return [sub];
    },
});

// /shipments — subcommands: list (default), status, ready
export const handleShipmentsSlash = defineSlashCommand({
    name: 'shipments',
    handler: handleShipments,
    argsBuilder: (i) => {
        const sub = i.options.getSubcommand(false) || 'list';
        return sub === 'list' ? [] : [sub];
    },
});

// /refund — subcommands: full session:<string>, partial session:<string> amount:<int>
export const handleRefundSlash = defineSlashCommand({
    name: 'refund',
    handler: handleRefund,
    argsBuilder: (i) => {
        const sub = i.options.getSubcommand();
        const session = i.options.getString('session', true);
        if (sub === 'partial') {
            const amount = i.options.getInteger('amount', true);
            return ['session', session, String(amount)];
        }
        return ['session', session];
    },
});

// /waive — single user mention (waives shipping for that buyer)
export const handleWaiveSlash = defineSlashCommand({
    name: 'waive',
    handler: handleWaive,
    userOption: 'user',
    argsBuilder: () => [],
});

// /snapshot — capture current state (free-form args)
export const handleSnapshotSlash = defineSlashCommand({
    name: 'snapshot',
    handler: handleSnapshot,
    argsBuilder: (i) => {
        const action = i.options.getString('action');
        return action ? action.split(/\s+/) : [];
    },
});

// /capture — capture moments (no args)
export const handleCaptureSlash = defineSlashCommand({
    name: 'capture',
    handler: handleCapture,
    argsBuilder: () => [],
});

// /nous — bot self-management (free-form args)
export const handleNousSlash = defineSlashCommand({
    name: 'nous',
    handler: handleNous,
    argsBuilder: (i) => {
        const action = i.options.getString('action');
        return action ? action.split(/\s+/) : [];
    },
});

// /shipping — shipping admin (free-form args)
export const handleShippingAdminSlash = defineSlashCommand({
    name: 'shipping',
    handler: handleShipping,
    argsBuilder: (i) => {
        const args = i.options.getString('args');
        return args ? args.split(/\s+/) : [];
    },
});

// /shipping-audit — audit shipping coverage
export const handleShippingAuditSlash = defineSlashCommand({
    name: 'shipping-audit',
    handler: handleShippingAudit,
    argsBuilder: (i) => {
        const args = i.options.getString('args');
        return args ? args.split(/\s+/) : [];
    },
});

// /intl — international shipping (subcommand: list, default = current intl status)
export const handleIntlSlash = defineSlashCommand({
    name: 'intl',
    handler: handleIntl,
    argsBuilder: (i) => {
        const sub = i.options.getSubcommand(false);
        return sub ? [sub] : [];
    },
});

// /intl-ship — auto-DM intl buyers about shipping difference
export const handleIntlShipSlash = defineSlashCommand({
    name: 'intl-ship',
    handler: (msg) => handleIntlShip(msg),
    argsBuilder: () => [],
});

// /dropped-off — mark batch dropped off
export const handleDroppedOffSlash = defineSlashCommand({
    name: 'dropped-off',
    handler: handleDroppedOff,
    argsBuilder: (i) => {
        const intl = i.options.getBoolean('intl');
        return intl ? ['intl'] : [];
    },
});

// /requests — list card requests (mode: pending, all, recent)
export const handleRequestsSlash = defineSlashCommand({
    name: 'requests',
    handler: handleRequests,
    argsBuilder: (i) => {
        const mode = i.options.getString('mode') || 'pending';
        return [mode];
    },
});

// /request — act on a single request: next, shown, skip
export const handleRequestSlash = defineSlashCommand({
    name: 'request',
    handler: handleRequest,
    argsBuilder: (i) => {
        const action = i.options.getString('action', true);
        const id = i.options.getInteger('id');
        return id ? [action, String(id)] : [action];
    },
});

// /sell — list a card for sale
export const handleSellSlash = defineSlashCommand({
    name: 'sell',
    handler: handleSell,
    argsBuilder: (i) => {
        const args = i.options.getString('args', true);
        return args.split(/\s+/);
    },
});

// /list — list-session lifecycle (open, add, close)
export const handleListSlash = defineSlashCommand({
    name: 'list',
    handler: handleList,
    argsBuilder: (i) => {
        const sub = i.options.getSubcommand();
        const extra = i.options.getString('args');
        return extra ? [sub, ...extra.split(/\s+/)] : [sub];
    },
});

// /sold — mark a listing as sold
export const handleSoldSlash = defineSlashCommand({
    name: 'sold',
    handler: handleSold,
    argsBuilder: (i) => {
        const args = i.options.getString('args', true);
        return args.split(/\s+/);
    },
});
