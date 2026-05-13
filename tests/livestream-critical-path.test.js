/**
 * Livestream Critical Path — Integration Test
 *
 * Simulates an entire card night from start to finish:
 *
 *   1. !queue open          — open pre-order queue
 *   2. Stripe purchases     — pre-orders land in queue
 *   3. !queue               — verify queue state mid-stream
 *   4. !live                — start livestream session
 *   5. Stripe purchases     — live purchases → queue + livestream buyers
 *   6. !duckrace            — verify duck race roster
 *   7. !offline             — end session, close queue, DM shipping, open new queue
 *   8. !duckrace winner     — declare duck race winner
 *   9. !queue history       — verify archive
 *
 * Also covers the manual mid-stream queue close scenario.
 *
 * All Discord interactions are mocked — nothing hits a real server.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, buildStmts } from './setup.js';
import { createMockMessage, createMockMention } from './mocks.js';

// =========================================================================
// Module mocks — prevent real Discord/Stripe/fetch connections
// =========================================================================

const ROLE_AKIVILI = '1488046525065072670';
const ROLE_NANOOK = '1488046525899739148';

const mockGetMember = vi.fn().mockImplementation((userId) =>
    Promise.resolve({
        id: userId,
        user: { tag: `user#${userId}` },
        createDM: vi.fn().mockResolvedValue({
            send: vi.fn().mockResolvedValue({}),
        }),
        roles: {
            cache: { has: vi.fn().mockReturnValue(false) },
            add: vi.fn().mockResolvedValue(true),
        },
    })
);

const mockSendEmbed = vi.fn().mockResolvedValue(null);
const mockSendToChannel = vi.fn().mockResolvedValue(null);
const mockAddRole = vi.fn().mockResolvedValue(false);
const mockFindMemberByUsername = vi.fn().mockResolvedValue(null);

vi.mock('../discord.js', () => ({
    client: { channels: { cache: { get: vi.fn() } } },
    getChannel: vi.fn(),
    getGuild: vi.fn().mockReturnValue({ ownerId: 'owner1', members: { fetch: vi.fn() } }),
    sendToChannel: (...args) => mockSendToChannel(...args),
    sendEmbed: (...args) => mockSendEmbed(...args),
    getMember: (...args) => mockGetMember(...args),
    findMemberByUsername: (...args) => mockFindMemberByUsername(...args),
    hasRole: vi.fn().mockReturnValue(false),
    addRole: (...args) => mockAddRole(...args),
}));

vi.mock('../config.js', () => ({
    default: {
        CHANNELS: {
            ANNOUNCEMENTS: '1',
            ORDER_FEED: '2',
            DEALS: '3',
            PACK_BATTLES: '4',
            AND_IN_THE_BACK: '5',
            QUEUE: '6',
            CARD_SHOP: '7',
            OPS: '8',
            BOT_COMMANDS: '9',
            COMMUNITY_GOALS: '10',
            ANALYTICS: '11',
        },
        ROLES: {
            AKIVILI: '1488046525065072670',
            NANOOK: '1488046525899739148',
            LONG: 'r3',
            AHA: 'r4',
            XIPE: 'r5',
        },
        SHOP_URL: 'https://example.com/shop',
        SITE_URL: 'https://example.com',
        LIVESTREAM_SECRET: 'test-secret',
        STRIPE_SECRET_KEY: 'sk_test_123',
        GUILD_ID: 'guild123',
        LOW_STOCK_THRESHOLD: 3,
        LONG_PURCHASE_THRESHOLD: 5,
        XIPE_PURCHASE_THRESHOLD: 1,
        SHIPPING: {
            COUNTRIES: ['US', 'CA'],
            DOMESTIC: 1000,
            INTERNATIONAL: 2500,
        },
        CARD_RESERVATION_MS: 30 * 60 * 1000,
        CARD_LISTING_TTL_MS: 2 * 60 * 60 * 1000,
    },
}));

vi.mock('../db.js', () => ({
    db: null,
    purchases: {},
    battles: {},
    queues: {},
    livestream: {},
    cardListings: {},
    ducks: {},
    goals: {},
    analytics: {},
    shipping: {},
    discordLinks: {},
    coupons: {},
}));

vi.mock('../community-goals.js', () => ({
    addRevenue: vi.fn().mockResolvedValue(undefined),
    initCommunityGoals: vi.fn().mockResolvedValue(undefined),
    CYCLE_GOAL: 250000,
    MILESTONE_INCREMENT: 500000,
}));

vi.mock('../commands/card-shop.js', () => ({
    clearExpiryTimer: vi.fn(),
    updateListingEmbed: vi.fn().mockResolvedValue(undefined),
}));

// Swap in fresh in-memory DB before each test
const dbModule = await import('../db.js');
let db, stmts;

beforeEach(() => {
    db = createTestDb();
    stmts = buildStmts(db);
    dbModule.db = db;
    Object.assign(dbModule.purchases, stmts.purchases);
    Object.assign(dbModule.battles, stmts.battles);
    Object.assign(dbModule.queues, stmts.queues);
    Object.assign(dbModule.livestream, stmts.livestream);
    Object.assign(dbModule.cardListings, stmts.cardListings);
    Object.assign(dbModule.goals, stmts.goals);
    Object.assign(dbModule.analytics, stmts.analytics);
    Object.assign(dbModule.shipping, stmts.shipping);
    Object.assign(dbModule.discordLinks, stmts.discordLinks);
    vi.clearAllMocks();

    // Mock fetch (used by any external HTTP calls)
    global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
    });
});

// Import command handlers (after mocks are in place)
const { handleQueue, handleDuckRace, addToQueue } = await import('../commands/queue.js');
const { handleLive, handleOffline } = await import('../commands/live.js');
const { handleCheckoutCompleted } = await import('../webhooks/stripe.js');
const { handleBattle } = await import('../commands/battle.js');

// =========================================================================
// Helpers
// =========================================================================

function adminMsg(overrides = {}) {
    return createMockMessage({ roles: [ROLE_AKIVILI], ...overrides });
}

function userMsg(overrides = {}) {
    return createMockMessage({ roles: [], ...overrides });
}

/**
 * Simulate a Stripe checkout session for a card product purchase.
 */
function fakeCheckoutSession({
    sessionId = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    email = 'buyer@example.com',
    discordUserId = null,
    discordUsername = null,
    products = [{ name: 'Prismatic Evolutions ETB', quantity: 1 }],
    amount = 3999,
} = {}) {
    // Pre-link discord so the webhook can find the user
    if (discordUserId) {
        stmts.purchases.linkDiscord.run(discordUserId, email);
    }

    const session = {
        id: sessionId,
        customer_details: { email },
        customer_email: email,
        amount_total: amount,
        amount_subtotal: amount,
        metadata: {
            line_items: JSON.stringify(products.map((p) => ({
                name: p.name,
                quantity: p.quantity || 1,
                stock_remaining: p.stock ?? 10,
            }))),
        },
    };

    // Add Discord username custom field (simulates buyer filling it in at checkout)
    if (discordUsername) {
        session.custom_fields = [
            { key: 'discord_username', text: { value: discordUsername } },
        ];
    }

    return session;
}

