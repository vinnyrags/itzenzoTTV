/**
 * Tests for lib/activity-broadcaster.js — the helpers each Discord
 * producer (battle, coupon, pull, community goals, stripe) calls to
 * push display-ready envelopes onto the SSE stream.
 *
 * The broadcaster itself is covered by queue-broadcaster.test.js — these
 * tests assert the envelope shape per kind so the homepage doesn't get
 * mis-labeled or mis-colored events.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../lib/queue-broadcaster.js', () => ({
    broadcast: vi.fn(),
}));

import { broadcast } from '../lib/queue-broadcaster.js';
import {
    broadcastBattleEntry,
    broadcastBattleFull,
    broadcastBattleWinner,
    broadcastPullBoxOpened,
    broadcastPullBoxReplenished,
    broadcastPullBoxClosed,
    broadcastCouponDrop,
    broadcastGoalCycleHit,
    broadcastGoalMilestone,
    broadcastLowStock,
    broadcastSoldOut,
} from '../lib/activity-broadcaster.js';

beforeEach(() => {
    broadcast.mockClear();
});

function lastCall() {
    expect(broadcast).toHaveBeenCalledTimes(1);
    return broadcast.mock.calls[0];
}

describe('battle helpers', () => {
    it('broadcastBattleEntry uses activity.battle.entry with paid/max', () => {
        broadcastBattleEntry('<@123>', 3, 8, 'Prismatic Box');
        const [event, payload] = lastCall();
        expect(event).toBe('activity.battle.entry');
        expect(payload.kind).toBe('battle.entry');
        expect(payload.description).toBe('<@123> entered Prismatic Box (3/8)');
        expect(payload.color).toBe('amber');
        expect(payload.icon).toBe('⚔️');
        expect(payload.meta).toMatchObject({ paid: 3, max: 8, battleName: 'Prismatic Box' });
    });

    it('broadcastBattleFull fires activity.battle.full', () => {
        broadcastBattleFull('Box', 8);
        const [event, payload] = lastCall();
        expect(event).toBe('activity.battle.full');
        expect(payload.description).toBe('Box is full — 8/8 entries.');
    });

    it('broadcastBattleWinner fires activity.battle.winner', () => {
        broadcastBattleWinner('<@9>', 'Box');
        const [event, payload] = lastCall();
        expect(event).toBe('activity.battle.winner');
        expect(payload.icon).toBe('🏆');
    });
});

describe('pull box helpers', () => {
    const box = { id: 4, name: 'V Box', tier: 'v', priceCents: 100, totalSlots: 100 };

    it('broadcastPullBoxOpened formats the price/slots line', () => {
        broadcastPullBoxOpened(box);
        const [event, payload] = lastCall();
        expect(event).toBe('activity.pull_box.opened');
        expect(payload.description).toBe('V Box opened (100 slots, $1.00 v)');
        expect(payload.meta).toMatchObject({ boxId: 4, name: 'V Box', tier: 'v', totalSlots: 100 });
    });

    it('broadcastPullBoxReplenished uses the new total, not the old', () => {
        broadcastPullBoxReplenished({ ...box, totalSlots: 100 }, 50, 150);
        const [event, payload] = lastCall();
        expect(event).toBe('activity.pull_box.replenished');
        expect(payload.description).toBe('V Box +50 slots (150 total)');
        expect(payload.meta.totalSlots).toBe(150);
    });

    it('broadcastPullBoxClosed fires activity.pull_box.closed', () => {
        broadcastPullBoxClosed(box);
        const [event, payload] = lastCall();
        expect(event).toBe('activity.pull_box.closed');
        expect(payload.description).toBe('V Box closed.');
    });
});

describe('coupon helpers', () => {
    it('broadcastCouponDrop includes the discount string when present', () => {
        broadcastCouponDrop('SAVE10', '10% off');
        const [event, payload] = lastCall();
        expect(event).toBe('activity.coupon.drop');
        expect(payload.description).toBe('SAVE10 — 10% off');
        expect(payload.color).toBe('rose');
    });

    it('falls back to bare code when description is empty', () => {
        broadcastCouponDrop('FREESHIP', '');
        const [, payload] = lastCall();
        expect(payload.description).toBe('FREESHIP');
    });
});

describe('community goal helpers', () => {
    it('broadcastGoalCycleHit references the cycle number', () => {
        broadcastGoalCycleHit(7);
        const [event, payload] = lastCall();
        expect(event).toBe('activity.goal.cycle_hit');
        expect(payload.description).toContain('Cycle 7');
    });

    it('broadcastGoalMilestone formats dollars from cents', () => {
        broadcastGoalMilestone(500_000); // $5,000
        const [event, payload] = lastCall();
        expect(event).toBe('activity.goal.milestone');
        expect(payload.description).toContain('$5,000');
        expect(payload.meta.milestoneCents).toBe(500_000);
    });
});

describe('stock helpers', () => {
    it('broadcastLowStock includes the count', () => {
        broadcastLowStock('Booster Box', 2);
        const [event, payload] = lastCall();
        expect(event).toBe('activity.stock.low');
        expect(payload.description).toBe('Booster Box — 2 left.');
    });

    it('broadcastSoldOut fires activity.stock.sold_out', () => {
        broadcastSoldOut('Pack');
        const [event, payload] = lastCall();
        expect(event).toBe('activity.stock.sold_out');
        expect(payload.icon).toBe('🚫');
    });
});

describe('envelope shape', () => {
    it('every envelope carries a timestamp', () => {
        broadcastSoldOut('X');
        const [, payload] = lastCall();
        expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('safeBroadcast catches downstream throws', () => {
        broadcast.mockImplementationOnce(() => { throw new Error('broken pipe'); });
        // Should not throw — producer fires & forgets.
        expect(() => broadcastSoldOut('X')).not.toThrow();
    });
});
