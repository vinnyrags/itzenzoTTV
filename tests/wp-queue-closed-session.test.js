/**
 * wp-queue.js addEntry — closed-session 409 handling (TC17).
 *
 * Asserts the WP→Nous adapter recognizes the WP `session_not_open` 409
 * and surfaces it as a structured `closedSession: true` result instead
 * of throwing. Webhook handlers branch on this to post #ops.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
    default: {
        SITE_URL: 'http://wp.test',
        LIVESTREAM_SECRET: 'test-secret',
        QUEUE_SOURCE: 'wp',
    },
}));

const originalFetch = global.fetch;
let mockFetch;

beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
});

afterEach(() => {
    global.fetch = originalFetch;
});

const { addEntry } = await import('../lib/wp-queue.js');

describe('addEntry closed-session race', () => {
    it('returns closedSession=true on 409 session_not_open', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 409,
            text: () => Promise.resolve(JSON.stringify({
                code: 'session_not_open',
                message: 'Queue session 5 is closed — cannot create new entries.',
                data: { sessionId: 5, sessionStatus: 'closed' },
            })),
        });

        const result = await addEntry({
            queueId: 5,
            type: 'order',
            source: 'shop',
            stripeSessionId: 'cs_race_1',
        });

        expect(result.closedSession).toBe(true);
        expect(result.entry).toBeNull();
        expect(result.lastInsertRowid).toBeNull();
    });

    it('returns closedSession=false on a 201 success', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: () => Promise.resolve({ entry: { id: 'q_42', status: 'queued' }, duplicate: false }),
        });

        const result = await addEntry({
            queueId: 5,
            type: 'order',
            source: 'shop',
            stripeSessionId: 'cs_ok',
        });

        expect(result.closedSession).toBe(false);
        expect(result.lastInsertRowid).toBe(42);
    });

    it('still throws on non-closed-session 409 (e.g. validation)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 409,
            text: () => Promise.resolve(JSON.stringify({
                code: 'no_active_session',
                message: 'No queue session is open.',
            })),
        });

        await expect(addEntry({
            type: 'order',
            source: 'shop',
            stripeSessionId: 'cs_no_active',
        })).rejects.toThrow(/failed \(409\)/);
    });
});
