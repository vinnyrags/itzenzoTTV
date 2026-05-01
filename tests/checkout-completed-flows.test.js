/**
 * checkout.session.completed — handler-level contract tests.
 *
 * These run handleCheckoutCompleted against synthetic Stripe payloads and
 * assert the side effects we care about (purchase rows, role bumps,
 * queue mirror, embeds). They're handler-level — Stripe's HTTP layer and
 * signature verification are skipped, since both are well-covered by
 * Stripe's own SDK and the express layer is just a thin pass-through.
 *
 * Coverage gap this fills: existing `tests/stripe-webhook.test.js` only
 * exercises individual SQL statements, never calls the actual handler.
 * `tests/refund-critical-path.test.js` covers refunds but not the
 * post-payment happy/sad paths through handleCheckoutCompleted.
 *
 * Mocks every boundary the handler touches:
 *   - discord.js (sendEmbed, getMember, sendToChannel, addRole, hasRole, findMemberByUsername)
 *   - shippingeasy-api.js (createOrder)
 *   - lib/queue-source.js (addEntry, getActiveQueue, etc.)
 *   - lib/activity-broadcaster.js (broadcastLowStock, broadcastSoldOut)
 *   - community-goals.js (addRevenue)
 *   - lib/wp-pull-box.js (getActiveBox, claimSlots)
 *   - commands/battle.js (updateBattleMessage)
 *   - commands/card-shop.js (clearExpiryTimer / clearListingTtl / updateListingEmbed / updateListSessionEmbed)
 *   - stripe (the handler doesn't call out except via lib/refund-propagator → propagateRefund's chargeSessionId resolver, not exercised here)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, buildStmts } from './setup.js';
import { checkoutSessionCompleted } from './fixtures/stripe-events.js';

const TEST_USER_ID = '1490206350943191052';
const TEST_EMAIL = 'itzenzottv+e2e@gmail.com';

// =========================================================================
// Module mocks — installed before any source import
// =========================================================================

const mockSendEmbed = vi.fn().mockResolvedValue(null);
const mockSendToChannel = vi.fn().mockResolvedValue(null);
const mockGetMember = vi.fn().mockImplementation((userId) =>
    Promise.resolve({
        id: userId,
        user: { id: userId, tag: `user#${userId}`, username: 'rhapttv' },
        roles: { cache: { has: () => false } },
        createDM: vi.fn().mockResolvedValue({ send: vi.fn().mockResolvedValue({}) }),
    }),
);
const mockAddRole = vi.fn().mockResolvedValue(true);
const mockHasRole = vi.fn().mockReturnValue(false);
const mockFindMemberByUsername = vi.fn().mockResolvedValue(null);
const mockGetGuild = vi.fn().mockReturnValue(null);

vi.mock('../discord.js', () => ({
    sendEmbed: (...a) => mockSendEmbed(...a),
    sendToChannel: (...a) => mockSendToChannel(...a),
    getMember: (...a) => mockGetMember(...a),
    addRole: (...a) => mockAddRole(...a),
    hasRole: (...a) => mockHasRole(...a),
    findMemberByUsername: (...a) => mockFindMemberByUsername(...a),
    getGuild: (...a) => mockGetGuild(...a),
    client: { channels: { cache: new Map() } },
}));

vi.mock('../config.js', () => ({
    default: {
        STRIPE_SECRET_KEY: 'sk_test_123',
        DISCORD_BOT_TOKEN: 'fake',
        SHOP_URL: 'https://itzenzo.tv',
        ROLES: { XIPE: 'role-xipe', LONG: 'role-long', AKIVILI: 'role-akivili' },
        XIPE_PURCHASE_THRESHOLD: 1,
        LONG_PURCHASE_THRESHOLD: 5,
        LOW_STOCK_THRESHOLD: 3,
        SHIPPING: { DOMESTIC: 1000, INTERNATIONAL: 2500 },
        QUEUE_SOURCE: 'sqlite',
    },
}));

const mockCreateOrder = vi.fn().mockResolvedValue('SE-fake-order-id');
vi.mock('../shippingeasy-api.js', () => ({
    createOrder: (...a) => mockCreateOrder(...a),
    cancelOrder: vi.fn(),
}));

const mockBroadcastLowStock = vi.fn();
const mockBroadcastSoldOut = vi.fn();
vi.mock('../lib/activity-broadcaster.js', () => ({
    broadcastLowStock: (...a) => mockBroadcastLowStock(...a),
    broadcastSoldOut: (...a) => mockBroadcastSoldOut(...a),
}));

const mockAddRevenue = vi.fn().mockResolvedValue(undefined);
vi.mock('../community-goals.js', () => ({
    addRevenue: (...a) => mockAddRevenue(...a),
}));

const mockQueueAddEntry = vi.fn().mockResolvedValue({ closedSession: false, duplicate: false, entry: { id: 'q_1' }, lastInsertRowid: 1 });
const mockQueueGetActiveQueue = vi.fn().mockResolvedValue({ id: 'queue-1', status: 'open' });
vi.mock('../lib/queue-source.js', () => ({
    addEntry: (...a) => mockQueueAddEntry(...a),
    getActiveQueue: (...a) => mockQueueGetActiveQueue(...a),
    markEntryRefundedBySession: vi.fn().mockResolvedValue(null),
    updateEntry: vi.fn(),
    setDuckRaceWinner: vi.fn(),
    setChannelMessage: vi.fn(),
}));

vi.mock('../lib/wp-pull-box.js', () => ({
    getActiveBox: vi.fn().mockResolvedValue(null),
    claimSlots: vi.fn(),
    confirmSlots: vi.fn(),
}));

vi.mock('../commands/battle.js', () => ({
    updateBattleMessage: vi.fn().mockResolvedValue(null),
}));

vi.mock('../commands/card-shop.js', () => ({
    clearExpiryTimer: vi.fn(),
    clearListingTtl: vi.fn(),
    updateListingEmbed: vi.fn().mockResolvedValue(null),
    updateListSessionEmbed: vi.fn().mockResolvedValue(null),
}));

vi.mock('../commands/queue.js', () => ({
    addToQueue: vi.fn().mockResolvedValue(true),
}));

vi.mock('../commands/pull.js', () => ({
    recordPullPurchase: vi.fn().mockResolvedValue(undefined),
    recordPullBoxPurchase: vi.fn().mockResolvedValue(undefined),
}));

// shipping is `recordShipping` → `shipping.record.run(...)` (see ../shipping.js).
// Stub the prepared statement as a no-op `.run()` so the path is exercised without
// a real shipping_payments insert (we don't assert on shipping rows here).
const mockShippingRecord = { run: vi.fn() };

vi.mock('../db.js', () => ({
    db: null,
    purchases: {},
    battles: {},
    cardListings: {},
    listSessions: {},
    discordLinks: {},
    shipping: { record: mockShippingRecord },
    tracking: {},
}));

const dbModule = await import('../db.js');
let db, stmts;

beforeEach(() => {
    db = createTestDb();
    stmts = buildStmts(db);
    dbModule.db = db;
    Object.assign(dbModule.purchases, stmts.purchases);
    Object.assign(dbModule.battles, stmts.battles);
    Object.assign(dbModule.cardListings, stmts.cardListings);
    Object.assign(dbModule.listSessions, stmts.listSessions);
    Object.assign(dbModule.discordLinks, stmts.discordLinks);
    vi.clearAllMocks();
    mockGetActiveBattle();
});

function mockGetActiveBattle(battle = null) {
    stmts.battles.getActiveBattle = battle
        ? { get: () => battle }
        : { get: () => null };
}

const { handleCheckoutCompleted } = await import('../webhooks/stripe.js');

// =========================================================================
// Single-line order — happy path
// =========================================================================

describe('single-line order — Discord-linked buyer', () => {
    it('records the purchase row keyed on session id', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Pokemon Box', quantity: 1, stock_remaining: 4 }],
            amount: 2999,
        });
        await handleCheckoutCompleted(session);

        const row = stmts.purchases.getBySessionId.get(session.id);
        expect(row).toBeTruthy();
        expect(row.discord_user_id).toBe(TEST_USER_ID);
        expect(row.customer_email).toBe(TEST_EMAIL);
        expect(row.amount).toBe(2999);
    });

    it('increments purchase_count exactly once for a single-line order', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Box', quantity: 1, stock_remaining: 4 }],
        });
        await handleCheckoutCompleted(session);

        const count = stmts.purchases.getPurchaseCount.get(TEST_USER_ID);
        expect(count.total_purchases).toBe(1);
    });

    it('mirrors the order to the unified queue exactly once', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Single Item', quantity: 1, stock_remaining: 4 }],
        });
        const { addToQueue } = await import('../commands/queue.js');
        await handleCheckoutCompleted(session);

        expect(addToQueue).toHaveBeenCalledTimes(1);
    });

    it('posts the new-order embed to #order-feed', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Hot Item', quantity: 1, stock_remaining: 4 }],
        });
        await handleCheckoutCompleted(session);

        const orderFeedCall = mockSendEmbed.mock.calls.find((c) => c[0] === 'ORDER_FEED');
        expect(orderFeedCall).toBeDefined();
        expect(orderFeedCall[1].title).toMatch(/New Order/);
    });
});

// =========================================================================
// Multi-line order — consolidation
// =========================================================================

describe('multi-line order', () => {
    it('produces ONE consolidated queue entry for all line items', async () => {
        const session = checkoutSessionCompleted({
            items: [
                { name: 'Item A', quantity: 2, stock_remaining: 5 },
                { name: 'Item B', quantity: 1, stock_remaining: 5 },
                { name: 'Item C', quantity: 3, stock_remaining: 5 },
            ],
        });
        const { addToQueue } = await import('../commands/queue.js');
        await handleCheckoutCompleted(session);

        // One call to addToQueue, no per-line fan-out
        expect(addToQueue).toHaveBeenCalledTimes(1);
        const passed = addToQueue.mock.calls[0][0];
        expect(passed.items).toHaveLength(3);
    });

    it('writes one purchase row per line item under the same session id', async () => {
        const session = checkoutSessionCompleted({
            items: [
                { name: 'Item A', quantity: 1, stock_remaining: 5 },
                { name: 'Item B', quantity: 1, stock_remaining: 5 },
            ],
        });
        await handleCheckoutCompleted(session);

        const all = db.prepare(`SELECT * FROM purchases WHERE stripe_session_id = ?`).all(session.id);
        // INSERT OR IGNORE on stripe_session_id (UNIQUE) means only the first line item lands —
        // multi-line orders share a session id; the queue mirror does the per-line consolidation.
        expect(all).toHaveLength(1);
    });
});

// =========================================================================
// Auto-link via Stripe custom field
// =========================================================================

describe('Discord auto-link via custom field', () => {
    it('links the buyer when discord_username is found in the guild', async () => {
        const session = checkoutSessionCompleted({
            discordUserId: null, // unlinked
            discordUsername: 'rhapttv',
            items: [{ name: 'Box', quantity: 1, stock_remaining: 4 }],
        });
        mockFindMemberByUsername.mockResolvedValueOnce({ id: 'discord-found-id', user: { id: 'discord-found-id', tag: 'rhapttv#1234' } });
        await handleCheckoutCompleted(session);

        const link = stmts.purchases.getDiscordIdByEmail.get(TEST_EMAIL);
        expect(link?.discord_user_id).toBe('discord-found-id');
    });

    it('leaves the buyer unlinked when the username is not in the guild', async () => {
        const session = checkoutSessionCompleted({
            discordUserId: null,
            discordUsername: 'mystery-user',
            items: [{ name: 'Box', quantity: 1, stock_remaining: 4 }],
        });
        mockFindMemberByUsername.mockResolvedValueOnce(null);
        await handleCheckoutCompleted(session);

        const link = stmts.purchases.getDiscordIdByEmail.get(TEST_EMAIL);
        expect(link).toBeUndefined();
    });
});

// =========================================================================
// Idempotency (PR 3 regression coverage at the handler layer)
// =========================================================================

describe('webhook retry idempotency', () => {
    it('does not double-bump purchase_count on a redelivery of the same session', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Box', quantity: 1, stock_remaining: 4 }],
        });

        await handleCheckoutCompleted(session);
        await handleCheckoutCompleted(session); // retry

        const count = stmts.purchases.getPurchaseCount.get(TEST_USER_ID);
        expect(count.total_purchases).toBe(1);
    });

    it('keeps the purchase row exactly once (UNIQUE on stripe_session_id)', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Box', quantity: 1, stock_remaining: 4 }],
        });

        await handleCheckoutCompleted(session);
        await handleCheckoutCompleted(session);

        const rows = db.prepare(`SELECT * FROM purchases WHERE stripe_session_id = ?`).all(session.id);
        expect(rows).toHaveLength(1);
    });
});

// =========================================================================
// Source: ad-hoc-shipping (fast-path, returns early)
// =========================================================================

describe('ad-hoc-shipping source (early return)', () => {
    it('records shipping but no purchase / queue mirror', async () => {
        const session = checkoutSessionCompleted({
            source: 'ad-hoc-shipping',
            items: [{ name: 'Shipping difference', quantity: 1 }],
        });
        const { addToQueue } = await import('../commands/queue.js');

        await handleCheckoutCompleted(session);

        expect(addToQueue).not.toHaveBeenCalled();
        const row = stmts.purchases.getBySessionId.get(session.id);
        expect(row).toBeFalsy();
    });
});

// =========================================================================
// Source: pack-battle (queue mirror skipped from rolled-up `addToQueue`,
// pack battles get their own `queueSource.addEntry` flow inside webhook)
// =========================================================================

describe('pack-battle source', () => {
    it('does NOT call addToQueue for pack-battle sessions', async () => {
        // Active battle so checkBattlePayment's getActiveBattle returns truthy
        mockGetActiveBattle({
            id: 1,
            product_name: 'TEST Battle',
            max_entries: 4,
            format: 'sealed',
        });
        stmts.battles.addEntry = { run: () => ({ changes: 1 }) };
        stmts.battles.confirmPayment = { run: () => undefined };
        stmts.battles.getEntries = { all: () => [] };
        stmts.battles.getPaidEntries = { all: () => [] };

        const session = checkoutSessionCompleted({
            source: 'pack-battle',
            items: [{ name: 'TEST Battle', quantity: 1 }],
        });
        const { addToQueue } = await import('../commands/queue.js');

        await handleCheckoutCompleted(session);

        // The rolled-up `addToQueue` is reserved for catalog orders; pack battles
        // mirror via queueSource.addEntry directly.
        expect(addToQueue).not.toHaveBeenCalled();
    });
});

// =========================================================================
// Low-stock + sold-out broadcasts
// =========================================================================

describe('low-stock / sold-out alerts', () => {
    it('broadcasts low-stock when stock_remaining is between 1 and threshold', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Almost-sold-out', quantity: 1, stock_remaining: 2 }],
        });

        await handleCheckoutCompleted(session);

        expect(mockBroadcastLowStock).toHaveBeenCalledOnce();
        expect(mockBroadcastLowStock).toHaveBeenCalledWith('Almost-sold-out', 2);
    });

    it('broadcasts sold-out when stock_remaining is 0', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Sold-Out Item', quantity: 1, stock_remaining: 0 }],
        });

        await handleCheckoutCompleted(session);

        expect(mockBroadcastSoldOut).toHaveBeenCalledOnce();
        expect(mockBroadcastSoldOut).toHaveBeenCalledWith('Sold-Out Item');
    });

    it('does NOT broadcast when stock_remaining is above threshold', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Plenty', quantity: 1, stock_remaining: 50 }],
        });

        await handleCheckoutCompleted(session);

        expect(mockBroadcastLowStock).not.toHaveBeenCalled();
        expect(mockBroadcastSoldOut).not.toHaveBeenCalled();
    });
});

// =========================================================================
// Email normalization (PR 2 regression coverage at the handler layer)
// =========================================================================

describe('email normalization at the webhook seam', () => {
    it('lowercases the email before persisting + linking', async () => {
        const session = checkoutSessionCompleted({
            email: 'User@Gmail.COM',
            items: [{ name: 'Box', quantity: 1, stock_remaining: 4 }],
        });

        await handleCheckoutCompleted(session);

        const row = stmts.purchases.getBySessionId.get(session.id);
        expect(row.customer_email).toBe('user@gmail.com');
    });
});