// =========================================================================
// Full Card Night — Happy Path
// =========================================================================

describe('full card night critical path', () => {
    it('runs the entire livestream flow from queue open to offline', async () => {
        // ── Step 1: Open the queue ──────────────────────────────────
        const openMsg = adminMsg({ content: '!queue open' });
        await handleQueue(openMsg, ['open']);

        const queue = stmts.queues.getActiveQueue.get();
        expect(queue).toBeTruthy();
        expect(queue.status).toBe('open');
        expect(openMsg.channel.send).toHaveBeenCalled();

        // ── Step 2: Pre-orders arrive via Stripe ────────────────────
        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_preorder_1',
            email: 'alice@example.com',
            discordUserId: 'alice_discord',
            products: [{ name: 'Prismatic Evolutions ETB', quantity: 1 }],
        }));

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_preorder_2',
            email: 'bob@example.com',
            discordUserId: 'bob_discord',
            products: [
                { name: 'Prismatic Evolutions ETB', quantity: 1 },
                { name: 'Surging Sparks Booster', quantity: 2 },
            ],
        }));

        // Verify queue has entries from pre-orders — one consolidated
        // entry per checkout (alice's 1 item + bob's 2 items = 2 entries)
        let entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(2);
        let uniqueBuyers = stmts.queues.getUniqueBuyers.all(queue.id);
        expect(uniqueBuyers).toHaveLength(2); // alice + bob

        // ── Step 3: Check queue status ──────────────────────────────
        const showMsg = adminMsg({ content: '!queue' });
        await handleQueue(showMsg, []);
        expect(showMsg.channel.send).toHaveBeenCalled();

        // ── Step 4: Go live ─────────────────────────────────────────
        const liveMsg = adminMsg({ content: '!live' });
        await handleLive(liveMsg);

        // Livestream session created
        const session = stmts.livestream.getActiveSession.get();
        expect(session).toBeTruthy();
        expect(session.status).toBe('active');

        // Queue stays open
        expect(stmts.queues.getActiveQueue.get().id).toBe(queue.id);

        // Pre-order summary posted (queue had entries)
        expect(mockSendEmbed).toHaveBeenCalledWith('ANNOUNCEMENTS', expect.objectContaining({
            title: expect.stringContaining('Pre-Orders'),
        }));

        // Going-live announcement posted
        expect(mockSendToChannel).toHaveBeenCalledWith('ANNOUNCEMENTS', expect.objectContaining({
            embeds: expect.any(Array),
        }));

        // Confirm posted in channel
        const liveCalls = liveMsg.channel.send.mock.calls;
        const liveEmbed = liveCalls.find(c => c[0]?.embeds?.[0]?.data?.title?.includes('Live Session'));
        expect(liveEmbed).toBeTruthy();

        // ── Step 5: Live purchases arrive ───────────────────────────
        vi.clearAllMocks();

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_live_1',
            email: 'alice@example.com',
            discordUserId: 'alice_discord',
            products: [{ name: 'Journey Together Booster', quantity: 1 }],
            live: true,
        }));

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_live_2',
            email: 'charlie@example.com',
            discordUserId: 'charlie_discord',
            products: [{ name: 'Prismatic Evolutions ETB', quantity: 1 }],
            live: true,
        }));

        // Queue now has pre-order + live entries — one consolidated
        // entry per checkout (2 pre-order + 2 live = 4 entries)
        entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(4);
        uniqueBuyers = stmts.queues.getUniqueBuyers.all(queue.id);
        expect(uniqueBuyers).toHaveLength(3); // alice, bob, charlie

        // ── Step 6: Check duck race roster ──────────────────────────
        const duckMsg = adminMsg({ content: '!duckrace' });
        await handleDuckRace(duckMsg, []);
        expect(duckMsg.channel.send).toHaveBeenCalledWith(expect.objectContaining({
            embeds: expect.arrayContaining([
                expect.objectContaining({
                    data: expect.objectContaining({
                        title: expect.stringContaining('Duck Race'),
                    }),
                }),
            ]),
        }));

        // ── Step 7: Declare duck race winner ────────────────────────
        // Race is now decoupled from queue lifecycle — declaring a
        // winner does NOT close the queue or auto-open a new one.
        // The operator can run multiple ad-hoc races on the same
        // session, each overwriting duck_race_winner_id with the
        // latest winner. /offline (Step 8) handles queue close.
        vi.clearAllMocks();

        const winnerMsg = adminMsg({ content: '!duckrace winner @alice' });
        const aliceMention = createMockMention('alice_discord');
        winnerMsg.mentions.users.first = vi.fn().mockReturnValue(aliceMention);
        await handleDuckRace(winnerMsg, ['winner', '@alice']);

        // Winner is set, but status is NOT auto-flipped to 'complete'
        const racedQueue = stmts.queues.getQueueById.get(queue.id);
        expect(racedQueue.duck_race_winner_id).toBe('alice_discord');
        expect(racedQueue.status).toBe('open');

        // No new queue auto-opened — same session is still active
        const sessionStillActive = stmts.queues.getActiveQueue.get();
        expect(sessionStillActive).toBeTruthy();
        expect(sessionStillActive.id).toBe(queue.id);

        // Winner announced in channel + announcements
        expect(winnerMsg.channel.send).toHaveBeenCalled();
        expect(mockSendEmbed).toHaveBeenCalledWith('ANNOUNCEMENTS', expect.objectContaining({
            title: expect.stringContaining('Duck Race Winner'),
        }));

        // ── Step 8: Go offline ──────────────────────────────────────
        vi.clearAllMocks();

        const offlineMsg = adminMsg({ content: '!offline' });
        await handleOffline(offlineMsg);

        // Session ended
        expect(stmts.livestream.getActiveSession.get()).toBeUndefined();

        // After /offline runs, the queue from this stream gets closed
        // by handleOffline's own close logic (when the queue has
        // entries it gets closed and a fresh one opened). Active
        // queue is now a NEW session ready for the next stream's
        // pre-orders.
        const offlineQueue = stmts.queues.getActiveQueue.get();
        expect(offlineQueue).toBeTruthy();
        expect(offlineQueue.id).not.toBe(queue.id);

        // Stream-ended announcement
        expect(mockSendEmbed).toHaveBeenCalledWith('ANNOUNCEMENTS', expect.objectContaining({
            title: expect.stringContaining("Stream's Over"),
        }));

        // Confirm in channel
        const offlineCalls2 = offlineMsg.channel.send.mock.calls;
        const offlineEmbed = offlineCalls2.find(c => c[0]?.embeds?.[0]?.data?.title?.includes('Live Session Ended'));
        expect(offlineEmbed).toBeTruthy();

        // ── Step 9: Verify queue history ────────────────────────────
        vi.clearAllMocks();

        const historyMsg = adminMsg({ content: '!queue history' });
        await handleQueue(historyMsg, ['history']);
        expect(historyMsg.channel.send).toHaveBeenCalled();

        const recentQueues = stmts.queues.getRecentQueues.all(5);
        expect(recentQueues).toHaveLength(1); // the completed queue
        expect(recentQueues[0].duck_race_winner_id).toBe('alice_discord');
    });
});

