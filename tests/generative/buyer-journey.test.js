/**
 * Generative buyer-journey testing — Phase 4 (light).
 *
 * Strings together random sequences of buyer actions (successful purchase,
 * webhook retry, full refund, partial refund, multi-line order) against
 * the same handler boundaries our contract tests use. Asserts a small set
 * of invariants after each step. fast-check generates the sequences,
 * shrinks failures to the minimal reproducer, and surfaces seeds that
 * can be replayed forever.
 *
 * Lighter than the original Phase 4 plan: runs in pure Node via vitest
 * with mocked Discord/queue/ShippingEasy boundaries — the SAME boundaries
 * exercised by checkout-completed-flows.test.js. Trade-off: doesn't
 * exercise the browser / WP / real Stripe round-trip. Phase 4-full would
 * extend this to drive Playwright actions.
 *
 * Default: 50 journeys × max 20 commands = up to 1,000 randomized
 * actions per CI run, ~6 invariant checks per step = ~6,000 invariant
 * assertions. Failing seeds save to tests/generative/seeds/.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, buildStmts } from '../setup.js';
import { checkoutSessionCompleted } from '../fixtures/stripe-events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_BUYERS = ['buyer_alpha', 'buyer_beta', 'buyer_gamma'];

// ============================================================================
// Module mocks — same shape as checkout-completed-flows.test.js so the
// generative runner exercises the real handler logic without needing the
// rest of the bot's runtime to boot.
// ============================================================================

const mockSendEmbed = vi.fn().mockResolvedValue(null);
const mockSendToChannel = vi.fn().mockResolvedValue(null);
const mockGetMember = vi.fn().mockImplementation((userId) =>
    Promise.resolve({
        id: userId,
        user: { id: userId, tag: `user#${userId}`, username: `user-${userId}` },
        roles: { cache: { has: () => false } },
        createDM: vi.fn().mockResolvedValue({ send: vi.fn().mockResolvedValue({}) }),
    }),
);
const mockAddRole = vi.fn().mockResolvedValue(true);
const mockHasRole = vi.fn().mockReturnValue(false);
const mockFindMemberByUsername = vi.fn().mockResolvedValue(null);

vi.mock('../../discord.js', () => ({
    sendEmbed: (...a) => mockSendEmbed(...a),
    sendToChannel: (...a) => mockSendToChannel(...a),
    getMember: (...a) => mockGetMember(...a),
    addRole: (...a) => mockAddRole(...a),
    hasRole: (...a) => mockHasRole(...a),
    findMemberByUsername: (...a) => mockFindMemberByUsername(...a),
    getGuild: vi.fn().mockReturnValue(null),
    client: { channels: { cache: new Map() } },
}));

vi.mock('../../config.js', () => ({
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

vi.mock('../../shippingeasy-api.js', () => ({
    createOrder: vi.fn().mockResolvedValue('SE-fake'),
    cancelOrder: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../lib/activity-broadcaster.js', () => ({
    broadcastLowStock: vi.fn(),
    broadcastSoldOut: vi.fn(),
}));

vi.mock('../../community-goals.js', () => ({
    addRevenue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/queue-source.js', () => ({
    addEntry: vi.fn().mockResolvedValue({ closedSession: false, duplicate: false, entry: { id: 'q_1' } }),
    getActiveQueue: vi.fn().mockResolvedValue({ id: 'queue-1', status: 'open' }),
    markEntryRefundedBySession: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../lib/wp-pull-box.js', () => ({
    getActiveBox: vi.fn().mockResolvedValue(null),
    claimSlots: vi.fn(),
    confirmSlots: vi.fn(),
}));

vi.mock('../../commands/battle.js', () => ({
    updateBattleMessage: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../commands/card-shop.js', () => ({
    clearExpiryTimer: vi.fn(),
    clearListingTtl: vi.fn(),
    updateListingEmbed: vi.fn().mockResolvedValue(null),
    updateListSessionEmbed: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../commands/queue.js', () => ({
    addToQueue: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../commands/pull.js', () => ({
    recordPullPurchase: vi.fn().mockResolvedValue(undefined),
    recordPullBoxPurchase: vi.fn().mockResolvedValue(undefined),
}));

const mockShippingRecord = { run: vi.fn() };
vi.mock('../../db.js', () => ({
    db: null,
    purchases: {},
    battles: {},
    cardListings: {},
    listSessions: {},
    discordLinks: {},
    shipping: { record: mockShippingRecord },
    tracking: {},
}));

const dbModule = await import('../../db.js');
const { handleCheckoutCompleted } = await import('../../webhooks/stripe.js');
const { propagateRefund } = await import('../../lib/refund-propagator.js');

// ============================================================================
// Model — what we EXPECT the real DB to look like after each command.
// fast-check uses both the model state (for `check`/`toString`) and the
// real state (for `run`). After each command we assert invariants over
// the real state.
// ============================================================================

class BuyerModel {
    constructor() {
        // Map<sessionId, { discordUserId, amount, refunded, refundAmount, lineItemCount }>
        this.sessions = new Map();
        // Map<discordUserId, number> — ROLLING count of non-refunded sessions
        this.expectedCounts = new Map();
    }

    hasSession(sessionId) {
        return this.sessions.has(sessionId);
    }

    addSession(sessionId, opts) {
        this.sessions.set(sessionId, { ...opts, refunded: false, refundAmount: null });
        const prev = this.expectedCounts.get(opts.discordUserId) ?? 0;
        this.expectedCounts.set(opts.discordUserId, prev + 1);
    }

    refundSession(sessionId, amountCents) {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        s.refunded = true;
        s.refundAmount = amountCents;
        // Note: we do NOT decrement expectedCounts. Refunds don't currently
        // decrement Nous's purchase_counts (intentional product policy).
    }
}

// ============================================================================
// Commands — buyer actions the generator picks from
// ============================================================================

function emailFor(buyerId) {
    // Each generative buyer has a unique email — matching real-world identity.
    // Sharing emails across buyers (an earlier bug in this test) silently routes
    // counts to the FIRST-linked buyer because getDiscordIdByEmail keys on email.
    return `${buyerId}@e2e-test.local`;
}

class SuccessfulPurchaseCommand {
    constructor({ buyerId, sessionSeed, amount, lineItemCount }) {
        this.buyerId = buyerId;
        this.sessionSeed = sessionSeed;
        this.amount = amount;
        this.lineItemCount = lineItemCount;
    }

    /** All purchase actions are always legal in the test environment. */
    check() {
        return true;
    }

    async run(real) {
        const sessionId = this.sessionId();

        // Skip if this exact sessionId has already been used — fast-check
        // can generate the same seed twice; the WebhookRetry command exists
        // for retries explicitly.
        const existing = real.stmts.purchases.getBySessionId.get(sessionId);
        if (existing) return;

        const items = Array.from({ length: this.lineItemCount }, (_, i) => ({
            name: `Item-${i}`,
            quantity: 1,
            stock_remaining: 10,
        }));
        const session = checkoutSessionCompleted({
            id: sessionId,
            discordUserId: this.buyerId,
            email: emailFor(this.buyerId),
            items,
            amount: this.amount,
        });

        await handleCheckoutCompleted(session);
        real.model.addSession(sessionId, {
            discordUserId: this.buyerId,
            amount: this.amount,
            lineItemCount: this.lineItemCount,
        });
    }

    sessionId() {
        return `cs_test_buy_${this.buyerId}_${this.sessionSeed}`;
    }

    toString() {
        return `Purchase(${this.buyerId}, seed=${this.sessionSeed}, $${this.amount / 100}, ${this.lineItemCount}L)`;
    }
}

