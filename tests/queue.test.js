import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, buildStmts } from './setup.js';

let db, stmts;

beforeEach(() => {
    db = createTestDb();
    stmts = buildStmts(db);
});

describe('queue lifecycle', () => {
    it('creates a queue', () => {
        const result = stmts.queues.createQueue.run();
        expect(result.lastInsertRowid).toBe(1);

        const queue = stmts.queues.getActiveQueue.get();
        expect(queue).toBeTruthy();
        expect(queue.status).toBe('open');
    });

    it('closes a queue', () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        stmts.queues.closeQueue.run(queue.id);

        const active = stmts.queues.getActiveQueue.get();
        expect(active).toBeUndefined();

        const closed = stmts.queues.getQueueById.get(queue.id);
        expect(closed.status).toBe('closed');
        expect(closed.closed_at).toBeTruthy();
    });

    it('returns an active queue when multiple exist', () => {
        stmts.queues.createQueue.run();
        stmts.queues.createQueue.run();

        // Both are open — getActiveQueue returns one of them
        const active = stmts.queues.getActiveQueue.get();
        expect(active).toBeTruthy();
        expect(active.status).toBe('open');
    });
});

describe('queue entries', () => {
    it('adds entries', () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        stmts.queues.addEntry.run(queue.id, 'user1', 'user1@test.com', 'Pokemon Pack', 1, 'session_1');
        stmts.queues.addEntry.run(queue.id, 'user2', 'user2@test.com', 'Pokemon Pack', 2, 'session_2');

        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(2);
        expect(entries[0].product_name).toBe('Pokemon Pack');
        expect(entries[1].quantity).toBe(2);
    });

    it('allows same user to have multiple entries', () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        stmts.queues.addEntry.run(queue.id, 'user1', 'user1@test.com', 'Pack A', 1, 'session_1');
        stmts.queues.addEntry.run(queue.id, 'user1', 'user1@test.com', 'Pack B', 1, 'session_2');

        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(2);
    });

    it('counts unique buyers correctly', () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        stmts.queues.addEntry.run(queue.id, 'user1', 'u1@test.com', 'Pack A', 1, 's1');
        stmts.queues.addEntry.run(queue.id, 'user1', 'u1@test.com', 'Pack B', 1, 's2');
        stmts.queues.addEntry.run(queue.id, 'user2', 'u2@test.com', 'Pack A', 1, 's3');
        stmts.queues.addEntry.run(queue.id, 'user3', 'u3@test.com', 'Pack A', 1, 's4');

        const buyers = stmts.queues.getUniqueBuyers.all(queue.id);
        expect(buyers).toHaveLength(3);
    });

    it('unique buyers = duck race entries (one per buyer regardless of items)', () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        // User1 buys 5 items
        for (let i = 0; i < 5; i++) {
            stmts.queues.addEntry.run(queue.id, 'user1', 'u1@test.com', `Pack ${i}`, 1, `s${i}`);
        }
        // User2 buys 1 item
        stmts.queues.addEntry.run(queue.id, 'user2', 'u2@test.com', 'Pack X', 1, 's5');

        const buyers = stmts.queues.getUniqueBuyers.all(queue.id);
        expect(buyers).toHaveLength(2); // 2 duck race entries, not 6
    });

    it('entries without discord user id are counted as unique buyers by email', () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        stmts.queues.addEntry.run(queue.id, null, 'anon@test.com', 'Pack A', 1, 's1');
        stmts.queues.addEntry.run(queue.id, 'user1', 'u1@test.com', 'Pack B', 1, 's2');

        const buyers = stmts.queues.getUniqueBuyers.all(queue.id);
        expect(buyers).toHaveLength(2); // linked user + anon by email
        const ids = buyers.map((b) => b.buyer).sort();
        expect(ids).toEqual(['anon@test.com', 'user1']);
    });
});

describe('duck race winner', () => {
    it('sets duck race winner WITHOUT changing queue status', () => {
        // Race is decoupled from queue lifecycle — winner is just a
        // column on the session. Status stays whatever it was (open
        // mid-stream, closed after /offline) so the operator can run
        // multiple ad-hoc races on the same session if they want.
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        stmts.queues.addEntry.run(queue.id, 'user1', 'u1@test.com', 'Pack', 1, 's1');
        stmts.queues.setDuckRaceWinner.run('user1', queue.id);

        const updated = stmts.queues.getQueueById.get(queue.id);
        expect(updated.duck_race_winner_id).toBe('user1');
        expect(updated.status).toBe('open');
    });

    it('allows re-running the race — second winner overwrites the first', () => {
        // The operator may run the race multiple times on the same
        // queue session (testing, special moments, redo if first
        // pick was contested). Each setDuckRaceWinner call replaces
        // the previous winner; the queue stays in whatever lifecycle
        // state it was already in.
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        stmts.queues.addEntry.run(queue.id, 'user1', 'u1@test.com', 'Pack', 1, 's1');
        stmts.queues.addEntry.run(queue.id, 'user2', 'u2@test.com', 'Pack', 1, 's2');

        stmts.queues.setDuckRaceWinner.run('user1', queue.id);
        stmts.queues.setDuckRaceWinner.run('user2', queue.id);

        const updated = stmts.queues.getQueueById.get(queue.id);
        expect(updated.duck_race_winner_id).toBe('user2');
        expect(updated.status).toBe('open');
    });
});