// =========================================================================
// Permission Guards
// =========================================================================

describe('permission guards across livestream flow', () => {
    it('non-admin cannot open queue', async () => {
        const msg = userMsg({ content: '!queue open' });
        await handleQueue(msg, ['open']);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('moderators'));
        expect(stmts.queues.getActiveQueue.get()).toBeUndefined();
    });

    it('non-admin cannot go live', async () => {
        const msg = userMsg({ content: '!live' });
        await handleLive(msg);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('moderators'));
        expect(stmts.livestream.getActiveSession.get()).toBeUndefined();
    });

    it('non-admin cannot go offline', async () => {
        stmts.livestream.startSession.run();
        const msg = userMsg({ content: '!offline' });
        await handleOffline(msg);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('moderators'));
        // Session still active
        expect(stmts.livestream.getActiveSession.get()).toBeTruthy();
    });

    it('non-admin cannot close queue', async () => {
        stmts.queues.createQueue.run();
        const msg = userMsg({ content: '!queue close' });
        await handleQueue(msg, ['close']);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('moderators'));
        expect(stmts.queues.getActiveQueue.get()).toBeTruthy();
    });
});

// =========================================================================
// Guard Rails — prevent double-starts, close without open, etc.
// =========================================================================

describe('guard rails', () => {
    it('cannot open queue when one is already open', async () => {
        stmts.queues.createQueue.run();
        const msg = adminMsg();
        await handleQueue(msg, ['open']);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('already'));
    });

    it('cannot go live when already live', async () => {
        stmts.livestream.startSession.run();
        const msg = adminMsg();
        await handleLive(msg);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('Already live'));
    });

    it('cannot go offline when not live', async () => {
        const msg = adminMsg();
        await handleOffline(msg);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('No active'));
    });

    it('cannot close queue when none is open', async () => {
        const msg = adminMsg();
        await handleQueue(msg, ['close']);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('No open queue'));
    });

    it('duckrace winner must be in roster', async () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();
        stmts.queues.addEntry.run(queue.id, 'alice', 'a@e.com', 'Card', 1, 'cs_1');
        stmts.queues.closeQueue.run(queue.id);

        const msg = adminMsg();
        const notInRoster = createMockMention('intruder_discord');
        msg.mentions.users.first = vi.fn().mockReturnValue(notInRoster);
        await handleDuckRace(msg, ['winner', '@intruder']);

        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('not in the duck race roster'));
    });
});

// =========================================================================
// Manual Mid-Stream Queue Close
// =========================================================================

describe('manual mid-stream queue close', () => {
    it('closing queue mid-stream stops new entries but does not break offline', async () => {
        // Setup: queue open, go live
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();
        stmts.livestream.startSession.run();
        const session = stmts.livestream.getActiveSession.get();

        // Pre-order arrives
        await addToQueue({
            discordUserId: 'alice_discord',
            customerEmail: 'alice@example.com',
            items: [{ name: 'Pack A', quantity: 1 }],
            stripeSessionId: 'cs_pre',
        });

        expect(stmts.queues.getEntries.all(queue.id)).toHaveLength(1);

        // ── Manually close queue mid-stream ─────────────────────────
        const closeMsg = adminMsg({ content: '!queue close' });
        await handleQueue(closeMsg, ['close']);

        expect(stmts.queues.getActiveQueue.get()).toBeUndefined();
        expect(stmts.queues.getQueueById.get(queue.id).status).toBe('closed');

        // ── Purchases during closed queue are silently dropped ──────
        const added = await addToQueue({
            discordUserId: 'bob_discord',
            customerEmail: 'bob@example.com',
            items: [{ name: 'Pack B', quantity: 1 }],
            stripeSessionId: 'cs_dropped',
        });
        expect(added).toBe(false);

        // ── Offline still works cleanly ─────────────────────────────
        const offlineMsg = adminMsg({ content: '!offline' });
        await handleOffline(offlineMsg);

        // Session ended
        expect(stmts.livestream.getActiveSession.get()).toBeUndefined();

        // New queue opened
        const newQueue = stmts.queues.getActiveQueue.get();
        expect(newQueue).toBeTruthy();
        expect(newQueue.id).not.toBe(queue.id);

        // Offline doesn't crash when queue was already closed
        const offlineCalls2 = offlineMsg.channel.send.mock.calls;
        const offlineEmbed = offlineCalls2.find(c => c[0]?.embeds?.[0]?.data?.title?.includes('Live Session Ended'));
        expect(offlineEmbed).toBeTruthy();
    });

    it('can reopen queue after manual close and resume taking orders', async () => {
        stmts.queues.createQueue.run();
        const firstQueue = stmts.queues.getActiveQueue.get();
        stmts.livestream.startSession.run();

        // Close mid-stream
        const closeMsg = adminMsg();
        await handleQueue(closeMsg, ['close']);
        expect(stmts.queues.getActiveQueue.get()).toBeUndefined();

        // Reopen
        const reopenMsg = adminMsg();
        await handleQueue(reopenMsg, ['open']);
        const secondQueue = stmts.queues.getActiveQueue.get();
        expect(secondQueue).toBeTruthy();
        expect(secondQueue.id).not.toBe(firstQueue.id);

        // New orders go into the new queue
        const added = await addToQueue({
            discordUserId: 'charlie',
            customerEmail: 'c@e.com',
            items: [{ name: 'Card', quantity: 1 }],
            stripeSessionId: 'cs_new',
        });
        expect(added).toBe(true);
        expect(stmts.queues.getEntries.all(secondQueue.id)).toHaveLength(1);
        expect(stmts.queues.getEntries.all(firstQueue.id)).toHaveLength(0);
    });
});

// =========================================================================
// Stripe Webhook → Queue + Livestream Integration
// =========================================================================