class WebhookRetryCommand {
    constructor({ buyerId, sessionSeed }) {
        this.buyerId = buyerId;
        this.sessionSeed = sessionSeed;
    }

    check() { return true; }

    async run(real) {
        // A real Stripe webhook retry is a REDELIVERY of an event we already
        // processed. If the session was never purchased, there's nothing to
        // retry — fast-check generates random (buyerId, seed) pairs so we
        // have to gate on the model state.
        const sessionId = `cs_test_buy_${this.buyerId}_${this.sessionSeed}`;
        if (!real.model.hasSession(sessionId)) return;

        // Re-fire handleCheckoutCompleted with the same session id. The
        // existing purchase row should NOT be duplicated and the count
        // should NOT bump. (PR 3 / TC6 regression coverage.)
        const session = checkoutSessionCompleted({
            id: sessionId,
            discordUserId: this.buyerId,
            email: emailFor(this.buyerId),
            items: [{ name: 'Item-0', quantity: 1, stock_remaining: 10 }],
            amount: 1000,
        });
        await handleCheckoutCompleted(session);
        // Model unchanged on retry — that's the point.
    }

    toString() {
        return `WebhookRetry(${this.buyerId}, seed=${this.sessionSeed})`;
    }
}

class FullRefundCommand {
    constructor({ buyerId, sessionSeed }) {
        this.buyerId = buyerId;
        this.sessionSeed = sessionSeed;
    }

