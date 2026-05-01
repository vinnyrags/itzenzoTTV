/**
 * Stripe charge / dispute → checkout session bridge.
 *
 * Stripe webhooks for `charge.refunded` and `charge.dispute.*` carry a
 * Charge or Dispute object, not a checkout Session — we have to look up
 * the originating session via `stripe.checkout.sessions.list({payment_intent})`
 * before the unified refund propagator can run. Extracted into its own
 * module so the bridge's two narrow responsibilities (resolve, dispatch)
 * can be tested without spinning up the express server.
 */

import Stripe from 'stripe';
import config from '../config.js';
import { propagateRefund } from './refund-propagator.js';

let _stripe = null;
function getStripe() {
    if (!_stripe) _stripe = new Stripe(config.STRIPE_SECRET_KEY);
    return _stripe;
}

/**
 * Resolve a Stripe charge → originating checkout session id by querying the
 * sessions list with `payment_intent`. Returns null when no matching session
 * exists (charge could be from a non-checkout flow — payment links, invoices
 * — we only care about checkout-session-driven purchases).
 *
 * @param {object} charge
 * @returns {Promise<string|null>}
 */
export async function chargeSessionId(charge) {
    const paymentIntentId = typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : charge.payment_intent?.id;
    if (!paymentIntentId) return null;
    try {
        const stripe = getStripe();
        const list = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
        return list.data?.[0]?.id || null;
    } catch (e) {
        console.error(`Could not resolve session for payment_intent ${paymentIntentId}:`, e.message);
        return null;
    }
}

/**
 * Handle a `charge.refunded` event. Resolves the session id and dispatches
 * to the unified refund propagator. Source is propagated so the propagator
 * can branch on dashboard-refund vs dispute behaviors.
 */
export async function handleRefundEvent(charge, source = 'webhook_refund') {
    const sessionId = await chargeSessionId(charge);
    if (!sessionId) {
        console.log(`refund: no checkout session for charge ${charge.id} — ignoring`);
        return { skipped: true, reason: 'no_session' };
    }
    const totalRefunded = charge.amount_refunded || 0;
    const isFull = totalRefunded >= (charge.amount || 0);
    await propagateRefund(sessionId, {
        source,
        amountCents: isFull ? null : totalRefunded,
        reason: charge.refunds?.data?.[0]?.reason || null,
        refundId: charge.refunds?.data?.[0]?.id || null,
    });
    return { skipped: false, sessionId };
}

/**
 * Handle a `charge.dispute.created` event. Stripe's dispute event carries
 * only the charge id; we have to retrieve the full charge before we can
 * resolve the session. Propagates as source='webhook_dispute' so the
 * propagator skips the buyer-DM (adversarial outcome).
 */
export async function handleDisputeEvent(dispute) {
    const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
    if (!chargeId) return { skipped: true, reason: 'no_charge' };

    const stripe = getStripe();
    let charge;
    try {
        charge = await stripe.charges.retrieve(chargeId);
    } catch (e) {
        console.error(`Could not retrieve charge ${chargeId} for dispute:`, e.message);
        return { skipped: true, reason: 'charge_retrieve_failed' };
    }

    const sessionId = await chargeSessionId(charge);
    if (!sessionId) {
        console.log(`dispute: no checkout session for charge ${charge.id} — ignoring`);
        return { skipped: true, reason: 'no_session' };
    }

    await propagateRefund(sessionId, {
        source: 'webhook_dispute',
        amountCents: dispute.amount || charge.amount,
        reason: `Dispute ${dispute.reason || 'unknown'} — ${dispute.status}`,
        refundId: dispute.id,
    });
    return { skipped: false, sessionId };
}