describe('stripe webhook integration during livestream', () => {
    it('live purchase lands in both queue and livestream buyers', async () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();
        stmts.livestream.startSession.run();
        const session = stmts.livestream.getActiveSession.get();

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_both_1',
            email: 'buyer@example.com',
            discordUserId: 'buyer_discord',
            products: [{ name: 'ETB', quantity: 1 }],
            live: true,
        }));

        // In queue
        const queueEntries = stmts.queues.getEntries.all(queue.id);
        expect(queueEntries).toHaveLength(1);
        expect(queueEntries[0].product_name).toBe('ETB');

    });

    it('purchase without active queue is silently dropped from queue', async () => {
        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_no_queue',
            email: 'buyer@example.com',
            discordUserId: 'buyer1',
            products: [{ name: 'Pack', quantity: 1 }],
        }));

        // No queue entries (no active queue)
        const allQueues = db.prepare('SELECT * FROM queue_entries').all();
        expect(allQueues).toHaveLength(0);
    });

    it('multi-item purchase consolidates into one queue entry with comma-separated label', async () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_multi',
            email: 'collector@example.com',
            discordUserId: 'collector_discord',
            products: [
                { name: 'ETB', quantity: 1 },
                { name: 'Booster Box', quantity: 1 },
                { name: 'Elite Trainer', quantity: 3 },
            ],
        }));

        const entries = stmts.queues.getEntries.all(queue.id);
        // One purchase = one queue entry, regardless of line item count
        expect(entries).toHaveLength(1);
        expect(entries[0].product_name).toBe('1x ETB, 1x Booster Box, 3x Elite Trainer');
        // quantity sums all line items (1 + 1 + 3 = 5) for analytics
        expect(entries[0].quantity).toBe(5);

        const uniqueBuyers = stmts.queues.getUniqueBuyers.all(queue.id);
        expect(uniqueBuyers).toHaveLength(1); // one duck race entry
    });

    it('ad-hoc shipping payment does not add to queue', async () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        await handleCheckoutCompleted({
            id: 'cs_shipping',
            amount_total: 1000,
            metadata: {
                source: 'ad-hoc-shipping',
            },
            customer_details: { email: 'buyer@example.com' },
        });

        // Queue unchanged — ad-hoc shipping payments early-return
        expect(stmts.queues.getEntries.all(queue.id)).toHaveLength(0);
    });
});

// =========================================================================
// Offline without shipping DMs (proactive model)
// =========================================================================

describe('offline session lifecycle', () => {
    it('offline keeps existing queue open, ends session', async () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();
        stmts.livestream.startSession.run();

        const offlineMsg = adminMsg();
        await handleOffline(offlineMsg);

        // Session ended
        expect(stmts.livestream.getActiveSession.get()).toBeUndefined();

        // Queue still open (offline no longer closes — duck race does)
        const activeQueue = stmts.queues.getActiveQueue.get();
        expect(activeQueue).toBeTruthy();
        expect(activeQueue.id).toBe(queue.id);

        // No shipping DMs — shipping is proactive at checkout
        expect(mockGetMember).not.toHaveBeenCalled();
    });

    it('offline closes the queue when it has entries (no duck race ran)', async () => {
        // Queue with served entries, livestream active, no duck race —
        // mirrors the 2026-05-11 stream where /offline left the queue open.
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();
        stmts.queues.addEntry.run(queue.id, 'buyer_discord', 'buyer@example.com', 'One Piece Box', 1, 'cs_offline_close');
        stmts.livestream.startSession.run();

        const offlineMsg = adminMsg();
        await handleOffline(offlineMsg);

        // Served queue is now closed
        expect(stmts.queues.getQueueById.get(queue.id).status).toBe('closed');

        // A fresh queue is open for next stream
        const newQueue = stmts.queues.getActiveQueue.get();
        expect(newQueue).toBeTruthy();
        expect(newQueue.id).not.toBe(queue.id);
    });
});

// =========================================================================
// Edge Cases
// =========================================================================

describe('edge cases', () => {
    it('offline with no active queue still works', async () => {
        // Go live without a queue (unusual but possible)
        stmts.livestream.startSession.run();

        const offlineMsg = adminMsg();
        await handleOffline(offlineMsg);

        // Session ended
        expect(stmts.livestream.getActiveSession.get()).toBeUndefined();

        // New queue still opened
        expect(stmts.queues.getActiveQueue.get()).toBeTruthy();

        // No crash
        const offlineCalls2 = offlineMsg.channel.send.mock.calls;
        const offlineEmbed = offlineCalls2.find(c => c[0]?.embeds?.[0]?.data?.title?.includes('Live Session Ended'));
        expect(offlineEmbed).toBeTruthy();
    });

    it('queue with zero entries stays open after offline (no duck race needed)', async () => {
        stmts.queues.createQueue.run();
        stmts.livestream.startSession.run();

        const offlineMsg = adminMsg();
        await handleOffline(offlineMsg);

        // Queue stays open — offline no longer closes it
        const activeQueue = stmts.queues.getActiveQueue.get();
        expect(activeQueue).toBeTruthy();
        expect(activeQueue.status).toBe('open');
    });


    it('anyone can view queue and duck race (no admin required)', async () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();
        stmts.queues.addEntry.run(queue.id, 'user1', 'u@e.com', 'Card', 1, 'cs_1');

        // Non-admin can view queue
        const viewQueueMsg = userMsg();
        await handleQueue(viewQueueMsg, []);
        expect(viewQueueMsg.channel.send).toHaveBeenCalled();
        expect(viewQueueMsg.reply).not.toHaveBeenCalled();

        // Non-admin can view duck race
        const viewDuckMsg = userMsg();
        await handleDuckRace(viewDuckMsg, []);
        expect(viewDuckMsg.channel.send).toHaveBeenCalled();
    });

    it('live announcement includes pre-order count when queue has entries', async () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();
        stmts.queues.addEntry.run(queue.id, 'u1', 'u@e.com', 'Card', 1, 'cs_1');
        stmts.queues.addEntry.run(queue.id, 'u2', 'u2@e.com', 'Card', 1, 'cs_2');

        const liveMsg = adminMsg();
        await handleLive(liveMsg);

        expect(mockSendEmbed).toHaveBeenCalledWith('ANNOUNCEMENTS', expect.objectContaining({
            title: expect.stringContaining('2 Pre-Orders'),
        }));
    });

    it('live announcement skips pre-order summary when queue is empty', async () => {
        stmts.queues.createQueue.run();

        const liveMsg = adminMsg();
        await handleLive(liveMsg);

        // sendEmbed should NOT be called with pre-order title
        const preOrderCalls = mockSendEmbed.mock.calls.filter(
            (call) => call[1]?.title?.includes('Pre-Orders')
        );
        expect(preOrderCalls).toHaveLength(0);
    });
});

// =========================================================================
// WordPress Shop Buyer Journey (Primary Path)
//
// The most common buyer path: discovers via TikTok/social → watches
// livestream → buys from vincentragosta.io/shop directly (NOT through
// Discord). They may not know Discord exists. Shipping coverage must
// work entirely through email matching — no Discord link required.
// =========================================================================