    check() { return true; }

    async run(real) {
        const sessionId = `cs_test_buy_${this.buyerId}_${this.sessionSeed}`;
        const row = real.stmts.purchases.getBySessionId.get(sessionId);
        if (!row) return; // session never existed — propagator will no-op

        await propagateRefund(sessionId, {
            source: 'webhook_refund',
            amountCents: null, // null === full
            reason: 'requested_by_customer',
            refundId: `re_full_${sessionId}`,
        });
        real.model.refundSession(sessionId, null);
    }

    toString() {
        return `FullRefund(${this.buyerId}, seed=${this.sessionSeed})`;
    }
}

class PartialRefundCommand {
    constructor({ buyerId, sessionSeed, amountCents }) {
        this.buyerId = buyerId;
        this.sessionSeed = sessionSeed;
        this.amountCents = amountCents;
    }

    check() { return true; }

    async run(real) {
        const sessionId = `cs_test_buy_${this.buyerId}_${this.sessionSeed}`;
        const row = real.stmts.purchases.getBySessionId.get(sessionId);
        if (!row) return;
        if (row.refunded_at) return; // already refunded

        await propagateRefund(sessionId, {
            source: 'webhook_refund',
            amountCents: this.amountCents,
            reason: 'damaged_card_credit',
            refundId: `re_partial_${sessionId}`,
        });
        real.model.refundSession(sessionId, this.amountCents);
    }

    toString() {
        return `PartialRefund(${this.buyerId}, seed=${this.sessionSeed}, $${this.amountCents / 100})`;
    }
}

// ============================================================================
// Invariants — assert after every command
// ============================================================================

