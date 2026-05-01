/**
 * Stripe webhook payload fixtures for handler-level testing.
 *
 * These build synthetic event payloads matching Stripe's documented shape.
 * They're sufficient for testing OUR handlers (handleCheckoutCompleted,
 * propagateRefund, etc.) without needing a real Stripe round-trip — the
 * fields we read from Stripe payloads are well-bounded and stable.
 *
 * Captured-real-payload fixtures would be slightly more accurate against
 * unknown Stripe additions, but `stripe trigger` always fires live events
 * (no dry-run), and the existing bot test suite has run against synthetic
 * payloads of this shape for months without schema drift problems.
 *
 * For tests that need a payload Stripe would actually sign, capture a real
 * event via `stripe events retrieve <id>` from a prior delivery and save
 * its `data.object` here.
 */

const TEST_USER_ID = '1490206350943191052'; // @rhapttv test account
const TEST_EMAIL = 'itzenzottv+e2e@gmail.com';

/**
 * Build a Stripe checkout.session.completed event's `data.object`.
 *
 * Mirrors `commands/test.js#fakeCheckoutSession` but as a stable, reusable
 * fixture factory that doesn't drag the entire bot's runtime into tests.
 *
 * @param {object} opts
 * @param {string} [opts.id]                    Stripe session id (auto-generated cs_test_…)
 * @param {string} [opts.email]                 customer_details.email — defaults to test fixture buyer
 * @param {string|null} [opts.discordUserId]    metadata.discord_user_id (set when buyer is linked)
 * @param {string|null} [opts.discordUsername]  Stripe custom-field value (auto-link path)
 * @param {Array<{name: string, quantity: number, stock_remaining?: number}>} opts.items
 *                                              Cart contents — packed into metadata.line_items
 * @param {number} [opts.amount]                Total cents (also subtotal). Defaults to sum-of-items × 100.
 * @param {number} [opts.shippingCents]         Shipping charged in cents (0 = covered/skipped)
 * @param {string|null} [opts.shippingCountry]  ISO country code; null = no shipping_details
 * @param {object|null} [opts.shippingAddress]  Full address object overriding shippingCountry
 * @param {string|null} [opts.source]           metadata.source (pack-battle | card-sale | pull_box | ad-hoc-shipping | null)
 * @param {string|null} [opts.cardListingId]    metadata.card_listing_id (forces source='card-sale')
 * @param {string|null} [opts.pullBoxId]        metadata.pull_box_id (forces source='pull_box')
 * @param {string|null} [opts.pullBoxSlots]     metadata.pull_box_slots (comma-separated)
 * @param {object} [opts.metadata]              Extra metadata fields
 */
export function checkoutSessionCompleted(opts = {}) {
    const {
        id = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        email = TEST_EMAIL,
        name = 'Test Buyer',
        discordUserId = TEST_USER_ID,
        discordUsername = null,
        items = [{ name: 'Test Product', quantity: 1, stock_remaining: 5 }],
        amount = items.reduce((sum, i) => sum + 1000 * (i.quantity || 1), 0),
        shippingCents = 0,
        shippingCountry = null,
        shippingAddress = null,
        source = null,
        cardListingId = null,
        pullBoxId = null,
        pullBoxSlots = null,
        metadata = {},
    } = opts;

    const session = {
        id,
        object: 'checkout.session',
        customer_details: { email, name },
        customer_email: email,
        amount_total: amount,
        amount_subtotal: amount - shippingCents,
        currency: 'usd',
        payment_status: 'paid',
        status: 'complete',
        shipping_cost: { amount_total: shippingCents },
        total_details: { amount_shipping: shippingCents, amount_tax: 0, amount_discount: 0 },
        custom_fields: [],
        metadata: {
            line_items: JSON.stringify(items),
            ...(discordUserId ? { discord_user_id: discordUserId } : {}),
            ...(source ? { source } : {}),
            ...(cardListingId ? { source: 'card-sale', card_listing_id: String(cardListingId) } : {}),
            ...(pullBoxId ? { source: 'pull_box', pull_box_id: String(pullBoxId) } : {}),
            ...(pullBoxSlots ? { pull_box_slots: pullBoxSlots } : {}),
            ...metadata,
        },
    };

    if (discordUsername) {
        session.custom_fields = [{ key: 'discord_username', text: { value: discordUsername } }];
    }

    if (shippingAddress) {
        session.shipping_details = { address: shippingAddress, name };
    } else if (shippingCountry) {
        session.shipping_details = { address: { country: shippingCountry } };
    }

    return session;
}

/**
 * Build a Stripe charge.refunded event's `data.object`.
 *
 * `propagateRefund` looks up the originating session via
 * `stripe.checkout.sessions.list({payment_intent})`, so for tests that
 * don't mock that lookup, supply opts.sessionId and have the test mock
 * point at it.
 */
export function chargeRefunded(opts = {}) {
    const {
        chargeId = `ch_test_${Math.random().toString(36).slice(2, 10)}`,
        paymentIntentId = `pi_test_${Math.random().toString(36).slice(2, 10)}`,
        amount = 5000,
        amountRefunded = 5000,
        refundId = `re_test_${Math.random().toString(36).slice(2, 10)}`,
        reason = 'requested_by_customer',
    } = opts;

    return {
        id: chargeId,
        object: 'charge',
        amount,
        amount_refunded: amountRefunded,
        currency: 'usd',
        payment_intent: paymentIntentId,
        refunded: amountRefunded >= amount,
        refunds: {
            object: 'list',
            data: [
                {
                    id: refundId,
                    amount: amountRefunded,
                    currency: 'usd',
                    payment_intent: paymentIntentId,
                    reason,
                    status: 'succeeded',
                },
            ],
        },
    };
}

/**
 * Build a `charge.dispute.created` event payload.
 */
export function chargeDisputeCreated(opts = {}) {
    const {
        disputeId = `dp_test_${Math.random().toString(36).slice(2, 10)}`,
        chargeId = `ch_test_${Math.random().toString(36).slice(2, 10)}`,
        amount = 5000,
        reason = 'fraudulent',
        status = 'needs_response',
    } = opts;

    return {
        id: disputeId,
        object: 'dispute',
        amount,
        currency: 'usd',
        charge: chargeId,
        reason,
        status,
    };
}