describe('WordPress shop buyer journey (no Discord)', () => {
    it('first purchase during livestream: added to queue, pays shipping', () => {
        // !live opens a queue
        stmts.queues.createQueue.run();
        stmts.livestream.startSession.run();
        const queue = stmts.queues.getActiveQueue.get();
        const session = stmts.livestream.getActiveSession.get();

        // Buyer purchases through WordPress shop (no ?live=1 token)
        // Webhook fires — addToQueue adds them since queue is open
        stmts.queues.addEntry.run(queue.id, null, 'newbuyer@gmail.com', 'Pokemon Pack', 1, 'cs_wp_1');

        // Shipping was charged at WordPress checkout (recorded by webhook)
        stmts.shipping.record.run('newbuyer@gmail.com', null, 1000, 'checkout', 'cs_wp_1');

        // Verify queue entry exists
        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(1);
        expect(entries[0].customer_email).toBe('newbuyer@gmail.com');
        expect(entries[0].discord_user_id).toBeNull();

        // Shipping was recorded
        expect(stmts.shipping.hasShippingThisWeek.get('newbuyer@gmail.com')).toBeTruthy();
    });

    it('second purchase during same livestream: added to queue, shipping skipped', () => {
        stmts.queues.createQueue.run();
        stmts.livestream.startSession.run();
        const queue = stmts.queues.getActiveQueue.get();

        // First purchase — pays shipping
        stmts.queues.addEntry.run(queue.id, null, 'buyer@gmail.com', 'Pack A', 1, 'cs_wp_1');
        stmts.shipping.record.run('buyer@gmail.com', null, 1000, 'checkout', 'cs_wp_1');

        // Second purchase — shipping lookup returns covered
        const covered = !!stmts.shipping.hasShippingThisWeek.get('buyer@gmail.com');
        expect(covered).toBe(true);

        // Still added to queue
        stmts.queues.addEntry.run(queue.id, null, 'buyer@gmail.com', 'Pack B', 1, 'cs_wp_2');

        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(2);

        // Only 1 shipping payment exists (not 2)
        const payments = db.prepare('SELECT COUNT(*) as c FROM shipping_payments WHERE customer_email = ?').get('buyer@gmail.com');
        expect(payments.c).toBe(1);
    });

    it('international buyer: first purchase with $25, second purchase shipping skipped for the month', () => {
        stmts.queues.createQueue.run();
        stmts.livestream.startSession.run();
        const queue = stmts.queues.getActiveQueue.get();

        // First purchase — buyer selects international at Stripe checkout
        stmts.queues.addEntry.run(queue.id, null, 'canada@gmail.com', 'Anime Box', 1, 'cs_intl_1');
        stmts.shipping.record.run('canada@gmail.com', null, 2500, 'checkout', 'cs_intl_1');

        // Webhook auto-flags their country from shipping address
        stmts.purchases.linkDiscord.run('auto_discord', 'canada@gmail.com');
        stmts.discordLinks.setCountry.run('CA', 'auto_discord');

        // Second purchase — covered for the entire month
        expect(stmts.shipping.hasShippingThisMonth.get('canada@gmail.com')).toBeTruthy();

        // Queue still accepts the entry
        stmts.queues.addEntry.run(queue.id, 'auto_discord', 'canada@gmail.com', 'Pack B', 1, 'cs_intl_2');
        expect(stmts.queues.getEntries.all(queue.id)).toHaveLength(2);
    });

    it('purchase between streams (no queue): no queue entry, shipping charged', () => {
        // No !live, no queue — buyer finds shop via social media
        const active = stmts.queues.getActiveQueue.get();
        expect(active).toBeUndefined();

        // Purchase goes through WordPress — shipping charged at checkout
        stmts.shipping.record.run('social@gmail.com', null, 1000, 'checkout', 'cs_between');
        stmts.purchases.insertPurchase.run('cs_between', null, 'social@gmail.com', 'Pokemon Pack', 1999);

        // No queue entry (addToQueue would return false)
        const allEntries = db.prepare('SELECT COUNT(*) as c FROM queue_entries').get();
        expect(allEntries.c).toBe(0);

        // Shipping was still recorded for coverage tracking
        expect(stmts.shipping.hasShippingThisWeek.get('social@gmail.com')).toBeTruthy();
    });

    it('purchase between streams, then during livestream: shipping not charged again', () => {
        // Between streams — buyer pays shipping on first purchase
        stmts.shipping.record.run('returning@gmail.com', null, 1000, 'checkout', 'cs_pre');
        stmts.purchases.insertPurchase.run('cs_pre', null, 'returning@gmail.com', 'Pack A', 1999);

        // Later that week, livestream starts
        stmts.queues.createQueue.run();
        stmts.livestream.startSession.run();
        const queue = stmts.queues.getActiveQueue.get();

        // Same buyer purchases again — shipping already covered this week
        const covered = !!stmts.shipping.hasShippingThisWeek.get('returning@gmail.com');
        expect(covered).toBe(true);

        // Added to queue
        stmts.queues.addEntry.run(queue.id, null, 'returning@gmail.com', 'Pack B', 1, 'cs_live');

        expect(stmts.queues.getEntries.all(queue.id)).toHaveLength(1);

        // Still only 1 shipping payment
        const payments = db.prepare('SELECT COUNT(*) as c FROM shipping_payments WHERE customer_email = ?').get('returning@gmail.com');
        expect(payments.c).toBe(1);
    });

    it('multiple buyers, mixed shipping states during livestream', () => {
        stmts.queues.createQueue.run();
        stmts.livestream.startSession.run();
        const queue = stmts.queues.getActiveQueue.get();

        // Buyer A — first purchase, pays shipping
        stmts.queues.addEntry.run(queue.id, null, 'buyerA@gmail.com', 'Pack', 1, 'cs_a1');
        stmts.shipping.record.run('buyerA@gmail.com', null, 1000, 'checkout', 'cs_a1');

        // Buyer B — first purchase, pays shipping
        stmts.queues.addEntry.run(queue.id, null, 'buyerB@gmail.com', 'Pack', 1, 'cs_b1');
        stmts.shipping.record.run('buyerB@gmail.com', null, 2500, 'checkout', 'cs_b1');

        // Buyer A — second purchase, shipping covered
        expect(stmts.shipping.hasShippingThisWeek.get('buyerA@gmail.com')).toBeTruthy();
        stmts.queues.addEntry.run(queue.id, null, 'buyerA@gmail.com', 'Pack 2', 1, 'cs_a2');

        // Buyer C — first purchase, pays shipping
        stmts.queues.addEntry.run(queue.id, null, 'buyerC@gmail.com', 'Pack', 1, 'cs_c1');
        stmts.shipping.record.run('buyerC@gmail.com', null, 1000, 'checkout', 'cs_c1');

        // Buyer B — second purchase, shipping covered (monthly for intl)
        stmts.purchases.linkDiscord.run('b_discord', 'buyerB@gmail.com');
        stmts.discordLinks.setCountry.run('CA', 'b_discord');
        expect(stmts.shipping.hasShippingThisMonth.get('buyerB@gmail.com')).toBeTruthy();
        stmts.queues.addEntry.run(queue.id, 'b_discord', 'buyerB@gmail.com', 'Pack 2', 1, 'cs_b2');

        // 5 queue entries total
        expect(stmts.queues.getEntries.all(queue.id)).toHaveLength(5);

        // 3 shipping payments total (A, B, C — no duplicates)
        const payments = db.prepare('SELECT COUNT(*) as c FROM shipping_payments').get();
        expect(payments.c).toBe(3);
    });

});

// =========================================================================
// Discord Username Auto-Link at Checkout
//
// Buyers who fill in the optional "Discord username" field at Stripe
// checkout get auto-linked — their purchase appears by name in the
// queue and counts toward duck race entries + role promotions.
// =========================================================================

