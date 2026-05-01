/**
 * Webhook idempotency — TC6 regression coverage.
 *
 * Two layers tested here in isolation (full-server tests live elsewhere):
 *
 *   1. Stripe event-id dedup table (`processed_stripe_events`): the express
 *      handler INSERT OR IGNORE's the event.id and short-circuits on retry
 *      so a duplicate delivery never re-runs phase-1.
 *
 *   2. Purchase-count gating: incrementPurchaseCount fires only when at
 *      least one INSERT OR IGNORE on `purchases` actually inserted a new
 *      row. Without this, a Stripe retry promotes the buyer ahead of
 *      schedule (Xipe at 1+, Long at 5+).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, buildStmts } from './setup.js';

let db, stmts;

beforeEach(() => {
    db = createTestDb();
    stmts = buildStmts(db);
});

// =========================================================================
// Layer 1: event-id dedup table
// =========================================================================

describe('processed_stripe_events dedup', () => {
    it('first attempt to claim an event id succeeds', () => {
        const result = db.prepare('INSERT OR IGNORE INTO processed_stripe_events (event_id) VALUES (?)').run('evt_xyz');
        expect(result.changes).toBe(1);
    });

    it('second attempt to claim the same event id is a no-op', () => {
        db.prepare('INSERT OR IGNORE INTO processed_stripe_events (event_id) VALUES (?)').run('evt_dup');
        const second = db.prepare('INSERT OR IGNORE INTO processed_stripe_events (event_id) VALUES (?)').run('evt_dup');
        expect(second.changes).toBe(0);
    });

    it('only one row exists after two claim attempts on the same event id', () => {
        db.prepare('INSERT OR IGNORE INTO processed_stripe_events (event_id) VALUES (?)').run('evt_dup_2');
        db.prepare('INSERT OR IGNORE INTO processed_stripe_events (event_id) VALUES (?)').run('evt_dup_2');
        const count = db.prepare('SELECT COUNT(*) as c FROM processed_stripe_events WHERE event_id = ?').get('evt_dup_2').c;
        expect(count).toBe(1);
    });
});

// =========================================================================
// Layer 2: purchase count only ticks on actual insert
// =========================================================================

describe('purchase-count gating on actual insert', () => {
    it('first delivery: insertPurchase reports changes=1, increment ticks', () => {
        const result = stmts.purchases.insertPurchase.run('cs_one', 'd1', 'b@x.com', 'Box', 1000);
        expect(result.changes).toBe(1);

        // The webhook now gates `incrementPurchaseCount` on changes > 0
        if (result.changes > 0) {
            stmts.purchases.incrementPurchaseCount.run('d1');
        }
        const row = stmts.purchases.getPurchaseCount.get('d1');
        expect(row.total_purchases).toBe(1);
    });

    it('retry: insertPurchase reports changes=0, increment skipped', () => {
        // First delivery
        stmts.purchases.insertPurchase.run('cs_retry', 'd2', 'b@x.com', 'Box', 1000);
        stmts.purchases.incrementPurchaseCount.run('d2');

        // Retry of the same session — INSERT OR IGNORE returns changes=0
        const retry = stmts.purchases.insertPurchase.run('cs_retry', 'd2', 'b@x.com', 'Box', 1000);
        expect(retry.changes).toBe(0);

        // Webhook gating: skip incrementPurchaseCount when changes === 0
        if (retry.changes > 0) {
            stmts.purchases.incrementPurchaseCount.run('d2');
        }

        const row = stmts.purchases.getPurchaseCount.get('d2');
        expect(row.total_purchases).toBe(1); // not 2!
    });

    it('multi-line order: count ticks once for the whole order, not per line', () => {
        // Simulates webhook handling 3 line items in one session
        let actuallyInserted = 0;
        for (const item of ['A', 'B', 'C']) {
            const r = stmts.purchases.insertPurchase.run('cs_multi', 'd3', 'b@x.com', item, 100);
            actuallyInserted += r.changes;
        }
        // First line inserts (changes=1), subsequent two are IGNORE'd (changes=0)
        // because UNIQUE(stripe_session_id) — actuallyInserted = 1.
        // Without the multi-line gating, this would be 0 increments. With
        // the gating, it's 1 increment per multi-line order.
        if (actuallyInserted > 0) {
            stmts.purchases.incrementPurchaseCount.run('d3');
        }

        const row = stmts.purchases.getPurchaseCount.get('d3');
        expect(row.total_purchases).toBe(1);
    });

    it('threshold guarantee: 4 retries on a single purchase do not promote past Xipe', () => {
        // Simulate four duplicate deliveries of the same session
        for (let i = 0; i < 4; i++) {
            const r = stmts.purchases.insertPurchase.run('cs_threshold', 'd4', 'b@x.com', 'Box', 1000);
            if (r.changes > 0) {
                stmts.purchases.incrementPurchaseCount.run('d4');
            }
        }
        const row = stmts.purchases.getPurchaseCount.get('d4');
        expect(row.total_purchases).toBe(1);
        // Without the gate this would be 4 → buyer prematurely promoted to Long (5+).
    });
});
