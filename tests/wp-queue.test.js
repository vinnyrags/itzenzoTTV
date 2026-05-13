/**
 * Tests for the WordPress queue adapter (lib/wp-queue.js).
 * Mocks global fetch — verifies HTTP shape, response adaptation, and the
 * SQLite-row-shaped contract the rest of Nous relies on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as wpQueue from '../lib/wp-queue.js';

const ORIG_FETCH = globalThis.fetch;

function mockJson(body, init = {}) {
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

beforeEach(() => {
    globalThis.fetch = vi.fn();
});

afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
});

describe('adaptSession', () => {
    it('translates WP camelCase + ISO 8601 to SQLite snake_case + MySQL datetime', () => {
        const wp = {
            id: 7,
            status: 'open',
            channelMessageId: '123',
            duckRaceChannelMessageId: '456',
            duckRaceWinnerUserId: '99887766',
            createdAt: '2026-04-27T14:21:03Z',
            closedAt: null,
        };
        const adapted = wpQueue.__internal.adaptSession(wp);
        expect(adapted).toEqual({
            id: 7,
            status: 'open',
            channel_message_id: '123',
            duck_race_channel_message_id: '456',
            duck_race_winner_id: '99887766',
            created_at: '2026-04-27 14:21:03',
            closed_at: null,
        });
    });

    it('defaults duck_race_channel_message_id to null when WP omits it', () => {
        // The field is null for sessions that pre-date the v4 schema OR
        // when the bot has never posted a #duck-race embed for this
        // session yet. updateDuckRaceEmbed treats null as "post fresh
        // and persist the new message id" — the SAME branch as the
        // "tried to fetch existing but it's been deleted" case.
        const wp = {
            id: 8,
            status: 'open',
            channelMessageId: null,
            duckRaceWinnerUserId: null,
            createdAt: '2026-04-27T14:21:03Z',
            closedAt: null,
        };
        const adapted = wpQueue.__internal.adaptSession(wp);
        expect(adapted.duck_race_channel_message_id).toBeNull();
    });

    it('returns null for null input', () => {
        expect(wpQueue.__internal.adaptSession(null)).toBeNull();
    });
});

describe('adaptEntry', () => {
    it('translates WP raw entry to SQLite-row shape with derived product_name and quantity', () => {
        const wp = {
            id: 42,
            sessionId: 7,
            type: 'order',
            source: 'shop',
            status: 'queued',
            discordUserId: '12345',
            discordHandle: 'vinnyrags',
            customerEmail: null,
            orderNumber: '1247',
            displayName: null,
            detailLabel: '12 items',
            detailData: { quantity: 12 },
            stripeSessionId: 'cs_test_x',
            externalRef: null,
            createdAt: '2026-04-27T14:21:03Z',
            completedAt: null,
        };
        const adapted = wpQueue.__internal.adaptEntry(wp);
        expect(adapted.product_name).toBe('12 items');
        expect(adapted.quantity).toBe(12);
        expect(adapted.discord_user_id).toBe('12345');
        expect(adapted.queue_id).toBe(7);
        expect(adapted.created_at).toBe('2026-04-27 14:21:03');
    });

    it('falls back to type-derived product_name when detail_label is missing', () => {
        const adapted = wpQueue.__internal.adaptEntry({
            id: 1, sessionId: 1, type: 'pull_box', source: 'discord', status: 'queued',
            discordUserId: '1', discordHandle: null, customerEmail: null, orderNumber: null,
            displayName: null, detailLabel: null, detailData: { tier: 2 },
            stripeSessionId: null, externalRef: null, createdAt: '2026-04-27T14:21:03Z', completedAt: null,
        });
        expect(adapted.product_name).toBe('Pull Box ($2)');
        expect(adapted.quantity).toBe(1);
    });
});

describe('getActiveQueue', () => {
    it('hits GET /queue and returns adapted session', async () => {
        globalThis.fetch.mockResolvedValueOnce(mockJson({
            session: {
                id: 1,
                status: 'open',
                channelMessageId: null,
                duckRaceWinnerUserId: null,
                createdAt: '2026-04-27T10:00:00Z',
                closedAt: null,
            },
        }));

        const result = await wpQueue.getActiveQueue();
        expect(globalThis.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/wp-json/shop/v1/queue?limit=1'),
            expect.objectContaining({
                headers: expect.objectContaining({ 'X-Bot-Secret': expect.any(String) }),
            })
        );
        expect(result.id).toBe(1);
        expect(result.status).toBe('open');
    });

    it('returns null when no session is active', async () => {
        globalThis.fetch.mockResolvedValueOnce(mockJson({
            session: null,
            active: null,
            upcoming: [],
            total: 0,
            updatedAt: '2026-04-27T10:00:00Z',
        }));

        const result = await wpQueue.getActiveQueue();
        expect(result).toBeNull();
    });
});

describe('createQueue', () => {
    it('POSTs to /queue/sessions and returns lastInsertRowid', async () => {
        globalThis.fetch.mockResolvedValueOnce(mockJson({
            session: {
                id: 9, status: 'open', channelMessageId: null, duckRaceWinnerUserId: null,
                createdAt: '2026-04-27T10:00:00Z', closedAt: null,
            },
        }, { status: 201 }));

        const result = await wpQueue.createQueue();
        expect(result.lastInsertRowid).toBe(9);
        expect(result.session.status).toBe('open');

        const [, init] = globalThis.fetch.mock.calls[0];
        expect(init.method).toBe('POST');
    });
});

describe('claimForRace', () => {
    it('returns changes=0 when session is not open', async () => {
        globalThis.fetch.mockResolvedValueOnce(mockJson({
            session: {
                id: 1, status: 'closed', channelMessageId: null, duckRaceWinnerUserId: null,
                createdAt: '2026-04-27T10:00:00Z', closedAt: '2026-04-27T11:00:00Z',
            },
        }));

        const result = await wpQueue.claimForRace(1);
        expect(result.changes).toBe(0);
    });

    it('returns changes=1 after PATCHing status=racing', async () => {
        globalThis.fetch
            .mockResolvedValueOnce(mockJson({
                session: {
                    id: 1, status: 'open', channelMessageId: null, duckRaceWinnerUserId: null,
                    createdAt: '2026-04-27T10:00:00Z', closedAt: null,
                },
            }))
            .mockResolvedValueOnce(mockJson({
                session: {
                    id: 1, status: 'racing', channelMessageId: null, duckRaceWinnerUserId: null,
                    createdAt: '2026-04-27T10:00:00Z', closedAt: null,
                },
            }));

        const result = await wpQueue.claimForRace(1);
        expect(result.changes).toBe(1);

        const patchCall = globalThis.fetch.mock.calls[1];
        expect(patchCall[1].method).toBe('PATCH');
        expect(JSON.parse(patchCall[1].body)).toEqual({ status: 'racing' });
    });
});

describe('addEntry', () => {
    it('POSTs the right payload and returns numeric lastInsertRowid', async () => {
        globalThis.fetch.mockResolvedValueOnce(mockJson({
            entry: { id: 'q_42', type: 'order', source: 'shop' },
            duplicate: false,
        }, { status: 201 }));

        const result = await wpQueue.addEntry({
            queueId: 1,
            discordUserId: '12345',
            customerEmail: 'buyer@example.com',
            productName: 'Card Pack',
            quantity: 2,
            stripeSessionId: 'cs_xyz',
        });

        expect(result.lastInsertRowid).toBe(42);

        const [url, init] = globalThis.fetch.mock.calls[0];
        expect(url).toContain('/queue/entries');
        expect(init.method).toBe('POST');

        const payload = JSON.parse(init.body);
        expect(payload).toMatchObject({
            session_id: 1,
            type: 'order',
            source: 'shop',
            discord_user_id: '12345',
            customer_email: 'buyer@example.com',
            detail_label: 'Card Pack',
            stripe_session_id: 'cs_xyz',
        });
        expect(payload.detail_data).toEqual({ quantity: 2 });
    });
});

describe('getEntries / getUniqueBuyers', () => {
    it('adapts WP raw entries to SQLite-row shape', async () => {
        globalThis.fetch.mockResolvedValueOnce(mockJson({
            session: {
                id: 1, status: 'open', channelMessageId: null, duckRaceWinnerUserId: null,
                createdAt: '2026-04-27T10:00:00Z', closedAt: null,
            },
            entries: [
                {
                    id: 1, sessionId: 1, type: 'order', source: 'shop', status: 'queued',
                    discordUserId: '111', discordHandle: null, customerEmail: null,
                    orderNumber: null, displayName: null, detailLabel: 'Pack',
                    detailData: { quantity: 1 }, stripeSessionId: null, externalRef: null,
                    createdAt: '2026-04-27T10:01:00Z', completedAt: null,
                },
            ],
            uniqueBuyers: ['111'],
        }));

        const entries = await wpQueue.getEntries(1);
        expect(entries[0].product_name).toBe('Pack');
        expect(entries[0].discord_user_id).toBe('111');
    });

    it('returns unique buyers in {buyer} shape compatible with legacy code', async () => {
        globalThis.fetch.mockResolvedValueOnce(mockJson({
            session: {
                id: 1, status: 'open', channelMessageId: null, duckRaceWinnerUserId: null,
                createdAt: '2026-04-27T10:00:00Z', closedAt: null,
            },
            entries: [],
            uniqueBuyers: ['111', 'buyer@example.com'],
        }));

        const buyers = await wpQueue.getUniqueBuyers(1);
        expect(buyers).toEqual([{ buyer: '111' }, { buyer: 'buyer@example.com' }]);
    });
});

describe('error handling', () => {
    it('throws with status code on non-OK response', async () => {
        globalThis.fetch.mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: async () => 'unauthorized',
        });

        await expect(wpQueue.getActiveQueue()).rejects.toMatchObject({
            status: 401,
        });
    });
});
