/**
 * Activity Feed event helpers.
 *
 * Wraps `broadcast()` from queue-broadcaster.js with one named function per
 * event kind so producer call sites (battle, coupon, pull, community goals,
 * stripe webhook) stay one-liners and the display strings live in one place.
 *
 * Every event is a display-ready envelope shaped like a Discord embed:
 *   { kind, title, description, color, icon, timestamp, meta }
 *
 * The itzenzo.tv ActivityFeed component renders the envelope verbatim — no
 * extra derivation needed for these (unlike entry.* events, which the feed
 * derives from queue entity data).
 */

import { broadcast } from './queue-broadcaster.js';

const COLORS = {
    pack_battle: 'amber',
    pull_box:    'sky',
    coupon:      'rose',
    goal:        'violet',
    stock:       'red',
};

function envelope(kind, title, description, color, icon, meta = {}) {
    return {
        kind,
        title,
        description,
        color,
        icon,
        timestamp: new Date().toISOString(),
        meta,
    };
}

function safeBroadcast(event, payload) {
    try {
        broadcast(event, payload);
    } catch (e) {
        console.error(`activity broadcast failed (${event}):`, e.message);
    }
}

// =========================================================================
// Pack battles
// =========================================================================

export function broadcastBattleEntry(buyerHandle, paid, max, battleName) {
    safeBroadcast('activity.battle.entry', envelope(
        'battle.entry',
        'Pack battle entry',
        `${buyerHandle} entered ${battleName} (${paid}/${max})`,
        COLORS.pack_battle,
        '⚔️',
        { paid, max, battleName },
    ));
}

export function broadcastBattleFull(battleName, max) {
    safeBroadcast('activity.battle.full', envelope(
        'battle.full',
        'Pack battle full',
        `${battleName} is full — ${max}/${max} entries.`,
        COLORS.pack_battle,
        '⚔️',
        { battleName, max },
    ));
}

export function broadcastBattleWinner(winnerHandle, battleName) {
    safeBroadcast('activity.battle.winner', envelope(
        'battle.winner',
        'Pack battle winner',
        `${winnerHandle} won ${battleName}!`,
        COLORS.pack_battle,
        '🏆',
        { winnerHandle, battleName },
    ));
}

// =========================================================================
// Pull boxes (lifecycle — claims come from WP via /webhooks/activity-changed)
// =========================================================================

export function broadcastPullBoxOpened(box) {
    safeBroadcast('activity.pull_box.opened', envelope(
        'pull_box.opened',
        'Pull box opened',
        `${box.name} opened (${box.totalSlots} slots, $${(box.priceCents / 100).toFixed(2)} ${box.tier})`,
        COLORS.pull_box,
        '🎰',
        { boxId: box.id, name: box.name, tier: box.tier, totalSlots: box.totalSlots },
    ));
}

export function broadcastPullBoxReplenished(box, addedSlots, newTotal) {
    safeBroadcast('activity.pull_box.replenished', envelope(
        'pull_box.replenished',
        'Pull box replenished',
        `${box.name} +${addedSlots} slots (${newTotal} total)`,
        COLORS.pull_box,
        '🎰',
        { boxId: box.id, name: box.name, addedSlots, totalSlots: newTotal },
    ));
}

export function broadcastPullBoxClosed(box) {
    safeBroadcast('activity.pull_box.closed', envelope(
        'pull_box.closed',
        'Pull box closed',
        `${box.name} closed.`,
        COLORS.pull_box,
        '🎰',
        { boxId: box.id, name: box.name, tier: box.tier },
    ));
}

// =========================================================================
// Coupons
// =========================================================================

export function broadcastCouponDrop(code, description) {
    safeBroadcast('activity.coupon.drop', envelope(
        'coupon.drop',
        'Coupon drop',
        description ? `${code} — ${description}` : code,
        COLORS.coupon,
        '🎟️',
        { code },
    ));
}

// =========================================================================
// Community goals
// =========================================================================

export function broadcastGoalCycleHit(cycle) {
    safeBroadcast('activity.goal.cycle_hit', envelope(
        'goal.cycle_hit',
        'Restock goal hit',
        `Cycle ${cycle} restock funded — new product unlocks.`,
        COLORS.goal,
        '🎯',
        { cycle },
    ));
}

export function broadcastGoalMilestone(milestoneCents) {
    const milestoneDollars = (milestoneCents / 100).toLocaleString('en-US');
    safeBroadcast('activity.goal.milestone', envelope(
        'goal.milestone',
        'Lifetime milestone',
        `$${milestoneDollars} lifetime — free loot for the community!`,
        COLORS.goal,
        '🎯',
        { milestoneCents },
    ));
}

// =========================================================================
// Stock alerts
// =========================================================================

export function broadcastLowStock(productName, stockRemaining) {
    safeBroadcast('activity.stock.low', envelope(
        'stock.low',
        'Low stock',
        `${productName} — ${stockRemaining} left.`,
        COLORS.stock,
        '⚠️',
        { productName, stockRemaining },
    ));
}

export function broadcastSoldOut(productName) {
    safeBroadcast('activity.stock.sold_out', envelope(
        'stock.sold_out',
        'Sold out',
        `${productName} is sold out.`,
        COLORS.stock,
        '🚫',
        { productName },
    ));
}