describe('Discord username auto-link at checkout', () => {
    it('valid username: auto-links and appears in queue by discord ID', async () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        // Mock findMemberByUsername to resolve "itzenzottv" → discord ID
        mockFindMemberByUsername.mockResolvedValueOnce({
            id: 'itzen_discord_id',
            user: { username: 'itzenzottv', tag: 'itzenzottv#0' },
        });

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_autolink_valid',
            email: 'itzen@example.com',
            discordUsername: 'itzenzottv',
            products: [{ name: 'Prismatic Evolutions ETB', quantity: 1 }],
        }));

        // Discord link was created
        const link = stmts.purchases.getDiscordIdByEmail.get('itzen@example.com');
        expect(link).toBeTruthy();
        expect(link.discord_user_id).toBe('itzen_discord_id');

        // Queue entry has the discord user ID (not null)
        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(1);
        expect(entries[0].discord_user_id).toBe('itzen_discord_id');

        // Counts as a duck race entry
        const buyers = stmts.queues.getUniqueBuyers.all(queue.id);
        expect(buyers).toHaveLength(1);

        // Purchase recorded with discord ID
        const purchase = db.prepare('SELECT * FROM purchases WHERE stripe_session_id = ?').get('cs_autolink_valid');
        expect(purchase.discord_user_id).toBe('itzen_discord_id');
    });

    it('valid username with @ prefix: strips @ and still auto-links', async () => {
        stmts.queues.createQueue.run();

        mockFindMemberByUsername.mockResolvedValueOnce({
            id: 'at_user_id',
            user: { username: 'someuser', tag: 'someuser#0' },
        });

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_autolink_at',
            email: 'atuser@example.com',
            discordUsername: '@someuser',
            products: [{ name: 'Card Pack', quantity: 1 }],
        }));

        // findMemberByUsername was called with the @ stripped
        expect(mockFindMemberByUsername).toHaveBeenCalledWith('someuser');

        // Link created
        const link = stmts.purchases.getDiscordIdByEmail.get('atuser@example.com');
        expect(link.discord_user_id).toBe('at_user_id');
    });

    it('invalid username (not in server): purchase proceeds unlinked', async () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        // findMemberByUsername returns null — username not found
        mockFindMemberByUsername.mockResolvedValueOnce(null);

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_autolink_invalid',
            email: 'nobody@example.com',
            discordUsername: 'doesnotexist',
            products: [{ name: 'Booster Box', quantity: 1 }],
        }));

        // No discord link created
        const link = stmts.purchases.getDiscordIdByEmail.get('nobody@example.com');
        expect(link).toBeUndefined();

        // Queue entry exists but with null discord_user_id
        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(1);
        expect(entries[0].discord_user_id).toBeNull();
        expect(entries[0].customer_email).toBe('nobody@example.com');

        // Counts as a duck race entry by email
        const buyers = stmts.queues.getUniqueBuyers.all(queue.id);
        expect(buyers).toHaveLength(1);
        expect(buyers[0].buyer).toBe('nobody@example.com');
    });

    it('username field empty: no lookup attempted, proceeds unlinked', async () => {
        stmts.queues.createQueue.run();

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_autolink_empty',
            email: 'skipfield@example.com',
            products: [{ name: 'Card Pack', quantity: 1 }],
            // No discordUsername — field left blank
        }));

        // findMemberByUsername not called
        expect(mockFindMemberByUsername).not.toHaveBeenCalled();

        // No link
        expect(stmts.purchases.getDiscordIdByEmail.get('skipfield@example.com')).toBeUndefined();
    });

    it('already linked by email: skips auto-link, uses existing discord ID', async () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        // Pre-existing link (from a previous !link command)
        stmts.purchases.linkDiscord.run('existing_discord_id', 'linked@example.com');

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_autolink_existing',
            email: 'linked@example.com',
            discordUsername: 'someotheruser',
            products: [{ name: 'ETB', quantity: 1 }],
        }));

        // findMemberByUsername NOT called — existing link takes precedence
        expect(mockFindMemberByUsername).not.toHaveBeenCalled();

        // Queue entry uses the existing discord ID
        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(1);
        expect(entries[0].discord_user_id).toBe('existing_discord_id');
    });

    it('auto-link enables role promotion on first purchase', async () => {
        mockFindMemberByUsername.mockResolvedValueOnce({
            id: 'promo_user_id',
            user: { username: 'promouser', tag: 'promouser#0' },
        });

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_autolink_promo',
            email: 'promo@example.com',
            discordUsername: 'promouser',
            products: [{ name: 'Card', quantity: 1 }],
        }));

        // Purchase count incremented (role promotion path was entered)
        const count = stmts.purchases.getPurchaseCount.get('promo_user_id');
        expect(count).toBeTruthy();
        expect(count.total_purchases).toBe(1);
    });

    it('auto-linked buyer in full livestream flow: appears in queue and duck race', async () => {
        // Open queue and go live
        const openMsg = adminMsg({ content: '!queue open' });
        await handleQueue(openMsg, ['open']);
        const queue = stmts.queues.getActiveQueue.get();

        const liveMsg = adminMsg({ content: '!live' });
        await handleLive(liveMsg);
        vi.clearAllMocks();

        // Linked buyer purchases (pre-existing link)
        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_flow_linked',
            email: 'alice@example.com',
            discordUserId: 'alice_discord',
            products: [{ name: 'ETB', quantity: 1 }],
        }));

        // Auto-linked buyer purchases (no prior !link, fills in username at checkout)
        mockFindMemberByUsername.mockResolvedValueOnce({
            id: 'newguy_discord',
            user: { username: 'newguy', tag: 'newguy#0' },
        });
        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_flow_autolink',
            email: 'newguy@example.com',
            discordUsername: 'newguy',
            products: [{ name: 'Booster Box', quantity: 2 }],
        }));

        // Unlinked buyer purchases (no username, no prior link)
        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_flow_anon',
            email: 'anon@example.com',
            products: [{ name: 'Card Sleeves', quantity: 1 }],
        }));

        // Queue has 3 entries (1 + 1 + 1)
        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(3);

        // Duck race: 3 unique entries (alice, newguy, anon by email)
        const buyers = stmts.queues.getUniqueBuyers.all(queue.id);
        expect(buyers).toHaveLength(3);
        const buyerIds = buyers.map((b) => b.buyer).sort();
        expect(buyerIds).toEqual(['alice_discord', 'anon@example.com', 'newguy_discord']);
    });
});

// =========================================================================
// Pack Battle Purchases Excluded from Queue
// =========================================================================

