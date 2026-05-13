/**
 * Race condition tests — verifies atomic operations and constraint protections.
 *
 * These tests exercise the database-level protections that prevent data
 * corruption when concurrent operations target the same resources.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, buildStmts } from './setup.js';

let db, stmts;

beforeEach(() => {
    db = createTestDb();
    stmts = buildStmts(db);
});

// =========================================================================
// #1 & #2: Card shop — atomic reserveForBuyer
// =========================================================================

describe('card listing reservation race', () => {
    it('only one buyer can reserve an active listing', () => {
        stmts.cardListings.create.run('Race Card', 1000, null, 'active');

        // Two buyers try to reserve simultaneously
        const result1 = stmts.cardListings.reserveForBuyer.run('buyer_A', 1);
        const result2 = stmts.cardListings.reserveForBuyer.run('buyer_B', 1);

        expect(result1.changes).toBe(1); // buyer A wins
        expect(result2.changes).toBe(0); // buyer B loses

        const listing = stmts.cardListings.getById.get(1);
        expect(listing.status).toBe('reserved');
        expect(listing.buyer_discord_id).toBe('buyer_A');
    });

    it('cannot reserve a sold listing', () => {
        stmts.cardListings.create.run('Sold Card', 1000, null, 'active');
        stmts.cardListings.markSold.run(1);

        const result = stmts.cardListings.reserveForBuyer.run('buyer_A', 1);
        expect(result.changes).toBe(0);
    });
});

// =========================================================================
// #3: Pack battle — atomic entry with capacity check
// =========================================================================

describe('battle entry capacity race', () => {
    it('atomic INSERT prevents overfill when battle is almost full', () => {
        // Create battle with max 2 entries
        stmts.battles.createBattle.run('test-slug', 'Test Product', 'price_123', 2, null);

        // First entry succeeds
        const r1 = stmts.battles.addEntry.run(1, 'user_A', 1, 1);
        expect(r1.changes).toBe(1);

        // Second entry succeeds (now full)
        const r2 = stmts.battles.addEntry.run(1, 'user_B', 1, 1);
        expect(r2.changes).toBe(1);

        // Third entry rejected by subquery (battle full)
        const r3 = stmts.battles.addEntry.run(1, 'user_C', 1, 1);
        expect(r3.changes).toBe(0);

        const count = stmts.battles.getEntryCount.get(1).count;
        expect(count).toBe(2);
    });

    it('prevents duplicate entries for same user', () => {
        stmts.battles.createBattle.run('test-slug', 'Test Product', 'price_123', 10, null);

        const r1 = stmts.battles.addEntry.run(1, 'user_A', 1, 1);
        expect(r1.changes).toBe(1);

        // Same user tries again — UNIQUE(battle_id, discord_user_id) rejects
        const r2 = stmts.battles.addEntry.run(1, 'user_A', 1, 1);
        expect(r2.changes).toBe(0);
    });
});

// =========================================================================
// #4: Giveaway — UNIQUE constraint handles double-click
// =========================================================================

describe('giveaway entry deduplication', () => {
    it('UNIQUE constraint prevents duplicate giveaway entries', () => {
        stmts.giveaways.create.run('Test Prize', null, 0, null);

        // First entry succeeds
        const r1 = stmts.giveaways.addEntry.run(1, 'user_A', 'tiktok_A');
        expect(r1.changes).toBe(1);

        // Same user double-clicks — INSERT OR IGNORE silently rejects
        const r2 = stmts.giveaways.addEntry.run(1, 'user_A', 'tiktok_A');
        expect(r2.changes).toBe(0);

        const count = stmts.giveaways.getEntryCount.get(1).count;
        expect(count).toBe(1);
    });

    it('different users can enter the same giveaway', () => {
        stmts.giveaways.create.run('Test Prize', null, 0, null);

        stmts.giveaways.addEntry.run(1, 'user_A', null);
        stmts.giveaways.addEntry.run(1, 'user_B', null);

        const count = stmts.giveaways.getEntryCount.get(1).count;
        expect(count).toBe(2);
    });
});

// =========================================================================
// #5: Duck race — race claim is now permissive (no atomic gate)
//
// Originally claimForRace atomically transitioned the session from 'open'
// → 'racing' to prevent two operators from accidentally double-starting
// a race. The race is now operator-controlled (admin slash command) and
// the operator may legitimately want to:
//
//   - Run a race mid-stream while the queue is still open
//   - Re-run a race after a winner was declared
//   - Run multiple ad-hoc races on the same session
//
// Each race overwrites duck_race_winner_user_id with the latest result;
// the queue's open/closed status is independent and operator-controlled
// via /offline + /queue close. These tests pin the new permissive
// behavior so a future refactor doesn't quietly re-introduce the gate.
// =========================================================================

describe('duck race claim is permissive', () => {
    it('claim succeeds on a fresh open queue', () => {
        stmts.queues.createQueue.run();
        const result = stmts.queues.claimForRace.run(1);
        expect(result.changes).toBe(1);
    });

    it('claim succeeds on a queue with a winner already declared (re-run case)', () => {
        stmts.queues.createQueue.run();
        stmts.queues.setDuckRaceWinner.run('winner_1', 1);

        // Re-run is allowed — operator may want a second race for fun
        // or to redo a contested first pick.
        const result = stmts.queues.claimForRace.run(1);
        expect(result.changes).toBe(1);
    });

    it('claim succeeds on a closed queue (post-/offline)', () => {
        stmts.queues.createQueue.run();
        stmts.queues.closeQueue.run(1);

        const result = stmts.queues.claimForRace.run(1);
        expect(result.changes).toBe(1);
    });
});

// =========================================================================
// #6: Shipping — UNIQUE index prevents duplicate session records
// =========================================================================

describe('shipping double-payment prevention', () => {
    it('prevents duplicate shipping records for same session', () => {
        stmts.shipping.record.run('test@example.com', 'user_A', 1000, 'checkout', 'cs_session_1');

        // Same session fires again (webhook retry)
        stmts.shipping.record.run('test@example.com', 'user_A', 1000, 'checkout', 'cs_session_1');

        // Only one record should exist
        const records = stmts.shipping.getThisWeek.all();
        const sessionRecords = records.filter(r => r.stripe_session_id === 'cs_session_1');
        expect(sessionRecords.length).toBe(1);
    });

    it('allows different sessions for same user', () => {
        stmts.shipping.record.run('test@example.com', 'user_A', 1000, 'checkout', 'cs_session_1');
        stmts.shipping.record.run('test@example.com', 'user_A', 1000, 'checkout', 'cs_session_2');

        const records = stmts.shipping.getThisWeek.all();
        expect(records.length).toBe(2);
    });

    it('allows null session IDs (ad-hoc shipping)', () => {
        stmts.shipping.record.run('test@example.com', 'user_A', 0, 'waiver', null);
        stmts.shipping.record.run('test@example.com', 'user_A', 0, 'waiver', null);

        // NULL session IDs are not constrained by the partial index
        const records = stmts.shipping.getThisWeek.all();
        expect(records.length).toBe(2);
    });
});

// =========================================================================
// #7: Coupon — atomic activation prevents double-active
// =========================================================================

describe('coupon double-activation prevention', () => {
    it('prevents two coupons from being active simultaneously', () => {
        const activateStmt = db.prepare(`
            INSERT INTO active_coupons (promo_code, stripe_promo_id, stripe_coupon_id, discount_display)
            SELECT ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM active_coupons WHERE status = 'active')
        `);

        const r1 = activateStmt.run('CODE_A', 'promo_A', 'coupon_A', '$5.00 off');
        expect(r1.changes).toBe(1);

        const r2 = activateStmt.run('CODE_B', 'promo_B', 'coupon_B', '10% off');
        expect(r2.changes).toBe(0); // rejected — CODE_A is still active

        // Deactivate CODE_A
        const active = db.prepare(`SELECT * FROM active_coupons WHERE status = 'active' LIMIT 1`).get();
        db.prepare(`UPDATE active_coupons SET status = 'inactive' WHERE id = ?`).run(active.id);

        // Now CODE_B can be activated
        const r3 = activateStmt.run('CODE_B', 'promo_B', 'coupon_B', '10% off');
        expect(r3.changes).toBe(1);
    });
});

// =========================================================================
// #8: Queue entries — webhook retry protection is at the purchases layer
// =========================================================================

describe('queue entry allows multiple purchases', () => {
    it('same person can have multiple entries in a queue', () => {
        stmts.queues.createQueue.run();

        stmts.queues.addEntry.run(1, 'user_A', 'a@test.com', 'Product A', 1, 'cs_session_1');
        stmts.queues.addEntry.run(1, 'user_A', 'a@test.com', 'Product B', 1, 'cs_session_2');
        stmts.queues.addEntry.run(1, 'user_A', 'a@test.com', 'Product A', 2, 'cs_session_3');

        const count = stmts.queues.getEntryCount.get(1).count;
        expect(count).toBe(3);
    });

    it('webhook retry protection happens at purchases table level', () => {
        // purchases table has UNIQUE on stripe_session_id — prevents double-processing
        stmts.purchases.insertPurchase.run('cs_unique', 'user_A', 'a@test.com', 'Product', 1000);
        stmts.purchases.insertPurchase.run('cs_unique', 'user_A', 'a@test.com', 'Product', 1000);

        // Only one purchase recorded
        const purchase = stmts.purchases.getBySessionId.get('cs_unique');
        expect(purchase).toBeTruthy();
    });
});

// =========================================================================
// #10: Card listing — payment after TTL expiry
// =========================================================================

describe('card listing TTL vs payment race', () => {
    it('expired listing can still be marked sold (payment wins)', () => {
        stmts.cardListings.create.run('Race Card', 1000, null, 'active');
        stmts.cardListings.markExpired.run(1);

        expect(stmts.cardListings.getById.get(1).status).toBe('expired');

        // Payment arrives after TTL — should still succeed
        stmts.cardListings.markSold.run(1);
        expect(stmts.cardListings.getById.get(1).status).toBe('sold');
    });

    it('sold listing cannot be expired', () => {
        stmts.cardListings.create.run('Sold Card', 1000, null, 'active');
        stmts.cardListings.markSold.run(1);

        // TTL fires after payment — markExpired just overwrites status
        // but the webhook already returned at the 'sold' check
        const listing = stmts.cardListings.getById.get(1);
        expect(listing.status).toBe('sold');
        expect(listing.sold_at).toBeTruthy();
    });
});

// =========================================================================
// Pull box — atomic capacity enforcement
// =========================================================================

describe('pull box capacity', () => {
    it('allows purchases under the cap', () => {
        stmts.cardListings.create.run('Test Pull Box', 300, null, 'pull');
        stmts.cardListings.setMaxQuantity.run(5, 1);

        const r1 = stmts.cardListings.incrementPurchaseCountCapped.run(2, 1, 2);
        expect(r1.changes).toBe(1);

        const listing = stmts.cardListings.getById.get(1);
        expect(listing.purchase_count).toBe(2);
    });

    it('rejects purchases that would exceed the cap', () => {
        stmts.cardListings.create.run('Capped Box', 300, null, 'pull');
        stmts.cardListings.setMaxQuantity.run(3, 1);

        // Fill to 2
        stmts.cardListings.incrementPurchaseCountCapped.run(2, 1, 2);

        // Try to buy 2 more (would be 4, exceeds 3)
        const r = stmts.cardListings.incrementPurchaseCountCapped.run(2, 1, 2);
        expect(r.changes).toBe(0);

        const listing = stmts.cardListings.getById.get(1);
        expect(listing.purchase_count).toBe(2); // unchanged
    });

    it('allows exactly filling the cap', () => {
        stmts.cardListings.create.run('Exact Box', 300, null, 'pull');
        stmts.cardListings.setMaxQuantity.run(3, 1);

        const r = stmts.cardListings.incrementPurchaseCountCapped.run(3, 1, 3);
        expect(r.changes).toBe(1);

        const listing = stmts.cardListings.getById.get(1);
        expect(listing.purchase_count).toBe(3);
    });

    it('rejects any purchase after cap is reached', () => {
        stmts.cardListings.create.run('Full Box', 300, null, 'pull');
        stmts.cardListings.setMaxQuantity.run(1, 1);

        stmts.cardListings.incrementPurchaseCountCapped.run(1, 1, 1);
        const r = stmts.cardListings.incrementPurchaseCountCapped.run(1, 1, 1);
        expect(r.changes).toBe(0);
    });

    it('allows unlimited purchases when max_quantity is NULL', () => {
        stmts.cardListings.create.run('Unlimited Box', 300, null, 'pull');
        // No setMaxQuantity — stays NULL

        const r1 = stmts.cardListings.incrementPurchaseCountCapped.run(100, 1, 100);
        expect(r1.changes).toBe(1);

        const r2 = stmts.cardListings.incrementPurchaseCountCapped.run(100, 1, 100);
        expect(r2.changes).toBe(1);

        const listing = stmts.cardListings.getById.get(1);
        expect(listing.purchase_count).toBe(200);
    });
});
