/**
 * Tests for command business logic — database operations and message responses.
 *
 * Tests the database operations that command handlers perform (battle lifecycle,
 * queue management, livestream sessions) and command guard responses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, buildStmts } from './setup.js';
import { createMockMessage, createMockMention } from './mocks.js';

let db, stmts;

const PACK_BATTLES = '1488041101326811158';
const ROLE_AKIVILI = '1488046525065072670';
const ROLE_NANOOK = '1488046525899739148';

// Stub discord to prevent real client initialization
vi.mock('../discord.js', () => ({
    client: { channels: { cache: { get: vi.fn() } } },
    getChannel: vi.fn(),
    getGuild: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(null),
    sendEmbed: vi.fn().mockResolvedValue(null),
    getMember: vi.fn().mockResolvedValue(null),
    hasRole: vi.fn().mockReturnValue(false),
    addRole: vi.fn().mockResolvedValue(false),
}));

vi.mock('../config.js', () => ({
    default: {
        CHANNELS: { ANNOUNCEMENTS: '1', ORDER_FEED: '2', DEALS: '3', PACK_BATTLES: '1488041101326811158', AND_IN_THE_BACK: '5', QUEUE: '6' },
        ROLES: { AKIVILI: '1488046525065072670', NANOOK: '1488046525899739148', LONG: 'r3', AHA: 'r4', XIPE: 'r5' },
        SHOP_URL: 'https://example.com/shop',
        SITE_URL: 'https://example.com',
        LIVESTREAM_SECRET: 'test-secret',
        STRIPE_SECRET_KEY: 'sk_test_123',
        GUILD_ID: 'guild123',
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
    shipping: {},
    discordLinks: {},
}));

const dbModule = await import('../db.js');

beforeEach(() => {
    db = createTestDb();
    stmts = buildStmts(db);
    Object.assign(dbModule.db ?? {}, {});
    dbModule.db = db;
    Object.assign(dbModule.purchases, stmts.purchases);
    Object.assign(dbModule.battles, stmts.battles);
    Object.assign(dbModule.queues, stmts.queues);
    Object.assign(dbModule.livestream, stmts.livestream);
    Object.assign(dbModule.shipping, stmts.shipping);
    Object.assign(dbModule.discordLinks, stmts.discordLinks);
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
    });
});

function adminMsg(overrides = {}) {
    return createMockMessage({ channelId: PACK_BATTLES, roles: [ROLE_AKIVILI], ...overrides });
}

// =========================================================================
// Battle lifecycle (database operations)
// =========================================================================

describe('battle lifecycle database operations', () => {
    it('create → add entries → close assigns battle number', () => {
        stmts.battles.createBattle.run('product', 'Test Product', 'price_1', 20, null);
        const battle = stmts.battles.getActiveBattle.get();
        expect(battle.status).toBe('open');

        stmts.battles.addEntry.run(battle.id, 'user1', battle.id, battle.id);
        stmts.battles.confirmPayment.run('cs_1', battle.id, 'user1');

        const { next } = stmts.battles.getNextBattleNumber.get();
        stmts.battles.setBattleNumber.run(next, battle.id);
        stmts.battles.closeBattle.run(battle.id);

        const closed = stmts.battles.getBattleById.get(battle.id);
        expect(closed.status).toBe('closed');
        expect(closed.battle_number).toBe(1);
    });

    it('cancel sets status to cancelled', () => {
        stmts.battles.createBattle.run('product', 'Test', 'price_1', 20, null);
        const battle = stmts.battles.getActiveBattle.get();
        stmts.battles.addEntry.run(battle.id, 'user1', battle.id, battle.id);
        stmts.battles.cancelBattle.run(battle.id);

        expect(stmts.battles.getBattleById.get(battle.id).status).toBe('cancelled');
    });

    it('delete removes empty battle entirely', () => {
        stmts.battles.createBattle.run('product', 'Empty', 'price_1', 20, null);
        const battle = stmts.battles.getActiveBattle.get();
        stmts.battles.deleteBattle.run(battle.id);

        expect(stmts.battles.getBattleById.get(battle.id)).toBeUndefined();
    });

    it('setBattleWinner marks complete with winner_id', () => {
        stmts.battles.createBattle.run('p', 'T', 'price_1', 20, null);
        const battle = stmts.battles.getActiveBattle.get();
        stmts.battles.addEntry.run(battle.id, 'user1', battle.id, battle.id);
        stmts.battles.confirmPayment.run('cs_1', battle.id, 'user1');
        stmts.battles.closeBattle.run(battle.id);

        stmts.battles.setBattleWinner.run('winner123', battle.id);

        const completed = stmts.battles.getBattleById.get(battle.id);
        expect(completed.status).toBe('complete');
        expect(completed.winner_id).toBe('winner123');
    });

    it('owner join: add entry as paid with owner session', () => {
        stmts.battles.createBattle.run('p', 'T', 'price_1', 20, null);
        const battle = stmts.battles.getActiveBattle.get();

        stmts.battles.addEntry.run(battle.id, 'owner1', battle.id, battle.id);
        stmts.battles.confirmPayment.run(`owner-${battle.id}`, battle.id, 'owner1');

        const entries = stmts.battles.getPaidEntries.all(battle.id);
        expect(entries).toHaveLength(1);
        expect(entries[0].stripe_session_id).toBe(`owner-${battle.id}`);
    });

    it('sequential numbering across multiple battles', () => {
        // Battle 1
        stmts.battles.createBattle.run('a', 'A', 'p1', 20, null);
        let b = stmts.battles.getActiveBattle.get();
        stmts.battles.addEntry.run(b.id, 'u1', b.id, b.id);
        stmts.battles.confirmPayment.run('s1', b.id, 'u1');
        let { next } = stmts.battles.getNextBattleNumber.get();
        stmts.battles.setBattleNumber.run(next, b.id);
        stmts.battles.closeBattle.run(b.id);
        expect(next).toBe(1);

        // Battle 2
        stmts.battles.createBattle.run('b', 'B', 'p2', 20, null);
        b = stmts.battles.getActiveBattle.get();
        stmts.battles.addEntry.run(b.id, 'u2', b.id, b.id);
        stmts.battles.confirmPayment.run('s2', b.id, 'u2');
        ({ next } = stmts.battles.getNextBattleNumber.get());
        stmts.battles.setBattleNumber.run(next, b.id);
        stmts.battles.closeBattle.run(b.id);
        expect(next).toBe(2);
    });
});

// =========================================================================
// Queue lifecycle
// =========================================================================

describe('queue lifecycle database operations', () => {
    it('create → add entries → close', () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();
        expect(queue.status).toBe('open');

        stmts.queues.addEntry.run(queue.id, 'u1', 'u@e.com', 'Card A', 2, 'cs_1');
        stmts.queues.addEntry.run(queue.id, 'u2', 'u2@e.com', 'Card B', 1, 'cs_2');

        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(2);

        stmts.queues.closeQueue.run(queue.id);
        expect(stmts.queues.getQueueById.get(queue.id).status).toBe('closed');
    });

    it('unique buyers count for duck race', () => {
        stmts.queues.createQueue.run();
        const q = stmts.queues.getActiveQueue.get();

        // Same user, two items → 1 duck race entry
        stmts.queues.addEntry.run(q.id, 'u1', 'u@e.com', 'Card A', 1, 'cs_1');
        stmts.queues.addEntry.run(q.id, 'u1', 'u@e.com', 'Card B', 1, 'cs_2');
        stmts.queues.addEntry.run(q.id, 'u2', 'u2@e.com', 'Card A', 1, 'cs_3');

        const uniqueBuyers = stmts.queues.getUniqueBuyers.all(q.id);
        expect(uniqueBuyers).toHaveLength(2);
    });

    it('duck race winner assignment (does not change queue status)', () => {
        // Race is decoupled from queue lifecycle — winner column is
        // set, status stays whatever the queue was already in. The
        // queue can be open mid-race (mid-stream race), closed (post-
        // /offline race), or anything else; the race doesn't toggle.
        stmts.queues.createQueue.run();
        const q = stmts.queues.getActiveQueue.get();
        stmts.queues.addEntry.run(q.id, 'winner1', 'w@e.com', 'Card', 1, 'cs_1');
        stmts.queues.closeQueue.run(q.id);

        stmts.queues.setDuckRaceWinner.run('winner1', q.id);

        const updated = stmts.queues.getQueueById.get(q.id);
        expect(updated.status).toBe('closed');
        expect(updated.duck_race_winner_id).toBe('winner1');
    });

    it('recent queues returns closed/complete queues', () => {
        stmts.queues.createQueue.run();
        stmts.queues.closeQueue.run(stmts.queues.getActiveQueue.get().id);
        stmts.queues.createQueue.run();
        stmts.queues.closeQueue.run(stmts.queues.getActiveQueue.get().id);

        const recent = stmts.queues.getRecentQueues.all(5);
        expect(recent).toHaveLength(2);
    });
});

// =========================================================================
// Livestream lifecycle
// =========================================================================

describe('livestream lifecycle', () => {
    it('start → track buyers → end', () => {
        stmts.livestream.startSession.run();
        const session = stmts.livestream.getActiveSession.get();
        expect(session.status).toBe('active');

        stmts.livestream.addBuyer.run(session.id, 'u1', 'buyer@example.com');
        stmts.livestream.addBuyer.run(session.id, 'u2', 'buyer2@example.com');

        const buyers = stmts.livestream.getBuyers.all(session.id);
        expect(buyers).toHaveLength(2);

        stmts.livestream.endSession.run(session.id);
        expect(stmts.livestream.getActiveSession.get()).toBeUndefined();
    });

    it('offline flow: end session → close queue → open new queue', () => {
        stmts.livestream.startSession.run();
        const session = stmts.livestream.getActiveSession.get();

        stmts.queues.createQueue.run();
        const oldQueue = stmts.queues.getActiveQueue.get();

        // End session
        stmts.livestream.endSession.run(session.id);

        // Close old queue
        stmts.queues.closeQueue.run(oldQueue.id);
        expect(stmts.queues.getQueueById.get(oldQueue.id).status).toBe('closed');

        // Open new queue
        stmts.queues.createQueue.run();
        const newQueue = stmts.queues.getActiveQueue.get();
        expect(newQueue).toBeTruthy();
        expect(newQueue.id).not.toBe(oldQueue.id);
    });

    it('shipping paid tracking', () => {
        stmts.livestream.startSession.run();
        const session = stmts.livestream.getActiveSession.get();
        stmts.livestream.addBuyer.run(session.id, 'u1', 'buyer@example.com');

        // Before shipping paid
        let buyers = stmts.livestream.getBuyers.all(session.id);
        expect(buyers).toHaveLength(1);

        // Mark shipping paid
        stmts.livestream.markShippingPaid.run(session.id, 'buyer@example.com');

        // After shipping paid — getBuyers excludes paid
        buyers = stmts.livestream.getBuyers.all(session.id);
        expect(buyers).toHaveLength(0);
    });
});

// =========================================================================
// Command guard tests (using message mocks — these work with vi.mock)
// =========================================================================

describe('command guards (message-level)', () => {
    it('!battle works from any channel (no channel restriction)', async () => {
        const { handleBattle } = await import('../commands/battle.js');
        const msg = createMockMessage({ channelId: 'wrong-channel', roles: [ROLE_AKIVILI] });
        await handleBattle(msg, ['status']);
        expect(msg.reply).not.toHaveBeenCalledWith(expect.stringContaining('only work in'));
    });

    it('!battle rejects non-admin for management commands', async () => {
        const { handleBattle } = await import('../commands/battle.js');
        const msg = createMockMessage({ channelId: PACK_BATTLES, roles: [] });
        await handleBattle(msg, ['start', 'Test']);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('moderators'));
    });

    it('!battle shows usage for unknown subcommand', async () => {
        const { handleBattle } = await import('../commands/battle.js');
        const msg = adminMsg();
        await handleBattle(msg, ['unknown']);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('!queue rejects non-mod for open', async () => {
        const { handleQueue } = await import('../commands/queue.js');
        const msg = createMockMessage({ roles: [] });
        await handleQueue(msg, ['open']);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('moderators'));
    });

    it('!queue rejects non-mod for close', async () => {
        const { handleQueue } = await import('../commands/queue.js');
        const msg = createMockMessage({ roles: [] });
        await handleQueue(msg, ['close']);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('moderators'));
    });

    it('!duckrace rejects non-mod for winner', async () => {
        const { handleDuckRace } = await import('../commands/queue.js');
        const msg = createMockMessage({ roles: [] });
        await handleDuckRace(msg, ['winner']);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('moderators'));
    });

    it('!link rejects missing email', async () => {
        const { handleLink } = await import('../commands/link.js');
        const msg = createMockMessage();
        await handleLink(msg, []);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('!link rejects invalid email', async () => {
        const { handleLink } = await import('../commands/link.js');
        const msg = createMockMessage();
        await handleLink(msg, ['notanemail']);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('!link deletes command message', async () => {
        const { handleLink } = await import('../commands/link.js');
        const msg = createMockMessage();
        await handleLink(msg, ['buyer@example.com']);
        expect(msg.delete).toHaveBeenCalled();
    });
});
