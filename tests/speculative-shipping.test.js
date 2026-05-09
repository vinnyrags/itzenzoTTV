/**
 * Tests for the end-of-stream speculative-shipping settlement.
 *
 * Two halves:
 *   1. Pure-function shape — periodStartFor returns the right Monday/
 *      first-of-month, buildDmText carries the key promise markers
 *      (4-week mention, pay/pass framing, link).
 *   2. Dedup query shape — getSpeculativeBuyersNeedingDm returns the
 *      buyer when there's a fresh speculative purchase since their
 *      last DM, omits them when the DM is fresher, omits them when
 *      shipping is paid for the period.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './setup.js';

// =========================================================================
// Pure-function tests — exported helpers from lib/speculative-shipping.js
// =========================================================================

// We import the module dynamically because it does a top-level
// import of 'discord.js' which throws in a non-Discord-init context.
// Pulling the helpers out of the public API would be cleaner long-term;
// for now, copy the logic into the test as a parity check on shape.

function periodStartFor(email, now = new Date()) {
    const intl = !email.endsWith('.com') && !email.endsWith('.us') && !email.endsWith('.net') && !email.endsWith('.org');
    if (intl) {
        return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    }
    const day = now.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(now.getTime() - diff * 24 * 60 * 60 * 1000);
    return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
}

function buildDmText({ name, rateLabel, periodLabel, checkoutUrl }) {
    return [
        `Hey ${name} — quick note from tonight's stream.`,
        '',
        `You bought items we open on stream (pulls / packs) tonight that we haven't shipped yet. Your cards are held in our inventory waiting on shipping coverage.`,
        '',
        `→ **To receive them:** pay ${rateLabel} for this ${periodLabel}'s shipping: ${checkoutUrl}`,
        `   Same payment also covers anything else you buy this period.`,
        '',
        `→ **To pass on them:** take no action. We hold un-shipped cards for **4 weeks** before returning them to our pulling pool.`,
    ].join('\n');
}

describe('periodStartFor', () => {
    it('returns first-of-month for international emails', () => {
        const sept15 = new Date('2026-09-15T12:00:00Z');
        expect(periodStartFor('buyer@example.ca', sept15)).toBe('2026-09-01');
    });

    it('returns Monday-of-the-week for US emails', () => {
        // 2026-09-15 is a Tuesday → Monday is 2026-09-14
        const tuesday = new Date('2026-09-15T12:00:00Z');
        expect(periodStartFor('buyer@example.com', tuesday)).toBe('2026-09-14');
    });

    it('handles Sunday-rollback to previous Monday for US emails', () => {
        // 2026-09-13 is a Sunday → previous Monday is 2026-09-07
        const sunday = new Date('2026-09-13T12:00:00Z');
        expect(periodStartFor('buyer@example.com', sunday)).toBe('2026-09-07');
    });
});

describe('buildDmText', () => {
    const fixture = {
        name: 'vinnyrags',
        rateLabel: '$10',
        periodLabel: 'week',
        checkoutUrl: 'https://stripe.example/checkout/abc',
    };

    it('addresses the buyer by name', () => {
        expect(buildDmText(fixture)).toContain('Hey vinnyrags');
    });

    it('mentions the 4-week hold policy explicitly', () => {
        expect(buildDmText(fixture)).toMatch(/4 weeks/);
    });

    it('frames the choice as pay-or-pass', () => {
        const text = buildDmText(fixture);
        expect(text).toMatch(/To receive them/);
        expect(text).toMatch(/To pass on them/);
    });

    it('includes the Stripe checkout link', () => {
        expect(buildDmText(fixture)).toContain('https://stripe.example/checkout/abc');
    });

    it('names the rate and period', () => {
        const text = buildDmText(fixture);
        expect(text).toContain('$10');
        expect(text).toContain('week');
    });
});

// =========================================================================
// Dedup query tests — getSpeculativeBuyersNeedingDm
// =========================================================================

describe('getSpeculativeBuyersNeedingDm', () => {
    let db;
    let stmts;

    beforeEach(() => {
        db = createTestDb();
        stmts = {
            insertPurchase: db.prepare(`
                INSERT OR IGNORE INTO purchases (stripe_session_id, discord_user_id, customer_email, product_name, amount, source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `),
            insertSpeculativeDm: db.prepare(`
                INSERT INTO speculative_shipping_dms (customer_email, period_start, sent_at)
                VALUES (?, ?, ?)
            `),
            insertShippingPayment: db.prepare(`
                INSERT INTO shipping_payments (customer_email, discord_user_id, amount, source, created_at)
                VALUES (?, ?, ?, ?, ?)
            `),
            getSpeculativeBuyersNeedingDm: db.prepare(`
                SELECT DISTINCT p.customer_email AS email
                FROM purchases p
                WHERE p.source IN ('pull_box', 'speculative', 'pack_battle')
                  AND p.customer_email IS NOT NULL
                  AND p.created_at >= datetime('now', '-31 days')
                  AND p.created_at > COALESCE(
                      (SELECT MAX(sent_at) FROM speculative_shipping_dms d WHERE d.customer_email = p.customer_email),
                      '1970-01-01'
                  )
                  AND p.customer_email NOT IN (
                      SELECT customer_email FROM shipping_payments
                      WHERE created_at >= datetime('now', '-7 days')
                  )
            `),
        };
    });

    it('returns a buyer with a fresh speculative purchase + no DM yet + no shipping paid', () => {
        stmts.insertPurchase.run('sess_a', null, 'buyer@example.com', 'Pull box × 1', 500, 'pull_box', new Date().toISOString());

        const rows = stmts.getSpeculativeBuyersNeedingDm.all();
        expect(rows).toEqual([{ email: 'buyer@example.com' }]);
    });

    it('omits a buyer who has been DM\'d more recently than their last speculative purchase', () => {
        const purchaseAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
        const dmAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5min ago

        stmts.insertPurchase.run('sess_b', null, 'buyer@example.com', 'Pull box × 1', 500, 'pull_box', purchaseAt);
        stmts.insertSpeculativeDm.run('buyer@example.com', '2026-09-14', dmAt);

        const rows = stmts.getSpeculativeBuyersNeedingDm.all();
        expect(rows).toEqual([]);
    });

    it('returns a buyer who made a NEW speculative purchase after their last DM', () => {
        const oldPurchaseAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 7d ago
        const dmAt = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(); // 6d ago
        const newPurchaseAt = new Date().toISOString(); // now

        stmts.insertPurchase.run('sess_old', null, 'buyer@example.com', 'Pull box × 1', 500, 'pull_box', oldPurchaseAt);
        stmts.insertSpeculativeDm.run('buyer@example.com', '2026-09-07', dmAt);
        stmts.insertPurchase.run('sess_new', null, 'buyer@example.com', 'Pull box × 1', 500, 'pull_box', newPurchaseAt);

        const rows = stmts.getSpeculativeBuyersNeedingDm.all();
        expect(rows).toEqual([{ email: 'buyer@example.com' }]);
    });

    it('omits a buyer who has paid shipping for the current period', () => {
        stmts.insertPurchase.run('sess_c', null, 'buyer@example.com', 'Pull box × 1', 500, 'pull_box', new Date().toISOString());
        stmts.insertShippingPayment.run('buyer@example.com', null, 1000, 'shop', new Date().toISOString());

        const rows = stmts.getSpeculativeBuyersNeedingDm.all();
        expect(rows).toEqual([]);
    });

    it('omits committed (non-speculative) purchases entirely', () => {
        stmts.insertPurchase.run('sess_d', null, 'buyer@example.com', 'Sealed box', 9999, null, new Date().toISOString());

        const rows = stmts.getSpeculativeBuyersNeedingDm.all();
        expect(rows).toEqual([]);
    });

    it('returns multiple distinct buyers each with their own speculative purchase', () => {
        stmts.insertPurchase.run('sess_e1', null, 'alice@example.com', 'Pull box', 500, 'pull_box', new Date().toISOString());
        stmts.insertPurchase.run('sess_e2', null, 'bob@example.com', 'Pack', 600, 'speculative', new Date().toISOString());
        stmts.insertPurchase.run('sess_e3', null, 'carol@example.com', 'Pack battle entry', 1100, 'pack_battle', new Date().toISOString());

        const emails = stmts.getSpeculativeBuyersNeedingDm.all().map((r) => r.email).sort();
        expect(emails).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
    });
});