function assertInvariants(real) {
    const { db, stmts, model } = real;

    // I1: Each stripe_session_id has at most one purchase row. UNIQUE
    // constraint on the column already enforces this at the SQL layer;
    // the assertion catches code paths that might accidentally clear the
    // index (a future schema migration mistake).
    const dupes = db.prepare(
        'SELECT stripe_session_id, COUNT(*) as c FROM purchases GROUP BY stripe_session_id HAVING c > 1',
    ).all();
    expect(dupes, `purchase rows duplicated for sessions: ${dupes.map(d => d.stripe_session_id).join(', ')}`).toEqual([]);

    // I2: purchase_counts is non-negative for every buyer.
    const negative = db.prepare(
        'SELECT discord_user_id, total_purchases FROM purchase_counts WHERE total_purchases < 0',
    ).all();
    expect(negative, 'purchase_counts went negative').toEqual([]);

    // I3: For every buyer, real.purchase_counts <= model.expectedCount.
    // The model bumps on every successful add; webhook retries are
    // expected to NOT bump (PR 3). If real > model, retries are
    // double-counting somewhere.
    for (const [buyerId, expectedCount] of model.expectedCounts.entries()) {
        const row = stmts.purchases.getPurchaseCount.get(buyerId);
        const actual = row?.total_purchases ?? 0;
        expect(actual).toBeLessThanOrEqual(expectedCount);
    }

    // I4: A row with refunded_at must also have a non-null Stripe session id
    // (sanity — refunds without a corresponding purchase are a write-bug).
    const orphanRefunds = db.prepare(
        "SELECT id FROM purchases WHERE refunded_at IS NOT NULL AND stripe_session_id IS NULL",
    ).all();
    expect(orphanRefunds, 'refund rows with null session id').toEqual([]);

    // I5: Refund metadata round-trip — for every session the model marked
    // refunded, the real DB has refunded_at populated.
    for (const [sessionId, info] of model.sessions.entries()) {
        if (!info.refunded) continue;
        const row = stmts.purchases.getBySessionId.get(sessionId);
        if (!row) continue; // session was never recorded in real (e.g. duplicate seed)
        expect(row.refunded_at, `expected refunded_at for ${sessionId}`).toBeTruthy();
    }

    // I6: Email normalization — every email in purchases is lowercase.
    const upper = db.prepare(
        "SELECT customer_email FROM purchases WHERE customer_email IS NOT NULL AND customer_email != LOWER(customer_email)",
    ).all();
    expect(upper, 'non-lowercase emails leaked through').toEqual([]);
}

// ============================================================================
// fast-check arbitraries
// ============================================================================

const buyerArb = fc.constantFrom(...TEST_BUYERS);
const sessionSeedArb = fc.integer({ min: 1, max: 30 }); // small range encourages retries

const commandArb = fc.oneof(
    {
        arbitrary: fc.record({
            buyerId: buyerArb,
            sessionSeed: sessionSeedArb,
            amount: fc.integer({ min: 100, max: 50_000 }),
            lineItemCount: fc.integer({ min: 1, max: 4 }),
        }).map((args) => new SuccessfulPurchaseCommand(args)),
        weight: 5,
    },
    {
        arbitrary: fc.record({
            buyerId: buyerArb,
            sessionSeed: sessionSeedArb,
        }).map((args) => new WebhookRetryCommand(args)),
        weight: 2,
    },
    {
        arbitrary: fc.record({
            buyerId: buyerArb,
            sessionSeed: sessionSeedArb,
        }).map((args) => new FullRefundCommand(args)),
        weight: 1,
    },
    {
        arbitrary: fc.record({
            buyerId: buyerArb,
            sessionSeed: sessionSeedArb,
            amountCents: fc.integer({ min: 100, max: 5000 }),
        }).map((args) => new PartialRefundCommand(args)),
        weight: 1,
    },
);

// ============================================================================
// Runner
// ============================================================================

// Tunable via env so CI can drop or nightly can crank up. Defaults below
// are tuned for fast-feedback on the local dev loop; a nightly job can
// `GENERATIVE_RUNS=500 GENERATIVE_DEPTH=50 npm test` for deeper coverage.
const NUM_RUNS = parseInt(process.env.GENERATIVE_RUNS || '50', 10);
const MAX_COMMANDS = parseInt(process.env.GENERATIVE_DEPTH || '20', 10);

/**
 * Run a journey end-to-end against fresh state. Extracted so the seed-replay
 * spec (below) can call the same flow without going through fc.asyncProperty.
 */
async function runJourney(commands) {
    const db = createTestDb();
    const stmts = buildStmts(db);
    dbModule.db = db;
    Object.assign(dbModule.purchases, stmts.purchases);
    Object.assign(dbModule.battles, stmts.battles);
    Object.assign(dbModule.cardListings, stmts.cardListings);
    Object.assign(dbModule.listSessions, stmts.listSessions);
    Object.assign(dbModule.discordLinks, stmts.discordLinks);
    vi.clearAllMocks();

    const real = { db, stmts, model: new BuyerModel() };

    for (const cmd of commands) {
        if (!cmd.check(real.model)) continue;
        await cmd.run(real);
        assertInvariants(real);
    }
}

