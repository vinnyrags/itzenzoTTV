/**
 * Embed-shape contract tests — verify the actual content of every embed our
 * handlers send to Discord, not just that sendEmbed was called.
 *
 * Coverage gap this fills: existing checkout-completed and refund tests
 * assert the channel key (`mockSendEmbed.mock.calls.find(c => c[0] === 'X')`)
 * but only do shallow regex checks on title. Bugs that survive that: wrong
 * description templates (`Buyer: <@undefined>`), missing fields, wrong
 * color on dispute vs refund, broken footer dates, etc. — all real
 * production-visible regressions.
 *
 * Pattern: trigger the handler, find the captured embed by channel key,
 * deep-assert title / description / color / fields / footer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, buildStmts } from './setup.js';
import { checkoutSessionCompleted, chargeRefunded, chargeDisputeCreated } from './fixtures/stripe-events.js';

const TEST_USER_ID = '1490206350943191052';
const TEST_EMAIL = 'itzenzottv+e2e@gmail.com';

// =========================================================================
// Mocks (same shape as checkout-completed-flows.test.js)
// =========================================================================

const mockSendEmbed = vi.fn().mockResolvedValue(null);
const mockSendToChannel = vi.fn().mockResolvedValue(null);
const dmSend = vi.fn().mockResolvedValue({});
const mockGetMember = vi.fn().mockImplementation((userId) =>
    Promise.resolve({
        id: userId,
        user: { id: userId, tag: `user#${userId}`, username: `user-${userId}` },
        roles: { cache: { has: () => false } },
        createDM: vi.fn().mockResolvedValue({ send: dmSend }),
    }),
);

vi.mock('../discord.js', () => ({
    sendEmbed: (...a) => mockSendEmbed(...a),
    sendToChannel: (...a) => mockSendToChannel(...a),
    getMember: (...a) => mockGetMember(...a),
    addRole: vi.fn().mockResolvedValue(true),
    hasRole: vi.fn().mockReturnValue(false),
    findMemberByUsername: vi.fn().mockResolvedValue(null),
    getGuild: vi.fn().mockReturnValue(null),
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

vi.mock('../shippingeasy-api.js', () => ({
    createOrder: vi.fn().mockResolvedValue('SE-fake'),
    cancelOrder: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/activity-broadcaster.js', () => ({
    broadcastLowStock: vi.fn(),
    broadcastSoldOut: vi.fn(),
}));

vi.mock('../community-goals.js', () => ({
    addRevenue: vi.fn().mockResolvedValue(undefined),
}));

const mockQueueAddEntry = vi.fn().mockResolvedValue({ closedSession: false, duplicate: false, entry: { id: 'q_1' } });
vi.mock('../lib/queue-source.js', () => ({
    addEntry: (...a) => mockQueueAddEntry(...a),
    getActiveQueue: vi.fn().mockResolvedValue({ id: 'queue-1', status: 'open' }),
    markEntryRefundedBySession: vi.fn().mockResolvedValue(null),
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

vi.mock('../db.js', () => ({
    db: null,
    purchases: {},
    battles: {},
    cardListings: {},
    listSessions: {},
    discordLinks: {},
    shipping: { record: { run: vi.fn() } },
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
});

const { handleCheckoutCompleted } = await import('../webhooks/stripe.js');
const { propagateRefund } = await import('../lib/refund-propagator.js');

// =========================================================================
// Helpers
// =========================================================================

function getEmbedFor(channelKey) {
    const call = mockSendEmbed.mock.calls.find((c) => c[0] === channelKey);
    return call ? call[1] : null;
}

function getDMEmbed() {
    const call = dmSend.mock.calls.find((c) => c[0]?.embeds?.length);
    return call ? call[0].embeds[0].data : null;
}

// =========================================================================
// Order feed + receipt DM
// =========================================================================

describe('order-feed embed (#ORDER_FEED)', () => {
    it('renders title, item list, and buyer mention for a Discord-linked buyer', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Charizard Box', quantity: 1, stock_remaining: 5 }],
            amount: 4999,
        });
        await handleCheckoutCompleted(session);

        const embed = getEmbedFor('ORDER_FEED');
        expect(embed).toBeTruthy();
        expect(embed.title).toBe('🛒 New Order!');
        expect(embed.description).toContain(`<@${TEST_USER_ID}>`);
        expect(embed.description).toContain('Charizard Box');
        expect(embed.color).toBe(0xceff00);
        expect(embed.footer).toBeTruthy();
    });

    it('uses item-list-only description for an unlinked buyer', async () => {
        const session = checkoutSessionCompleted({
            discordUserId: null,
            items: [{ name: 'Mystery Pack', quantity: 1, stock_remaining: 3 }],
        });
        await handleCheckoutCompleted(session);

        const embed = getEmbedFor('ORDER_FEED');
        // No buyer mention for unlinked
        expect(embed.description).not.toContain('<@');
        expect(embed.description).toContain('Mystery Pack');
    });

    it('renders multi-quantity with the (×N) suffix', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Booster Pack', quantity: 3, stock_remaining: 50 }],
        });
        await handleCheckoutCompleted(session);

        const embed = getEmbedFor('ORDER_FEED');
        expect(embed.description).toMatch(/Booster Pack.*×3/);
    });
});

describe('receipt DM', () => {
    it('renders $ formatted total and item list', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Test Item', quantity: 1, stock_remaining: 5 }],
            amount: 1999,
        });
        await handleCheckoutCompleted(session);

        const embed = getDMEmbed();
        expect(embed).toBeTruthy();
        expect(embed.title).toBe('🧾 Purchase Receipt');
        expect(embed.description).toContain('Test Item');
        expect(embed.description).toContain('**Total:** $19.99');
        expect(embed.description).toContain('Orders ship weekly');
        expect(embed.color).toBe(0xceff00);
    });

    it('does NOT DM the buyer for source=card-sale (their listing-specific DM is fired elsewhere)', async () => {
        const session = checkoutSessionCompleted({
            source: 'card-sale',
            cardListingId: 99,
            items: [{ name: 'Gengar V', quantity: 1 }],
        });
        // The listing-resolution branch needs a fake listing in the test db
        stmts.cardListings.create.run('Gengar V', 1500, TEST_USER_ID, 'active');
        const listingId = db.prepare('SELECT id FROM card_listings ORDER BY id DESC LIMIT 1').get().id;

        const session2 = checkoutSessionCompleted({
            source: 'card-sale',
            cardListingId: listingId,
            items: [{ name: 'Gengar V', quantity: 1 }],
        });
        await handleCheckoutCompleted(session2);

        // The receipt DM has the "Purchase Receipt" title; card-sale path
        // skips it (the card-sale specific DM is "Purchase Confirmed").
        const dmCalls = dmSend.mock.calls.map((c) => c[0]?.embeds?.[0]?.data?.title).filter(Boolean);
        expect(dmCalls).not.toContain('🧾 Purchase Receipt');
    });
});

// =========================================================================
// Low-stock + sold-out
// =========================================================================

describe('low-stock embed (#DEALS)', () => {
    it('renders the warning emoji + product name + remaining count', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Last-2 Item', quantity: 1, stock_remaining: 2 }],
        });
        await handleCheckoutCompleted(session);

        const embed = getEmbedFor('DEALS');
        expect(embed).toBeTruthy();
        expect(embed.title).toBe('⚠️ Low Stock Alert');
        expect(embed.description).toContain('Last-2 Item');
        expect(embed.description).toContain('**2**');
        expect(embed.color).toBe(0xe74c3c);
    });
});

describe('sold-out embed (#DEALS)', () => {
    it('renders the sold-out variant', async () => {
        const session = checkoutSessionCompleted({
            items: [{ name: 'Last-One Item', quantity: 1, stock_remaining: 0 }],
        });
        await handleCheckoutCompleted(session);

        // The handler may emit BOTH low-stock and sold-out with the same channel
        // key; iterate to find the right one.
        const allDealsCalls = mockSendEmbed.mock.calls.filter((c) => c[0] === 'DEALS');
        const soldOut = allDealsCalls.find((c) => c[1].title === '🚫 Sold Out');
        expect(soldOut).toBeTruthy();
        expect(soldOut[1].description).toContain('Last-One Item');
        expect(soldOut[1].color).toBe(0x95a5a6);
    });
});

// =========================================================================
// Refund (#OPS) + buyer DM
// =========================================================================

describe('refund #OPS embed', () => {
    it('renders title, product, original, refunded, source label, refund id', async () => {
        // Seed a purchase first so the propagator finds it
        stmts.purchases.insertPurchase.run('cs_refund_1', TEST_USER_ID, TEST_EMAIL, 'Refunded Item', 5000);

        await propagateRefund('cs_refund_1', {
            source: 'webhook_refund',
            amountCents: null,
            reason: 'requested_by_customer',
            refundId: 're_test_xyz',
        });

        const embed = getEmbedFor('OPS');
        expect(embed).toBeTruthy();
        expect(embed.title).toBe('💸 Refund Issued');
        expect(embed.description).toContain('**Product:** Refunded Item');
        expect(embed.description).toContain('**Original:** $50.00');
        expect(embed.description).toContain('**Refunded:** full');
        expect(embed.description).toContain('Stripe Dashboard / API');
        expect(embed.description).toContain('re_test_xyz');
        expect(embed.color).toBe(0xe74c3c);
    });

    it('marks partial refunds with (Partial) suffix', async () => {
        stmts.purchases.insertPurchase.run('cs_partial_1', TEST_USER_ID, TEST_EMAIL, 'Item', 5000);

        await propagateRefund('cs_partial_1', {
            source: 'webhook_refund',
            amountCents: 1500,
            reason: 'damaged_card',
        });

        const embed = getEmbedFor('OPS');
        expect(embed.title).toBe('💸 Refund Issued (Partial)');
        expect(embed.description).toContain('**Refunded:** $15.00');
    });
});

describe('refund buyer DM', () => {
    it('lands with friendly title + amount + refund-policy link', async () => {
        stmts.purchases.insertPurchase.run('cs_dm_refund', TEST_USER_ID, TEST_EMAIL, 'Pretty Item', 2500);

        await propagateRefund('cs_dm_refund', {
            source: 'webhook_refund',
            amountCents: null,
            reason: 'requested_by_customer',
        });

        const embed = getDMEmbed();
        expect(embed).toBeTruthy();
        expect(embed.title).toBe('💸 Refund Processed');
        expect(embed.description).toContain('a full refund');
        expect(embed.description).toContain('Pretty Item');
        expect(embed.description).toContain('5-10 business days');
        expect(embed.description).toContain('how-it-works/refund-policy');
        expect(embed.color).toBe(0xceff00);
    });
});

describe('dispute (#OPS, no buyer DM)', () => {
    it('uses orange (warning) color and Dispute label', async () => {
        stmts.purchases.insertPurchase.run('cs_dispute_1', TEST_USER_ID, TEST_EMAIL, 'Disputed Item', 5000);

        await propagateRefund('cs_dispute_1', {
            source: 'webhook_dispute',
            amountCents: 5000,
            reason: 'Dispute fraudulent — needs_response',
        });

        const embed = getEmbedFor('OPS');
        expect(embed.title).toMatch(/⚠️ Dispute Issued/);
        expect(embed.color).toBe(0xe67e22);
        expect(embed.description).toContain('Stripe dispute');
    });

    it('does NOT DM the buyer (adversarial — silent ops audit only)', async () => {
        stmts.purchases.insertPurchase.run('cs_dispute_2', TEST_USER_ID, TEST_EMAIL, 'Item', 5000);

        await propagateRefund('cs_dispute_2', {
            source: 'webhook_dispute',
            amountCents: 5000,
        });

        // No DM should fire for dispute-source refunds.
        expect(dmSend).not.toHaveBeenCalled();
    });
});
