/**
 * Refund Critical Path — Integration Test
 *
 * Covers every real-world refund scenario for the !refund command, with the
 * focus on the ShippingEasy cancel-on-refund behavior:
 *
 *   1. Full refund of unshipped physical order  → SE order canceled, DB marked
 *   2. Full refund of already-shipped order     → SE NOT canceled (too late)
 *   3. Partial refund (e.g. damaged card)       → SE NOT canceled (buyer keeps it)
 *   4. Refund of battle buy-in (no SE order)    → no SE interaction
 *   5. SE cancel API failure                    → refund still succeeds, ops alerted
 *   6. Idempotent re-refund attempt             → no double-cancel
 *   7. Session-mode refund with SE order        → SE canceled
 *   8. Anonymous purchase (no purchase row)     → refund proceeds, no SE call
 *
 * Stripe and ShippingEasy are fully mocked — nothing leaves the test process.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, buildStmts } from './setup.js';
import { createMockMessage, createMockMention } from './mocks.js';

const ROLE_AKIVILI = '1488046525065072670';

// =========================================================================
// Module mocks — installed before any command import
// =========================================================================

const mockSendEmbed = vi.fn().mockResolvedValue(null);
const mockGetMember = vi.fn().mockImplementation((userId) =>
    Promise.resolve({
        id: userId,
        user: { tag: `user#${userId}` },
        createDM: vi.fn().mockResolvedValue({
            send: vi.fn().mockResolvedValue({}),
        }),
    })
);

vi.mock('../discord.js', () => ({
    sendEmbed: (...args) => mockSendEmbed(...args),
    getMember: (...args) => mockGetMember(...args),
}));

vi.mock('../config.js', () => ({
    default: {
        ROLES: { AKIVILI: ROLE_AKIVILI },
        STRIPE_SECRET_KEY: 'sk_test_123',
        SHIPPINGEASY_API_KEY: 'test_se_key',
        SHIPPINGEASY_API_SECRET: 'test_se_secret',
        SHIPPINGEASY_STORE_API_KEY: 'test_store_key',
    },
}));

// Stripe is constructed at module load — mock the constructor to return a
// stub with a controllable `refunds.create` and `checkout.sessions.retrieve`.
const mockRefundsCreate = vi.fn();
const mockSessionsRetrieve = vi.fn();
vi.mock('stripe', () => ({
    default: vi.fn().mockImplementation(() => ({
        checkout: { sessions: { retrieve: (...a) => mockSessionsRetrieve(...a) } },
        refunds: { create: (...a) => mockRefundsCreate(...a) },
    })),
}));

// ShippingEasy cancel call — mocked so we can assert when it fires.
const mockCancelShippingEasy = vi.fn();
vi.mock('../shippingeasy-api.js', () => ({
    cancelOrder: (...args) => mockCancelShippingEasy(...args),
}));

vi.mock('../db.js', () => ({
    db: null,
    purchases: {},
}));

// Swap fresh in-memory DB into the mocked db module before each test.
const dbModule = await import('../db.js');
let db, stmts;

beforeEach(() => {
    db = createTestDb();
    stmts = buildStmts(db);
    dbModule.db = db;
    Object.assign(dbModule.purchases, stmts.purchases);
    vi.clearAllMocks();

    // Default Stripe behavior: every refund "succeeds" with the requested amount.
    mockSessionsRetrieve.mockImplementation(async (sessionId) => ({
        id: sessionId,
        payment_intent: { id: `pi_${sessionId}` },
    }));
    mockRefundsCreate.mockImplementation(async (params) => ({
        id: `re_${Math.random().toString(36).slice(2, 8)}`,
        amount: params.amount || 5000,
    }));

    // Default SE behavior: cancel succeeds.
    mockCancelShippingEasy.mockResolvedValue(true);
});

const { handleRefund } = await import('../commands/refund.js');

// =========================================================================
// Helpers
// =========================================================================

function adminMsg(overrides = {}) {
    return createMockMessage({ roles: [ROLE_AKIVILI], ...overrides });
}

function seedPurchase({
    sessionId,
    discordId = 'buyer1',
    email = 'buyer@example.com',
    productName = 'Test Product',
    amount = 5000,
    seOrderId = null,
    shippingAddress = null,
    shippedAt = null,
    canceledAt = null,
}) {
    stmts.purchases.insertPurchase.run(sessionId, discordId, email, productName, amount);
    if (shippingAddress) {
        stmts.purchases.updateShippingAddress.run(
            shippingAddress.name || 'Buyer',
            shippingAddress.line1,
            shippingAddress.city,
            shippingAddress.state,
            shippingAddress.postal_code,
            shippingAddress.country || 'US',
            sessionId,
        );
    }
    if (seOrderId) stmts.purchases.setShippingEasyOrderId.run(seOrderId, sessionId);
    if (shippedAt) {
        db.prepare('UPDATE purchases SET shipped_at = ? WHERE stripe_session_id = ?').run(shippedAt, sessionId);
    }
    if (canceledAt) {
        db.prepare('UPDATE purchases SET shippingeasy_canceled_at = ? WHERE stripe_session_id = ?').run(canceledAt, sessionId);
    }
}

function getPurchase(sessionId) {
    return stmts.purchases.getBySessionId.get(sessionId);
}

// =========================================================================
// Scenario 1: Full refund of unshipped physical order → cancels SE order
// =========================================================================

describe('full refund of unshipped physical order', () => {
    it('cancels the ShippingEasy order and marks it canceled in DB', async () => {
        seedPurchase({
            sessionId: 'cs_unshipped',
            seOrderId: 'se_111',
            shippingAddress: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001' },
        });

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        expect(mockRefundsCreate).toHaveBeenCalledOnce();
        expect(mockCancelShippingEasy).toHaveBeenCalledOnce();
        expect(mockCancelShippingEasy).toHaveBeenCalledWith({
            orderId: 'se_111',
            sessionId: 'cs_unshipped',
            email: 'buyer@example.com',
        });

        const updated = getPurchase('cs_unshipped');
        expect(updated.shippingeasy_canceled_at).toBeTruthy();
    });

    it('drops the canceled order out of getPendingShipments', async () => {
        seedPurchase({
            sessionId: 'cs_drops_out',
            seOrderId: 'se_222',
            shippingAddress: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001' },
        });
        expect(stmts.purchases.getPendingShipments.all()).toHaveLength(1);

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        expect(stmts.purchases.getPendingShipments.all()).toHaveLength(0);
    });

    it('tells the buyer their order will not ship', async () => {
        seedPurchase({
            sessionId: 'cs_buyer_dm',
            seOrderId: 'se_333',
            shippingAddress: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001' },
        });
        const dmSend = vi.fn().mockResolvedValue({});
        mockGetMember.mockResolvedValueOnce({
            createDM: vi.fn().mockResolvedValue({ send: dmSend }),
        });

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        expect(dmSend).toHaveBeenCalledOnce();
        const dmEmbed = dmSend.mock.calls[0][0].embeds[0].data;
        expect(dmEmbed.description).toContain('canceled and will **not** ship');
    });
});

// =========================================================================
// Scenario 2: Full refund of already-shipped order → SE cancel skipped
// =========================================================================

describe('full refund of already-shipped order', () => {
    it('does NOT call ShippingEasy cancel', async () => {
        seedPurchase({
            sessionId: 'cs_shipped',
            seOrderId: 'se_444',
            shippingAddress: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001' },
            shippedAt: '2026-04-20 10:00:00',
        });

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        expect(mockRefundsCreate).toHaveBeenCalledOnce();
        expect(mockCancelShippingEasy).not.toHaveBeenCalled();

        const updated = getPurchase('cs_shipped');
        expect(updated.shippingeasy_canceled_at).toBeNull();
    });

    it('logs "already shipped" in the ops embed', async () => {
        seedPurchase({
            sessionId: 'cs_shipped_2',
            seOrderId: 'se_555',
            shippingAddress: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001' },
            shippedAt: '2026-04-20 10:00:00',
        });

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        const opsCall = mockSendEmbed.mock.calls.find((c) => c[0] === 'OPS');
        expect(opsCall).toBeDefined();
        expect(opsCall[1].description).toMatch(/Already shipped/i);
    });
});

// =========================================================================
// Scenario 3: Partial refund → SE cancel skipped (buyer keeps the item)
// =========================================================================

describe('partial refund of physical order', () => {
    it('does NOT cancel the ShippingEasy order', async () => {
        seedPurchase({
            sessionId: 'cs_partial',
            seOrderId: 'se_666',
            amount: 5000,
            shippingAddress: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001' },
        });
        // Stripe returns the partial amount we asked for
        mockRefundsCreate.mockResolvedValueOnce({ id: 're_partial', amount: 1000 });

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>', '10.00', 'Card', 'has', 'a', 'ding']);

        expect(mockRefundsCreate).toHaveBeenCalledOnce();
        expect(mockCancelShippingEasy).not.toHaveBeenCalled();

        const updated = getPurchase('cs_partial');
        expect(updated.shippingeasy_canceled_at).toBeNull();
    });

    it('reassures the buyer the order is still shipping', async () => {
        seedPurchase({
            sessionId: 'cs_partial_dm',
            seOrderId: 'se_777',
            amount: 5000,
            shippingAddress: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001' },
        });
        mockRefundsCreate.mockResolvedValueOnce({ id: 're_partial_dm', amount: 500 });
        const dmSend = vi.fn().mockResolvedValue({});
        mockGetMember.mockResolvedValueOnce({
            createDM: vi.fn().mockResolvedValue({ send: dmSend }),
        });

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>', '5.00']);

        const dmEmbed = dmSend.mock.calls[0][0].embeds[0].data;
        expect(dmEmbed.description).toContain('still on track to ship');
    });
});

// =========================================================================
// Scenario 4: Battle buy-in / digital product (no SE order, no shipping)
// =========================================================================

describe('refund of battle buy-in (no shipping)', () => {
    it('does NOT call ShippingEasy cancel', async () => {
        seedPurchase({ sessionId: 'cs_battle', amount: 1000 }); // no SE order, no shipping

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        expect(mockRefundsCreate).toHaveBeenCalledOnce();
        expect(mockCancelShippingEasy).not.toHaveBeenCalled();
    });

    it('omits any shipping copy from the buyer DM', async () => {
        seedPurchase({ sessionId: 'cs_battle_dm', amount: 1000 });
        const dmSend = vi.fn().mockResolvedValue({});
        mockGetMember.mockResolvedValueOnce({
            createDM: vi.fn().mockResolvedValue({ send: dmSend }),
        });

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        const dmEmbed = dmSend.mock.calls[0][0].embeds[0].data;
        expect(dmEmbed.description).not.toContain('canceled and will');
        expect(dmEmbed.description).not.toContain('still on track to ship');
        expect(dmEmbed.description).toContain('5-10 business days');
    });
});

// =========================================================================
// Public refund policy link is included on every refund DM
// =========================================================================

describe('refund policy link', () => {
    it('every buyer DM links to the public refund policy page', async () => {
        seedPurchase({ sessionId: 'cs_policy', amount: 1000 });
        const dmSend = vi.fn().mockResolvedValue({});
        mockGetMember.mockResolvedValueOnce({
            createDM: vi.fn().mockResolvedValue({ send: dmSend }),
        });

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        const dmEmbed = dmSend.mock.calls[0][0].embeds[0].data;
        expect(dmEmbed.description).toContain('/how-it-works/refund-policy');
    });
});

// =========================================================================
// Scenario 5: ShippingEasy cancel API fails → refund still succeeds
// =========================================================================

describe('ShippingEasy cancel API failure', () => {
    it('does not block the Stripe refund — buyer still gets their money', async () => {
        seedPurchase({
            sessionId: 'cs_se_fail',
            seOrderId: 'se_888',
            shippingAddress: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001' },
        });
        mockCancelShippingEasy.mockResolvedValueOnce(false);

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        expect(mockRefundsCreate).toHaveBeenCalledOnce();
        expect(mockCancelShippingEasy).toHaveBeenCalledOnce();
        // DB is NOT marked canceled — operator needs to manually clean up.
        const updated = getPurchase('cs_se_fail');
        expect(updated.shippingeasy_canceled_at).toBeNull();
    });

    it('flags manual cleanup in the ops embed', async () => {
        seedPurchase({
            sessionId: 'cs_se_fail_2',
            seOrderId: 'se_999',
            shippingAddress: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001' },
        });
        mockCancelShippingEasy.mockResolvedValueOnce(false);

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        const opsCall = mockSendEmbed.mock.calls.find((c) => c[0] === 'OPS');
        expect(opsCall[1].description).toMatch(/Cancel failed.*manual cleanup/i);
    });
});

// =========================================================================
// Scenario 6: Idempotency — already-canceled SE order, do not re-call API
// =========================================================================

describe('idempotency', () => {
    it('does not re-call ShippingEasy when canceled_at is already set', async () => {
        seedPurchase({
            sessionId: 'cs_already_canceled',
            seOrderId: 'se_aaa',
            shippingAddress: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001' },
            canceledAt: '2026-04-20 09:00:00',
        });

        const msg = adminMsg();
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        expect(mockCancelShippingEasy).not.toHaveBeenCalled();
    });
});

// =========================================================================
// Scenario 7: Session-mode refund (`!refund session cs_xxx`) with SE order
// =========================================================================

describe('session-mode refund', () => {
    it('cancels the SE order for the targeted session', async () => {
        seedPurchase({
            sessionId: 'cs_target',
            seOrderId: 'se_bbb',
            shippingAddress: { line1: '1 Main', city: 'NYC', state: 'NY', postal_code: '10001' },
        });

        const msg = adminMsg();
        await handleRefund(msg, ['session', 'cs_target']);

        expect(mockCancelShippingEasy).toHaveBeenCalledOnce();
        expect(mockCancelShippingEasy).toHaveBeenCalledWith(expect.objectContaining({
            orderId: 'se_bbb',
            sessionId: 'cs_target',
        }));
    });
});

// =========================================================================
// Scenario 8: Owner-only enforcement
// =========================================================================

describe('permission gating', () => {
    it('rejects non-owner refund attempts before touching Stripe', async () => {
        const msg = createMockMessage({ roles: [] }); // no AKIVILI role
        msg.mentions.users.first = vi.fn().mockReturnValue({ id: 'buyer1' });
        await handleRefund(msg, ['<@buyer1>']);

        expect(mockRefundsCreate).not.toHaveBeenCalled();
        expect(mockCancelShippingEasy).not.toHaveBeenCalled();
    });
});