// =========================================================================
// Purchase → queue integration (livestream on vs off)
// =========================================================================

describe('purchase during livestream vs between streams', () => {
    it('purchase with no active queue: entry is NOT added', () => {
        // No queue open — simulates buying between streams with no livestream active
        const active = stmts.queues.getActiveQueue.get();
        expect(active).toBeUndefined();

        // Simulate what addToQueue does: check for active queue
        // Since there's no queue, the purchase should not create an entry
        const wouldAdd = !!stmts.queues.getActiveQueue.get();
        expect(wouldAdd).toBe(false);

        // Verify no entries exist anywhere
        const allQueues = db.prepare('SELECT COUNT(*) as c FROM queue_entries').get();
        expect(allQueues.c).toBe(0);
    });

    it('purchase with active queue (livestream on): entry IS added', () => {
        // Open a queue — simulates !live which auto-opens a queue
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();
        expect(queue).toBeTruthy();
        expect(queue.status).toBe('open');

        // Simulate what addToQueue does when webhook fires
        stmts.queues.addEntry.run(queue.id, 'user1', 'user1@test.com', 'Pokemon Pack', 1, 'cs_test_123');

        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(1);
        expect(entries[0].discord_user_id).toBe('user1');
        expect(entries[0].product_name).toBe('Pokemon Pack');
    });

    it('purchase with closed queue: entry is NOT added', () => {
        // Queue was open but has been closed — simulates after !offline
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();
        stmts.queues.closeQueue.run(queue.id);

        // No active queue anymore
        const active = stmts.queues.getActiveQueue.get();
        expect(active).toBeUndefined();

        // Purchase would not be added
        const wouldAdd = !!stmts.queues.getActiveQueue.get();
        expect(wouldAdd).toBe(false);
    });

    it('multiple purchases during livestream: all added to same queue', () => {
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        // Three different buyers purchase during the stream
        stmts.queues.addEntry.run(queue.id, 'user1', 'u1@test.com', 'Pack A', 1, 'cs_1');
        stmts.queues.addEntry.run(queue.id, 'user2', 'u2@test.com', 'Pack B', 2, 'cs_2');
        stmts.queues.addEntry.run(queue.id, 'user3', 'u3@test.com', 'Pack A', 1, 'cs_3');

        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(3);

        const buyers = stmts.queues.getUniqueBuyers.all(queue.id);
        expect(buyers).toHaveLength(3);
    });

    it('purchase between streams then during livestream: only livestream purchase in queue', () => {
        // Between streams — no queue, purchase happens but nothing tracked
        const beforeQueue = stmts.queues.getActiveQueue.get();
        expect(beforeQueue).toBeUndefined();

        // Livestream starts — queue opens
        stmts.queues.createQueue.run();
        const queue = stmts.queues.getActiveQueue.get();

        // Now a purchase during livestream gets added
        stmts.queues.addEntry.run(queue.id, 'user1', 'u1@test.com', 'Pokemon Pack', 1, 'cs_live');

        const entries = stmts.queues.getEntries.all(queue.id);
        expect(entries).toHaveLength(1);
        expect(entries[0].stripe_session_id).toBe('cs_live');
    });
});

describe('queue history', () => {
    it('returns recent closed queues', () => {
        // Create and close 3 queues
        for (let i = 0; i < 3; i++) {
            stmts.queues.createQueue.run();
            const q = stmts.queues.getActiveQueue.get();
            stmts.queues.closeQueue.run(q.id);
        }

        const recent = stmts.queues.getRecentQueues.all(5);
        expect(recent).toHaveLength(3);
    });

    it('respects limit', () => {
        for (let i = 0; i < 10; i++) {
            stmts.queues.createQueue.run();
            const q = stmts.queues.getActiveQueue.get();
            stmts.queues.closeQueue.run(q.id);
        }

        const recent = stmts.queues.getRecentQueues.all(3);
        expect(recent).toHaveLength(3);
    });

    it('does not include open queues', () => {
        stmts.queues.createQueue.run();
        // Don't close it

        const recent = stmts.queues.getRecentQueues.all(5);
        expect(recent).toHaveLength(0);
    });
});