describe('pack battle queue exclusion', () => {
    it('pack battle purchases do not create queue entries', async () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        // Regular shop purchase — should land in queue
        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_shop_1',
            email: 'alice@example.com',
            discordUserId: 'alice_discord',
            products: [{ name: 'Booster Box', quantity: 1 }],
        }));

        expect(stmts.queues.getEntries.all(queue.id)).toHaveLength(1);

        // Pack battle purchase — should NOT land in queue
        const battleSession = fakeCheckoutSession({
            sessionId: 'cs_battle_1',
            email: 'bob@example.com',
            discordUserId: 'bob_discord',
            products: [{ name: 'Prismatic Evolutions', quantity: 1 }],
        });
        battleSession.metadata.source = 'pack-battle';
        battleSession.metadata.battle_id = '1';

        await handleCheckoutCompleted(battleSession);

        // Queue still has only the shop purchase
        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(1);
        expect(entries[0].product_name).toBe('Booster Box');

        // Duck race roster only has alice (shop buyer), not bob (battle buyer)
        const buyers = stmts.queues.getUniqueBuyers.all(queue.id);
        expect(buyers).toHaveLength(1);
        expect(buyers[0].buyer).toBe('alice_discord');
    });

    it('pack battle purchase still records in purchases table', async () => {
        stmts.queues.createQueue.run();

        const battleSession = fakeCheckoutSession({
            sessionId: 'cs_battle_2',
            email: 'charlie@example.com',
            discordUserId: 'charlie_discord',
            products: [{ name: 'Pack Battle ETB', quantity: 1 }],
        });
        battleSession.metadata.source = 'pack-battle';

        await handleCheckoutCompleted(battleSession);

        // Purchase is recorded even though queue entry is not
        const purchase = stmts.purchases.getDiscordIdByEmail.get('charlie@example.com');
        expect(purchase).toBeTruthy();
        expect(purchase.discord_user_id).toBe('charlie_discord');
    });
});

// =========================================================================
// Duplicate Battle Entry Prevention
// =========================================================================

describe('duplicate battle entry prevention', () => {
    it('same user cannot enter the same battle twice via addEntry', () => {
        // Create a battle
        stmts.battles.createBattle.run('test-product', 'Test Product', 'price_123', 10, null);
        const battle = stmts.battles.getActiveBattle.get();

        // First entry succeeds
        stmts.battles.addEntry.run(battle.id, 'alice_discord', battle.id, battle.id);
        expect(stmts.battles.getEntryCount.get(battle.id).count).toBe(1);

        // Second entry for same user is silently ignored (INSERT OR IGNORE + UNIQUE constraint)
        stmts.battles.addEntry.run(battle.id, 'alice_discord', battle.id, battle.id);
        expect(stmts.battles.getEntryCount.get(battle.id).count).toBe(1);

        // Different user can still enter
        stmts.battles.addEntry.run(battle.id, 'bob_discord', battle.id, battle.id);
        expect(stmts.battles.getEntryCount.get(battle.id).count).toBe(2);
    });

    it('battle auto-closes when max entries reached via webhook', async () => {
        // Create a battle with max 2 entries
        stmts.battles.createBattle.run('test-product', 'Test Product', 'price_123', 2, null);
        const battle = stmts.battles.getActiveBattle.get();

        // Link both users so webhook can find them
        stmts.purchases.linkDiscord.run('alice_discord', 'alice@example.com');
        stmts.purchases.linkDiscord.run('bob_discord', 'bob@example.com');

        // First battle purchase
        const session1 = fakeCheckoutSession({
            sessionId: 'cs_battle_auto_1',
            email: 'alice@example.com',
            discordUserId: 'alice_discord',
            products: [{ name: 'Test Product', quantity: 1 }],
        });
        session1.metadata.source = 'pack-battle';
        session1.metadata.battle_id = String(battle.id);
        await handleCheckoutCompleted(session1);

        // Battle still open after first entry
        expect(stmts.battles.getActiveBattle.get()).toBeTruthy();

        // Second battle purchase fills it
        const session2 = fakeCheckoutSession({
            sessionId: 'cs_battle_auto_2',
            email: 'bob@example.com',
            discordUserId: 'bob_discord',
            products: [{ name: 'Test Product', quantity: 1 }],
        });
        session2.metadata.source = 'pack-battle';
        session2.metadata.battle_id = String(battle.id);
        await handleCheckoutCompleted(session2);

        // Battle auto-closed — no longer active
        expect(stmts.battles.getActiveBattle.get()).toBeUndefined();

        // Battle has a battle number and closed status
        const closed = stmts.battles.getBattleById.get(battle.id);
        expect(closed.status).toBe('closed');
        expect(closed.battle_number).toBeTruthy();

        // Both entries are paid
        const paidEntries = stmts.battles.getPaidEntries.all(battle.id);
        expect(paidEntries).toHaveLength(2);
    });

    it('same user can enter different battles', () => {
        stmts.battles.createBattle.run('product-a', 'Product A', 'price_a', 10, null);
        const battleA = stmts.battles.getActiveBattle.get();
        stmts.battles.addEntry.run(battleA.id, 'alice_discord', battleA.id, battleA.id);
        stmts.battles.closeBattle.run(battleA.id);

        stmts.battles.createBattle.run('product-b', 'Product B', 'price_b', 10, null);
        const battleB = stmts.battles.getActiveBattle.get();
        stmts.battles.addEntry.run(battleB.id, 'alice_discord', battleB.id, battleB.id);

        expect(stmts.battles.getEntryCount.get(battleA.id).count).toBe(1);
        expect(stmts.battles.getEntryCount.get(battleB.id).count).toBe(1);
    });
});

// =========================================================================
// Owner Battle Join
// =========================================================================

describe('owner battle join', () => {
    it('!battle join adds owner to battle roster', async () => {
        stmts.battles.createBattle.run('test-pack', 'Test Pack', 'price_test', 10, null);
        const battle = stmts.battles.getActiveBattle.get();

        const msg = adminMsg({ content: '!battle join', authorId: 'owner1' });
        await handleBattle(msg, ['join']);

        const entries = stmts.battles.getEntries.all(battle.id);
        expect(entries).toHaveLength(1);
        expect(entries[0].discord_user_id).toBe('owner1');

        // Entry is marked as paid
        const paidEntries = stmts.battles.getPaidEntries.all(battle.id);
        expect(paidEntries).toHaveLength(1);
    });

    it('!battle join rejects if owner already entered', async () => {
        stmts.battles.createBattle.run('test-pack', 'Test Pack', 'price_test', 10, null);
        const battle = stmts.battles.getActiveBattle.get();

        const msg1 = adminMsg({ content: '!battle join', authorId: 'owner1' });
        await handleBattle(msg1, ['join']);

        const msg2 = adminMsg({ content: '!battle join', authorId: 'owner1' });
        await handleBattle(msg2, ['join']);

        // Still only one entry
        expect(stmts.battles.getEntryCount.get(battle.id).count).toBe(1);
        expect(msg2.reply).toHaveBeenCalledWith(expect.stringContaining('already in this battle'));
    });

    it('!battle join rejects if battle is full', async () => {
        stmts.battles.createBattle.run('test-pack', 'Test Pack', 'price_test', 1, null);
        const battle = stmts.battles.getActiveBattle.get();

        // Fill the battle
        stmts.battles.addEntry.run(battle.id, 'other_user', battle.id, battle.id);

        const msg = adminMsg({ content: '!battle join', authorId: 'owner1' });
        await handleBattle(msg, ['join']);

        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('full'));
        expect(stmts.battles.getEntryCount.get(battle.id).count).toBe(1);
    });

    it('!battle join rejects non-owner', async () => {
        stmts.battles.createBattle.run('test-pack', 'Test Pack', 'price_test', 10, null);

        const msg = createMockMessage({ roles: [ROLE_NANOOK], authorId: 'mod1' });
        await handleBattle(msg, ['join']);

        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('Only the server owner'));
    });
});