const SEEDS_DIR = path.resolve(__dirname, 'seeds');

describe('generative buyer journey — handler-level invariants', () => {
    it(`holds all invariants across ${NUM_RUNS} random journeys × max ${MAX_COMMANDS} commands`, async () => {
        try {
            await fc.assert(
                fc.asyncProperty(fc.array(commandArb, { minLength: 1, maxLength: MAX_COMMANDS }), async (commands) => {
                    await runJourney(commands);
                }),
                { numRuns: NUM_RUNS, verbose: false },
            );
        } catch (err) {
            // Fast-check throws an Error whose message includes the seed +
            // counterexample. Persist it so the failure becomes a permanent
            // regression: the replay spec below will re-execute it on every
            // future run, even after the original bug is fixed.
            captureSeed(err);
            throw err;
        }
    }, 600_000);
});

/**
 * Parse fast-check's failure message and write a fingerprint to seeds/.
 * The message looks like:
 *   "Property failed after N tests
 *    { seed: -1234567, path: "0:1:0", endOnFailure: true }
 *    Counterexample: [[Purchase(buyer_alpha, seed=1, $1, 1L)]]
 *    Shrunk N time(s)"
 */
function captureSeed(err) {
    if (!fs.existsSync(SEEDS_DIR)) {
        fs.mkdirSync(SEEDS_DIR, { recursive: true });
    }
    const message = (err && err.message) || String(err);
    const seedMatch = message.match(/seed:\s*(-?\d+)/);
    const pathMatch = message.match(/path:\s*"([^"]+)"/);
    const counterexampleMatch = message.match(/Counterexample:\s*(\[\[.+?\]\])/s);

    if (!seedMatch || !pathMatch) {
        // Couldn't parse — bail rather than write a useless file
        console.error('Could not parse fast-check failure for seed capture:', message);
        return;
    }

    const fingerprint = {
        capturedAt: new Date().toISOString(),
        seed: parseInt(seedMatch[1], 10),
        path: pathMatch[1],
        counterexample: counterexampleMatch ? counterexampleMatch[1] : null,
        commandSchema: 'buyer-journey-v1',
        // Trace just the assertion text — no stack noise
        firstError: (message.match(/AssertionError:[^\n]+/) || [])[0] || null,
    };

    // File name encodes seed for de-duplication. If the same seed reappears
    // (bug not fixed), we overwrite with the latest capturedAt — fine.
    const file = path.join(SEEDS_DIR, `seed-${fingerprint.seed}.json`);
    fs.writeFileSync(file, JSON.stringify(fingerprint, null, 2) + '\n');
    console.log(`✗ Failure seed captured at tests/generative/seeds/seed-${fingerprint.seed}.json`);
}

/**
 * Replay every captured failure seed as a permanent regression. Each seed
 * runs as its own test so a single bad seed doesn't mask others.
 */
const seedFiles = fs.existsSync(SEEDS_DIR)
    ? fs.readdirSync(SEEDS_DIR).filter((f) => f.endsWith('.json'))
    : [];

if (seedFiles.length > 0) {
    describe('captured seeds — permanent regressions', () => {
        for (const file of seedFiles) {
            const fingerprint = JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, file), 'utf8'));
            it(`seed ${fingerprint.seed} (captured ${fingerprint.capturedAt.slice(0, 10)})`, async () => {
                await fc.assert(
                    fc.asyncProperty(fc.array(commandArb, { minLength: 1, maxLength: MAX_COMMANDS }), async (commands) => {
                        await runJourney(commands);
                    }),
                    {
                        seed: fingerprint.seed,
                        path: fingerprint.path,
                        endOnFailure: true,
                        numRuns: 1,
                    },
                );
            }, 60_000);
        }
    });
}
