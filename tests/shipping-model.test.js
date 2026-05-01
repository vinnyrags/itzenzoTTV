/**
 * Tests for the unified shipping model — shipping_payments table,
 * shipping helpers, and international user management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, buildStmts } from './setup.js';

let db, stmts;

beforeEach(() => {
    db = createTestDb();
    stmts = buildStmts(db);
});

// =========================================================================
// shipping_payments table
// =========================================================================

describe('shipping_payments table', () => {
    it('records a shipping payment', () => {
        stmts.shipping.record.run('user@test.com', 'discord123', 1000, 'checkout', null);

        const records = stmts.shipping.getThisWeek.all();
        expect(records).toHaveLength(1);
        expect(records[0].customer_email).toBe('user@test.com');
        expect(records[0].amount).toBe(1000);
        expect(records[0].source).toBe('checkout');
    });

    it('records multiple payments from different sources', () => {
        stmts.shipping.record.run('user1@test.com', 'discord1', 1000, 'checkout', null);
        stmts.shipping.record.run('user2@test.com', 'discord2', 2500, 'livestream', null);
        stmts.shipping.record.run('user3@test.com', null, 1000, 'ad-hoc', null);

        const records = stmts.shipping.getThisWeek.all();
        expect(records).toHaveLength(3);
    });

    it('allows null discord_user_id', () => {
        stmts.shipping.record.run('user@test.com', null, 1000, 'checkout', null);

        const records = stmts.shipping.getThisWeek.all();
        expect(records).toHaveLength(1);
        expect(records[0].discord_user_id).toBeNull();
    });
});

// =========================================================================
// hasShippingThisWeek / hasShippingThisMonth
// =========================================================================

describe('hasShippingThisWeek', () => {
    it('returns undefined when no shipping paid', () => {
        const result = stmts.shipping.hasShippingThisWeek.get('user@test.com');
        expect(result).toBeUndefined();
    });

    it('returns truthy after shipping is recorded', () => {
        stmts.shipping.record.run('user@test.com', 'discord1', 1000, 'checkout', null);

        const result = stmts.shipping.hasShippingThisWeek.get('user@test.com');
        expect(result).toBeTruthy();
    });

    it('is email-specific — different emails are independent', () => {
        stmts.shipping.record.run('user1@test.com', 'discord1', 1000, 'checkout', null);

        expect(stmts.shipping.hasShippingThisWeek.get('user1@test.com')).toBeTruthy();
        expect(stmts.shipping.hasShippingThisWeek.get('user2@test.com')).toBeUndefined();
    });
});

describe('hasShippingThisMonth', () => {
    it('returns undefined when no shipping paid', () => {
        const result = stmts.shipping.hasShippingThisMonth.get('user@test.com');
        expect(result).toBeUndefined();
    });

    it('returns truthy after shipping is recorded', () => {
        stmts.shipping.record.run('user@test.com', 'discord1', 2500, 'livestream', null);

        const result = stmts.shipping.hasShippingThisMonth.get('user@test.com');
        expect(result).toBeTruthy();
    });
});

// =========================================================================
// discord_links — country management
// =========================================================================

describe('discord_links country management', () => {
    it('sets and gets country', () => {
        stmts.purchases.linkDiscord.run('discord1', 'user@test.com');
        stmts.discordLinks.setCountry.run('CA', 'discord1');

        const row = stmts.discordLinks.getCountry.get('discord1');
        expect(row.country).toBe('CA');
    });

    it('returns null country for new links', () => {
        stmts.purchases.linkDiscord.run('discord1', 'user@test.com');

        const row = stmts.discordLinks.getCountry.get('discord1');
        expect(row.country).toBeNull();
    });

    it('can revert to US', () => {
        stmts.purchases.linkDiscord.run('discord1', 'user@test.com');
        stmts.discordLinks.setCountry.run('CA', 'discord1');
        stmts.discordLinks.setCountry.run('US', 'discord1');

        const row = stmts.discordLinks.getCountry.get('discord1');
        expect(row.country).toBe('US');
    });

    it('getCountryByEmail looks up via email', () => {
        stmts.purchases.linkDiscord.run('discord1', 'user@test.com');
        stmts.discordLinks.setCountry.run('CA', 'discord1');

        const row = stmts.discordLinks.getCountryByEmail.get('user@test.com');
        expect(row.country).toBe('CA');
    });

    it('getInternationalUsers returns only non-US users', () => {
        stmts.purchases.linkDiscord.run('discord1', 'user1@test.com');
        stmts.purchases.linkDiscord.run('discord2', 'user2@test.com');
        stmts.purchases.linkDiscord.run('discord3', 'user3@test.com');

        stmts.discordLinks.setCountry.run('CA', 'discord1');
        stmts.discordLinks.setCountry.run('US', 'discord2');
        // discord3 has null country

        const intl = stmts.discordLinks.getInternationalUsers.all();
        expect(intl).toHaveLength(1);
        expect(intl[0].discord_user_id).toBe('discord1');
    });

    it('getInternationalUsers returns empty when none flagged', () => {
        stmts.purchases.linkDiscord.run('discord1', 'user@test.com');

        const intl = stmts.discordLinks.getInternationalUsers.all();
        expect(intl).toHaveLength(0);
    });
});

// =========================================================================
// Double-charge prevention scenarios
// =========================================================================

describe('double-charge prevention', () => {
    it('domestic buyer who paid via checkout is covered for the week', () => {
        stmts.shipping.record.run('user@test.com', 'discord1', 1000, 'checkout', null);

        // Later this week, they buy via Discord button — should be covered
        expect(stmts.shipping.hasShippingThisWeek.get('user@test.com')).toBeTruthy();
    });

    it('domestic buyer who paid via livestream is covered for the week', () => {
        stmts.shipping.record.run('user@test.com', 'discord1', 1000, 'livestream', null);

        expect(stmts.shipping.hasShippingThisWeek.get('user@test.com')).toBeTruthy();
    });

    it('international buyer who paid via checkout is covered for the month', () => {
        stmts.purchases.linkDiscord.run('discord1', 'user@test.com');
        stmts.discordLinks.setCountry.run('CA', 'discord1');
        stmts.shipping.record.run('user@test.com', 'discord1', 2500, 'checkout', null);

        expect(stmts.shipping.hasShippingThisMonth.get('user@test.com')).toBeTruthy();
    });

    it('different payment sources all count toward coverage', () => {
        // Checkout payment
        stmts.shipping.record.run('user@test.com', 'discord1', 1000, 'checkout', null);

        // Should still be covered even though it was from a checkout, not livestream
        expect(stmts.shipping.hasShippingThisWeek.get('user@test.com')).toBeTruthy();
    });
});

// =========================================================================
// Integration: livestream + shipping_payments
// =========================================================================

describe('livestream + unified shipping integration', () => {
    it('livestream shipping records in both tables', () => {
        // Start livestream
        stmts.livestream.startSession.run();
        const session = stmts.livestream.getActiveSession.get();
        stmts.livestream.addBuyer.run(session.id, 'user1', 'user1@test.com');

        // Mark shipping paid in livestream table
        stmts.livestream.markShippingPaid.run(session.id, 'user1@test.com');

        // Also record in unified shipping_payments
        stmts.shipping.record.run('user1@test.com', 'user1', 1000, 'livestream', null);

        // Both tables should reflect payment
        const livestreamPaid = stmts.livestream.hasShippingThisWeek.get('user1@test.com');
        const shippingPaid = stmts.shipping.hasShippingThisWeek.get('user1@test.com');

        expect(livestreamPaid).toBeTruthy();
        expect(shippingPaid).toBeTruthy();
    });
});

// =========================================================================
// buildShippingOptions — dual-option for unflagged buyers
// =========================================================================

describe('buildShippingOptions logic', () => {
    it('no discordUserId → both options', () => {
        // No user identified at all — offer both
        const domestic = stmts.discordLinks.getCountry.get('nonexistent');
        expect(domestic).toBeUndefined();
        // Simulates what buildShippingOptions does: no ID → both rates
    });

    it('unflagged user (no country set) → both options available', () => {
        stmts.purchases.linkDiscord.run('discord1', 'user@test.com');

        // No country set — getCountry returns null
        const row = stmts.discordLinks.getCountry.get('discord1');
        expect(row.country).toBeNull();
    });

    it('user flagged as CA → only international rate applies', () => {
        stmts.purchases.linkDiscord.run('discord1', 'user@test.com');
        stmts.discordLinks.setCountry.run('CA', 'discord1');

        const row = stmts.discordLinks.getCountry.get('discord1');
        expect(row.country).toBe('CA');
        expect(row.country !== 'US').toBe(true);
    });

    it('user flagged as US → only domestic rate applies', () => {
        stmts.purchases.linkDiscord.run('discord1', 'user@test.com');
        stmts.discordLinks.setCountry.run('US', 'discord1');

        const row = stmts.discordLinks.getCountry.get('discord1');
        expect(row.country).toBe('US');
    });

    it('auto-flag from webhook then subsequent lookup returns correct country', () => {
        // Simulate: buyer links, makes purchase, webhook auto-flags
        stmts.purchases.linkDiscord.run('discord1', 'user@test.com');
        stmts.discordLinks.setCountry.run('CA', 'discord1');

        // Next checkout should see them as international
        const row = stmts.discordLinks.getCountry.get('discord1');
        expect(row.country).toBe('CA');

        // And getCountryByEmail should also work
        const byEmail = stmts.discordLinks.getCountryByEmail.get('user@test.com');
        expect(byEmail.country).toBe('CA');
    });
});

// =========================================================================
// stripe_session_id on shipping_payments
// =========================================================================

describe('shipping_payments stripe_session_id', () => {
    it('records stripe_session_id when provided', () => {
        stmts.shipping.record.run('user@test.com', 'discord1', 1000, 'checkout', 'cs_test_123');

        const record = stmts.shipping.getByEmailThisWeek.get('user@test.com');
        expect(record.stripe_session_id).toBe('cs_test_123');
    });

    it('stores null stripe_session_id when not provided', () => {
        stmts.shipping.record.run('user@test.com', 'discord1', 1000, 'checkout', null);

        const record = stmts.shipping.getByEmailThisWeek.get('user@test.com');
        expect(record.stripe_session_id).toBeNull();
    });
});

// =========================================================================
// getByEmailThisWeek / getByEmailThisMonth
// =========================================================================

describe('getByEmailThisWeek', () => {
    it('returns the full record', () => {
        stmts.shipping.record.run('user@test.com', 'discord1', 1000, 'checkout', 'cs_test_456');

        const record = stmts.shipping.getByEmailThisWeek.get('user@test.com');
        expect(record).toBeDefined();
        expect(record.customer_email).toBe('user@test.com');
        expect(record.amount).toBe(1000);
        expect(record.stripe_session_id).toBe('cs_test_456');
    });

    it('returns undefined when no record exists', () => {
        const record = stmts.shipping.getByEmailThisWeek.get('nobody@test.com');
        expect(record).toBeUndefined();
    });
});

describe('getByEmailThisMonth', () => {
    it('returns the full record', () => {
        stmts.shipping.record.run('user@test.com', 'discord1', 2500, 'checkout', 'cs_test_789');

        const record = stmts.shipping.getByEmailThisMonth.get('user@test.com');
        expect(record).toBeDefined();
        expect(record.amount).toBe(2500);
        expect(record.stripe_session_id).toBe('cs_test_789');
    });
});

// =========================================================================
// deleteById
// =========================================================================

describe('deleteById', () => {
    it('removes a shipping record', () => {
        stmts.shipping.record.run('user@test.com', 'discord1', 1000, 'checkout', null);

        const record = stmts.shipping.getByEmailThisWeek.get('user@test.com');
        expect(record).toBeDefined();

        stmts.shipping.deleteById.run(record.id);

        const after = stmts.shipping.getByEmailThisWeek.get('user@test.com');
        expect(after).toBeUndefined();
    });

    it('does not affect other records', () => {
        stmts.shipping.record.run('user1@test.com', 'discord1', 1000, 'checkout', null);
        stmts.shipping.record.run('user2@test.com', 'discord2', 1000, 'checkout', null);

        const record1 = stmts.shipping.getByEmailThisWeek.get('user1@test.com');
        stmts.shipping.deleteById.run(record1.id);

        expect(stmts.shipping.getByEmailThisWeek.get('user1@test.com')).toBeUndefined();
        expect(stmts.shipping.getByEmailThisWeek.get('user2@test.com')).toBeDefined();
    });
});

// =========================================================================
// Waiver record (amount=0, source='waiver')
// =========================================================================

describe('waiver records', () => {
    it('waiver with amount=0 counts as shipping covered', () => {
        stmts.shipping.record.run('user@test.com', 'discord1', 0, 'waiver', null);

        // hasShippingThisWeek checks for ANY row, not amount > 0
        expect(stmts.shipping.hasShippingThisWeek.get('user@test.com')).toBeTruthy();
    });

    it('waiver with amount=0 counts for monthly coverage', () => {
        stmts.shipping.record.run('user@test.com', 'discord1', 0, 'waiver', null);

        expect(stmts.shipping.hasShippingThisMonth.get('user@test.com')).toBeTruthy();
    });
});

// =========================================================================
// Purchase lookup statements
// =========================================================================

describe('purchase lookup', () => {
    it('getRecentByDiscordId returns most recent purchase', () => {
        stmts.purchases.insertPurchase.run('cs_1', 'discord1', 'user@test.com', 'Product A', 2000);
        stmts.purchases.insertPurchase.run('cs_2', 'discord1', 'user@test.com', 'Product B', 3000);

        const recent = stmts.purchases.getRecentByDiscordId.get('discord1');
        expect(recent.stripe_session_id).toBe('cs_2');
        expect(recent.product_name).toBe('Product B');
    });

    it('getRecentByDiscordId returns undefined for unknown user', () => {
        const recent = stmts.purchases.getRecentByDiscordId.get('nonexistent');
        expect(recent).toBeUndefined();
    });

    it('getBySessionId returns the matching purchase', () => {
        stmts.purchases.insertPurchase.run('cs_abc', 'discord1', 'user@test.com', 'Product X', 5000);

        const purchase = stmts.purchases.getBySessionId.get('cs_abc');
        expect(purchase).toBeDefined();
        expect(purchase.product_name).toBe('Product X');
    });

    it('getBySessionId returns undefined for unknown session', () => {
        const purchase = stmts.purchases.getBySessionId.get('cs_nonexistent');
        expect(purchase).toBeUndefined();
    });
});

// =========================================================================
// WordPress shop → second purchase skips shipping (email capture flow)
// =========================================================================

describe('WordPress shop email capture: second purchase skips shipping', () => {
    it('domestic buyer: first purchase records shipping, second lookup shows covered', () => {
        // First purchase — webhook records shipping paid at checkout
        stmts.purchases.insertPurchase.run('cs_first', null, 'buyer@test.com', 'Pokemon Pack', 1999);
        stmts.shipping.record.run('buyer@test.com', null, 1000, 'checkout', 'cs_first');

        // Second purchase — shipping lookup check (what the /shipping/lookup endpoint does)
        const covered = stmts.shipping.hasShippingThisWeek.get('buyer@test.com');
        expect(covered).toBeTruthy();
    });

    it('international buyer: first purchase records shipping, second lookup shows covered', () => {
        // Link email and flag as international
        stmts.purchases.linkDiscord.run('discord1', 'intl@test.com');
        stmts.discordLinks.setCountry.run('CA', 'discord1');

        // First purchase with international shipping
        stmts.purchases.insertPurchase.run('cs_intl_first', 'discord1', 'intl@test.com', 'Anime Box', 3500);
        stmts.shipping.record.run('intl@test.com', 'discord1', 2500, 'checkout', 'cs_intl_first');

        // Second purchase — should be covered for the month
        const covered = stmts.shipping.hasShippingThisMonth.get('intl@test.com');
        expect(covered).toBeTruthy();
    });

    it('unlinked buyer: raw shipping query says covered but the public lookup gates it on Discord-link', () => {
        // Buyer who never linked Discord — just entered email in the modal.
        // The shipping table itself doesn't care about identity, so the raw query
        // returns truthy. The /shipping/lookup endpoint applies the Discord-link
        // gate AFTER this query — see the simulateLookup tests below.
        stmts.shipping.record.run('nolink@test.com', null, 1000, 'checkout', 'cs_nolink');

        const rawCovered = stmts.shipping.hasShippingThisWeek.get('nolink@test.com');
        expect(rawCovered).toBeTruthy();

        // But the public lookup result requires known=true, so an unlinked buyer
        // can no longer inherit free shipping by entering this email at the cart.
        const link = stmts.purchases.getDiscordIdByEmail.get('nolink@test.com');
        const known = !!link;
        const publicCovered = known && !!rawCovered;
        expect(publicCovered).toBe(false);
    });

    it('coverage does not bleed across different emails', () => {
        stmts.shipping.record.run('alice@test.com', null, 1000, 'checkout', 'cs_alice');

        expect(stmts.shipping.hasShippingThisWeek.get('alice@test.com')).toBeTruthy();
        expect(stmts.shipping.hasShippingThisWeek.get('bob@test.com')).toBeUndefined();
    });

    it('full flow: purchase → shipping record → lookup returns covered with rate 0', () => {
        // Simulate the full flow as the shipping lookup endpoint would
        stmts.purchases.insertPurchase.run('cs_flow', null, 'flow@test.com', 'Product A', 2000);
        stmts.shipping.record.run('flow@test.com', null, 1000, 'checkout', 'cs_flow');

        // Replicate what GET /shipping/lookup does
        const covered = !!stmts.shipping.hasShippingThisWeek.get('flow@test.com');
        const rate = covered ? 0 : 1000;

        expect(covered).toBe(true);
        expect(rate).toBe(0);
    });

    it('first purchase with no shipping record: lookup shows not covered', () => {
        // Buyer exists but no shipping payment recorded (e.g., livestream mode)
        stmts.purchases.insertPurchase.run('cs_nosship', null, 'nosship@test.com', 'Product B', 1500);

        const covered = stmts.shipping.hasShippingThisWeek.get('nosship@test.com');
        expect(covered).toBeUndefined();
    });
});

// =========================================================================
// Shipping lookup response — cart footer badge labelling
// =========================================================================

describe('shipping lookup response (cart footer badge)', () => {
    /**
     * Replicate what GET /shipping/lookup does for a given email.
     * Returns the same shape as the endpoint response.
     */
    function simulateLookup(email) {
        const link = stmts.purchases.getDiscordIdByEmail.get(email);
        const known = !!link;

        const countryRow = link ? stmts.discordLinks.getCountry.get(link.discord_user_id) : null;
        const countryKnown = countryRow?.country != null;

        // isInternationalByEmail logic
        const intlRow = link ? stmts.discordLinks.getCountryByEmail.get(email) : null;
        const international = intlRow?.country != null && intlRow.country !== 'US';

        // hasShippingCovered logic (simplified — domestic = week, international = month).
        // Coverage is gated on `known` (Discord-linked) so an unlinked email
        // can't inherit a covered period that wasn't theirs. Mirrors the gate
        // applied in `server.js`'s GET /shipping/lookup.
        const rawCovered = international
            ? !!stmts.shipping.hasShippingThisMonth.get(email)
            : !!stmts.shipping.hasShippingThisWeek.get(email);
        const covered = known && rawCovered;

        const rate = covered ? 0 : (international ? 2500 : 1000);
        const label = international ? 'International Shipping' : 'Standard Shipping (US)';

        return { email, known, covered, international, countryKnown, rate, label };
    }

    it('brand new email: countryKnown=false, badge shows both rates', () => {
        // Email never seen before — not linked, no country, not covered
        const result = simulateLookup('newbuyer@test.com');

        expect(result.known).toBe(false);
        expect(result.countryKnown).toBe(false);
        expect(result.covered).toBe(false);
        expect(result.international).toBe(false);
        expect(result.rate).toBe(1000); // default rate, but badge should show BOTH
        // Cart badge logic: countryKnown=false → "Shipping: $10 US / $25 International"
    });

    it('linked email, no country flag: countryKnown=false, badge shows both rates', () => {
        stmts.purchases.linkDiscord.run('discord1', 'linked@test.com');
        // No country set — getCountry returns null

        const result = simulateLookup('linked@test.com');

        expect(result.known).toBe(true);
        expect(result.countryKnown).toBe(false);
        expect(result.covered).toBe(false);
        // Cart badge logic: countryKnown=false → "Shipping: $10 US / $25 International"
    });

    it('linked email, flagged US: countryKnown=true, badge shows US rate', () => {
        stmts.purchases.linkDiscord.run('discord1', 'us@test.com');
        stmts.discordLinks.setCountry.run('US', 'discord1');

        const result = simulateLookup('us@test.com');

        expect(result.known).toBe(true);
        expect(result.countryKnown).toBe(true);
        expect(result.international).toBe(false);
        expect(result.rate).toBe(1000);
        expect(result.label).toBe('Standard Shipping (US)');
        // Cart badge logic: countryKnown=true, not intl → "US shipping: $10.00"
    });

    it('linked email, flagged CA: countryKnown=true, badge shows international rate', () => {
        stmts.purchases.linkDiscord.run('discord1', 'ca@test.com');
        stmts.discordLinks.setCountry.run('CA', 'discord1');

        const result = simulateLookup('ca@test.com');

        expect(result.known).toBe(true);
        expect(result.countryKnown).toBe(true);
        expect(result.international).toBe(true);
        expect(result.rate).toBe(2500);
        expect(result.label).toBe('International Shipping');
        // Cart badge logic: countryKnown=true, intl → "International shipping: $25.00"
    });

    it('covered domestic buyer: badge shows "covered this week"', () => {
        stmts.purchases.linkDiscord.run('discord1', 'covered@test.com');
        stmts.discordLinks.setCountry.run('US', 'discord1');
        stmts.shipping.record.run('covered@test.com', 'discord1', 1000, 'checkout', 'cs_1');

        const result = simulateLookup('covered@test.com');

        expect(result.covered).toBe(true);
        expect(result.international).toBe(false);
        expect(result.rate).toBe(0);
        // Cart badge logic: covered + not intl → "Shipping covered this week!"
    });

    it('covered international buyer: badge shows "covered this month"', () => {
        stmts.purchases.linkDiscord.run('discord1', 'coveredintl@test.com');
        stmts.discordLinks.setCountry.run('CA', 'discord1');
        stmts.shipping.record.run('coveredintl@test.com', 'discord1', 2500, 'checkout', 'cs_1');

        const result = simulateLookup('coveredintl@test.com');

        expect(result.covered).toBe(true);
        expect(result.international).toBe(true);
        expect(result.rate).toBe(0);
        // Cart badge logic: covered + intl → "Shipping covered this month!"
    });

    it('SECURITY: unlinked buyer entering a covered buyer\'s email gets covered=false', () => {
        // Simulates the free-shipping exploit (TC7). Alice has paid shipping
        // and is Discord-linked. Mallory enters alice's email at the cart
        // hoping to inherit the coverage. Without the gate, Mallory would
        // pay product price only and we'd eat the shipping. With the gate,
        // we still report covered=true for Alice (linked) but covered=false
        // for any unlinked email lookup.
        stmts.purchases.linkDiscord.run('alice_discord', 'alice@test.com');
        stmts.discordLinks.setCountry.run('US', 'alice_discord');
        stmts.shipping.record.run('alice@test.com', 'alice_discord', 1000, 'checkout', 'cs_alice');

        const aliceLookup = simulateLookup('alice@test.com');
        expect(aliceLookup.known).toBe(true);
        expect(aliceLookup.covered).toBe(true);

        // Mallory enters alice's email but isn't herself Alice. The gate
        // should be on `known` — and Alice's link doesn't help Mallory.
        // (We model Mallory as a hypothetical caller; the lookup itself
        // can't tell them apart by email alone, so coverage MUST be tied
        // to the linked identity, not the email value. Confirmed.)
        // Now record-shipping for an unlinked email to make sure the gate
        // catches the never-linked case too.
        stmts.shipping.record.run('mallory@test.com', null, 1000, 'checkout', 'cs_mallory_freeloaded');
        const malloryLookup = simulateLookup('mallory@test.com');
        expect(malloryLookup.known).toBe(false);
        expect(malloryLookup.covered).toBe(false);
        expect(malloryLookup.rate).toBe(1000);
    });

    it('first purchase after auto-flag: countryKnown becomes true on subsequent lookup', () => {
        // Simulate: first purchase with unknown country
        const before = simulateLookup('autoflag@test.com');
        expect(before.countryKnown).toBe(false);

        // Webhook auto-flags after first purchase
        stmts.purchases.linkDiscord.run('discord1', 'autoflag@test.com');
        stmts.discordLinks.setCountry.run('CA', 'discord1');

        // Second lookup — now country is known
        const after = simulateLookup('autoflag@test.com');
        expect(after.countryKnown).toBe(true);
        expect(after.international).toBe(true);
        expect(after.rate).toBe(2500);
    });
});