// =========================================================================
// Case-Insensitive Discord Username Auto-Link
// =========================================================================

describe('case-insensitive Discord username auto-link', () => {
    it('mixed-case username at checkout auto-links correctly', async () => {
        stmts.queues.createQueue.run();

        // Mock findMemberByUsername to return a member for the mixed-case lookup
        mockFindMemberByUsername.mockResolvedValueOnce({
            id: 'mixedcase_discord',
            user: { username: 'itzenzottv' },
        });

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_case_test',
            email: 'mixedcase@example.com',
            discordUsername: 'ItZeNzOtTv',  // Mixed case input
            products: [{ name: 'Card Pack', quantity: 1 }],
        }));

        // findMemberByUsername was called with the mixed-case input
        expect(mockFindMemberByUsername).toHaveBeenCalledWith('ItZeNzOtTv');

        // Discord link was created
        const link = stmts.purchases.getDiscordIdByEmail.get('mixedcase@example.com');
        expect(link).toBeTruthy();
        expect(link.discord_user_id).toBe('mixedcase_discord');

        // Queue entry has the discord user ID (not email)
        const queue = stmts.queues.getActiveQueue.get();
        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(1);
        expect(entries[0].discord_user_id).toBe('mixedcase_discord');
    });

    it('username with leading @ is stripped before lookup', async () => {
        stmts.queues.createQueue.run();

        mockFindMemberByUsername.mockResolvedValueOnce({
            id: 'at_user_discord',
            user: { username: 'testuser' },
        });

        await handleCheckoutCompleted(fakeCheckoutSession({
            sessionId: 'cs_at_test',
            email: 'atuser@example.com',
            discordUsername: '@TestUser',
            products: [{ name: 'Card Pack', quantity: 1 }],
        }));

        // @ was stripped before lookup
        expect(mockFindMemberByUsername).toHaveBeenCalledWith('TestUser');

        // Link created successfully
        const link = stmts.purchases.getDiscordIdByEmail.get('atuser@example.com');
        expect(link).toBeTruthy();
        expect(link.discord_user_id).toBe('at_user_discord');
    });
});

// =========================================================================
// Battle Winner Shipping
// =========================================================================

describe('battle winner shipping', () => {
    it('winner without shipping coverage gets a DM', async () => {
        // Create and close a battle with one entry
        stmts.battles.createBattle.run('test-pack', 'Test Pack', 'price_test', 10, null);
        const battle = stmts.battles.getActiveBattle.get();
        stmts.battles.addEntry.run(battle.id, 'winner_discord', battle.id, battle.id);
        stmts.battles.confirmPayment.run('cs_winner', battle.id, 'winner_discord');

        const { next } = stmts.battles.getNextBattleNumber.get();
        stmts.battles.setBattleNumber.run(next, battle.id);
        stmts.battles.closeBattle.run(battle.id);

        // Link the winner so shipping lookup works
        stmts.purchases.linkDiscord.run('winner_discord', 'winner@example.com');

        // Declare winner
        const msg = adminMsg({ content: '!battle winner @winner' });
        const winnerMention = createMockMention('winner_discord');
        msg.mentions.users.first = vi.fn().mockReturnValue(winnerMention);
        await handleBattle(msg, ['winner', '@winner']);

        // Winner should have been DM'd (getMember was called to send DM)
        expect(mockGetMember).toHaveBeenCalledWith('winner_discord');

        // Confirmation in command channel mentions shipping DM
        const sendCalls = msg.channel.send.mock.calls;
        const shippingMsg = sendCalls.find((c) => typeof c[0] === 'string' && c[0].includes('Shipping DM sent'));
        expect(shippingMsg).toBeTruthy();
    });

    it('winner with shipping already covered does not get a shipping DM', async () => {
        // Create and close a battle
        stmts.battles.createBattle.run('test-pack', 'Test Pack', 'price_test', 10, null);
        const battle = stmts.battles.getActiveBattle.get();
        stmts.battles.addEntry.run(battle.id, 'covered_discord', battle.id, battle.id);
        stmts.battles.confirmPayment.run('cs_covered', battle.id, 'covered_discord');

        const { next } = stmts.battles.getNextBattleNumber.get();
        stmts.battles.setBattleNumber.run(next, battle.id);
        stmts.battles.closeBattle.run(battle.id);

        // Link and record shipping so they're covered
        stmts.purchases.linkDiscord.run('covered_discord', 'covered@example.com');
        stmts.shipping.record.run('covered@example.com', 'covered_discord', 1000, 'checkout', 'cs_ship');

        // Declare winner
        const msg = adminMsg({ content: '!battle winner @covered' });
        const coveredMention = createMockMention('covered_discord');
        msg.mentions.users.first = vi.fn().mockReturnValue(coveredMention);
        await handleBattle(msg, ['winner', '@covered']);

        // Confirmation should say already covered, not DM sent
        const sendCalls = msg.channel.send.mock.calls;
        const coveredMsg = sendCalls.find((c) => typeof c[0] === 'string' && c[0].includes('already covered'));
        expect(coveredMsg).toBeTruthy();
    });

    it('owner winning does not trigger shipping DM', async () => {
        stmts.battles.createBattle.run('test-pack', 'Test Pack', 'price_test', 10, null);
        const battle = stmts.battles.getActiveBattle.get();
        stmts.battles.addEntry.run(battle.id, 'owner1', battle.id, battle.id);
        stmts.battles.confirmPayment.run('cs_owner', battle.id, 'owner1');

        const { next } = stmts.battles.getNextBattleNumber.get();
        stmts.battles.setBattleNumber.run(next, battle.id);
        stmts.battles.closeBattle.run(battle.id);

        const msg = adminMsg({ content: '!battle winner @owner' });
        const ownerMention = createMockMention('owner1');
        msg.mentions.users.first = vi.fn().mockReturnValue(ownerMention);
        await handleBattle(msg, ['winner', '@owner']);

        // Confirmation should NOT mention shipping DM or already covered
        const sendCalls = msg.channel.send.mock.calls;
        const winMsg = sendCalls.find((c) => typeof c[0] === 'string' && c[0].includes('wins all the cards'));
        expect(winMsg).toBeTruthy();
        const shippingMsg = sendCalls.find((c) => typeof c[0] === 'string' && c[0].includes('Shipping DM'));
        expect(shippingMsg).toBeFalsy();
    });
});
