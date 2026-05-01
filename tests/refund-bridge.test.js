/**
 * Refund bridge — Stripe charge.refunded / charge.dispute.* event payloads
 * routed through to the unified refund propagator.
 *
 * Covers the bridge logic that maps Stripe's webhook event shape to the
 * propagator's `(sessionId, opts)` API:
 *   - charge.refunded → propagateRefund({ source: 'webhook_refund', amountCents, reason, refundId })
 *   - charge.dispute.created → propagateRefund({ source: 'webhook_dispute', ... })
 *   - missing payment_intent / no matching session → skipped, no propagator call
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { chargeRefunded, chargeDisputeCreated } from './fixtures/stripe-events.js';

const mockSessionsList = vi.fn();
const mockChargesRetrieve = vi.fn();
vi.mock('stripe', () => ({
    default: vi.fn().mockImplementation(() => ({
        checkout: { sessions: { list: (...a) => mockSessionsList(...a) } },
        charges: { retrieve: (...a) => mockChargesRetrieve(...a) },
    })),
}));

vi.mock('../config.js', () => ({
    default: {
        STRIPE_SECRET_KEY: 'sk_test_123',
    },
}));

const mockPropagateRefund = vi.fn().mockResolvedValue({ ok: true, queueDuplicate: false, shippingCanceled: false });
vi.mock('../lib/refund-propagator.js', () => ({
    propagateRefund: (...a) => mockPropagateRefund(...a),
}));

beforeEach(() => {
    vi.clearAllMocks();
    // Default: payment_intent → ONE matching session
    mockSessionsList.mockResolvedValue({ data: [{ id: 'cs_test_resolved' }] });
});

const { handleRefundEvent, handleDisputeEvent, chargeSessionId } = await import('../lib/refund-bridge.js');

// =========================================================================
// chargeSessionId — base resolution
// =========================================================================

describe('chargeSessionId', () => {
    it('resolves the session id by payment_intent', async () => {
        const charge = chargeRefunded({ paymentIntentId: 'pi_x' });
        const id = await chargeSessionId(charge);
        expect(mockSessionsList).toHaveBeenCalledWith({ payment_intent: 'pi_x', limit: 1 });
        expect(id).toBe('cs_test_resolved');
    });

    it('returns null when no session matches the payment_intent', async () => {
        mockSessionsList.mockResolvedValueOnce({ data: [] });
        const id = await chargeSessionId(chargeRefunded());
        expect(id).toBeNull();
    });

    it('returns null when payment_intent is missing on the charge', async () => {
        const charge = chargeRefunded();
        delete charge.payment_intent;
        const id = await chargeSessionId(charge);
        expect(id).toBeNull();
        expect(mockSessionsList).not.toHaveBeenCalled();
    });

    it('expands an embedded payment_intent object to its id', async () => {
        const charge = chargeRefunded();
        charge.payment_intent = { id: 'pi_embedded', object: 'payment_intent' };
        await chargeSessionId(charge);
        expect(mockSessionsList).toHaveBeenCalledWith({ payment_intent: 'pi_embedded', limit: 1 });
    });

    it('returns null on Stripe API error (does not throw)', async () => {
        mockSessionsList.mockRejectedValueOnce(new Error('Stripe down'));
        const id = await chargeSessionId(chargeRefunded());
        expect(id).toBeNull();
    });
});

// =========================================================================
// handleRefundEvent
// =========================================================================

describe('handleRefundEvent', () => {
    it('dispatches a full refund as { amountCents: null }', async () => {
        const charge = chargeRefunded({ amount: 5000, amountRefunded: 5000, refundId: 're_full' });

        const result = await handleRefundEvent(charge, 'webhook_refund');

        expect(result.skipped).toBe(false);
        expect(result.sessionId).toBe('cs_test_resolved');
        expect(mockPropagateRefund).toHaveBeenCalledOnce();
        expect(mockPropagateRefund).toHaveBeenCalledWith('cs_test_resolved', expect.objectContaining({
            source: 'webhook_refund',
            amountCents: null,
            refundId: 're_full',
        }));
    });

    it('dispatches a partial refund as { amountCents: <partial> }', async () => {
        const charge = chargeRefunded({ amount: 5000, amountRefunded: 1500, refundId: 're_partial', reason: 'dinged_card' });

        await handleRefundEvent(charge, 'webhook_refund');

        expect(mockPropagateRefund).toHaveBeenCalledWith('cs_test_resolved', expect.objectContaining({
            amountCents: 1500,
            reason: 'dinged_card',
            refundId: 're_partial',
        }));
    });

    it('skips when no checkout session matches', async () => {
        mockSessionsList.mockResolvedValueOnce({ data: [] });
        const result = await handleRefundEvent(chargeRefunded(), 'webhook_refund');

        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('no_session');
        expect(mockPropagateRefund).not.toHaveBeenCalled();
    });

    it('forwards the source label so the propagator can branch', async () => {
        await handleRefundEvent(chargeRefunded(), 'webhook_refund');
        expect(mockPropagateRefund.mock.calls[0][1].source).toBe('webhook_refund');
    });
});

// =========================================================================
// handleDisputeEvent
// =========================================================================

describe('handleDisputeEvent', () => {
    it('retrieves the underlying charge then dispatches as webhook_dispute', async () => {
        const dispute = chargeDisputeCreated({ chargeId: 'ch_disputed', amount: 5000 });
        mockChargesRetrieve.mockResolvedValueOnce({
            ...chargeRefunded({ chargeId: 'ch_disputed', paymentIntentId: 'pi_dispute' }),
            amount: 5000,
            amount_refunded: 0,
        });

        const result = await handleDisputeEvent(dispute);

        expect(mockChargesRetrieve).toHaveBeenCalledWith('ch_disputed');
        expect(result.skipped).toBe(false);
        expect(mockPropagateRefund).toHaveBeenCalledWith('cs_test_resolved', expect.objectContaining({
            source: 'webhook_dispute',
            amountCents: 5000,
        }));
    });

    it('builds the reason from dispute.reason + dispute.status', async () => {
        const dispute = chargeDisputeCreated({ reason: 'fraudulent', status: 'needs_response' });
        mockChargesRetrieve.mockResolvedValueOnce({
            ...chargeRefunded(),
            payment_intent: 'pi_a',
        });

        await handleDisputeEvent(dispute);

        expect(mockPropagateRefund.mock.calls[0][1].reason).toMatch(/fraudulent.*needs_response/);
    });

    it('skips when the dispute payload has no charge', async () => {
        const dispute = chargeDisputeCreated();
        delete dispute.charge;

        const result = await handleDisputeEvent(dispute);

        expect(result.skipped).toBe(true);
        expect(mockChargesRetrieve).not.toHaveBeenCalled();
        expect(mockPropagateRefund).not.toHaveBeenCalled();
    });

    it('skips when the charge retrieve fails', async () => {
        mockChargesRetrieve.mockRejectedValueOnce(new Error('not found'));
        const result = await handleDisputeEvent(chargeDisputeCreated());

        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('charge_retrieve_failed');
        expect(mockPropagateRefund).not.toHaveBeenCalled();
    });
});
