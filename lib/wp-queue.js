/**
 * WordPress queue API client.
 *
 * Talks to the canonical queue tables exposed by the vincentragosta.io
 * Shop provider (`/wp-json/shop/v1/queue/...`). Translates responses into
 * SQLite-row-shaped objects so commands/queue.js can stay close to its
 * original form — `getActiveQueue()` returns `{ id, status, channel_message_id,
 * duck_race_winner_id, created_at, closed_at }` regardless of source.
 *
 * All methods are async (HTTP) — callers must await.
 */

import config from '../config.js';

const BASE = `${config.SITE_URL}/wp-json/shop/v1`;

async function botFetch(path, init = {}) {
    const url = `${BASE}${path}`;
    const headers = {
        'Content-Type': 'application/json',
        'X-Bot-Secret': config.LIVESTREAM_SECRET,
        ...(init.headers || {}),
    };

    let response;
    try {
        response = await fetch(url, { ...init, headers });
    } catch (e) {
        console.error(`wp-queue ${init.method || 'GET'} ${path} network error:`, e.message);
        throw e;
    }

    if (!response.ok) {
        const text = await response.text();
        const error = new Error(`wp-queue ${init.method || 'GET'} ${path} failed (${response.status}): ${text}`);
        error.status = response.status;
        error.body = text;
        throw error;
    }

    if (response.status === 204) return null;
    return await response.json();
}

/**
 * Translate WP session shape (camelCase, ISO 8601) into the SQLite row shape
 * the rest of Nous expects. Keeps queue.js call sites close to their original.
 */
function adaptSession(wp) {
    if (!wp) return null;
    return {
        id: wp.id,
        status: wp.status,
        channel_message_id: wp.channelMessageId,
        duck_race_winner_id: wp.duckRaceWinnerUserId,
        created_at: isoToMysql(wp.createdAt),
        closed_at: wp.closedAt ? isoToMysql(wp.closedAt) : null,
    };
}

function adaptEntry(wp) {
    if (!wp) return null;
    return {
        id: wp.id,
        queue_id: wp.sessionId,
        type: wp.type,
        source: wp.source,
        status: wp.status,
        discord_user_id: wp.discordUserId,
        discord_handle: wp.discordHandle,
        customer_email: wp.customerEmail,
        order_number: wp.orderNumber,
        display_name: wp.displayName,
        product_name: wp.detailLabel || labelFromType(wp.type, wp.detailData),
        quantity: extractQuantity(wp.detailData),
        stripe_session_id: wp.stripeSessionId,
        external_ref: wp.externalRef,
        detail_label: wp.detailLabel,
        detail_data: wp.detailData,
        created_at: isoToMysql(wp.createdAt),
        completed_at: wp.completedAt ? isoToMysql(wp.completedAt) : null,
    };
}

function isoToMysql(iso) {
    // 2026-04-27T14:21:03Z → 2026-04-27 14:21:03 (UTC, matches MySQL DATETIME).
    if (!iso) return null;
    return iso.replace('T', ' ').replace('Z', '');
}

function labelFromType(type, data) {
    switch (type) {
        case 'pull_box':     return data?.tier ? `Pull Box ($${data.tier})` : 'Pull Box';
        case 'pack_battle':  return 'Pack Battle';
        case 'rts':          return data?.cardName || 'Card Request';
        case 'order':
        default:             return 'Order';
    }
}

function extractQuantity(data) {
    if (!data) return 1;
    if (typeof data.quantity === 'number') return data.quantity;
    if (typeof data.items === 'number') return data.items;
    return 1;
}

// =========================================================================
// Public API — mirrors lib/queue-source.js interface
// =========================================================================

export async function getActiveQueue() {
    const data = await botFetch('/queue?limit=1');
    return adaptSession(data?.session);
}

export async function getQueueById(id) {
    const data = await botFetch(`/queue?session_id=${encodeURIComponent(id)}&limit=1`);
    return adaptSession(data?.session);
}

export async function createQueue() {
    const data = await botFetch('/queue/sessions', {
        method: 'POST',
        body: JSON.stringify({}),
    });
    return { lastInsertRowid: data?.session?.id, session: adaptSession(data?.session) };
}

export async function closeQueue(id) {
    await botFetch(`/queue/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'closed' }),
    });
    return { changes: 1 };
}

export async function claimForRace(id) {
    try {
        const session = await getQueueById(id);
        if (!session || session.status !== 'open') {
            return { changes: 0 };
        }
        await botFetch(`/queue/sessions/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'racing' }),
        });
        return { changes: 1 };
    } catch (e) {
        if (e.status === 409 || e.status === 404) return { changes: 0 };
        throw e;
    }
}

export async function setDuckRaceWinner(winnerUserId, queueId) {
    await botFetch(`/queue/sessions/${encodeURIComponent(queueId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
            status: 'complete',
            duck_race_winner_user_id: String(winnerUserId),
        }),
    });
    return { changes: 1 };
}

export async function setChannelMessage(messageId, queueId) {
    await botFetch(`/queue/sessions/${encodeURIComponent(queueId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ channel_message_id: String(messageId) }),
    });
    return { changes: 1 };
}

export async function addEntry({
    queueId,
    discordUserId = null,
    customerEmail = null,
    productName = null,
    quantity = 1,
    stripeSessionId = null,
    type = 'order',
    source = 'shop',
    externalRef = null,
    discordHandle = null,
    orderNumber = null,
    displayName = null,
    detailLabel = null,
    detailData = null,
}) {
    const payload = {
        type,
        source,
        discord_user_id: discordUserId,
        discord_handle: discordHandle,
        customer_email: customerEmail,
        order_number: orderNumber,
        display_name: displayName,
        detail_label: detailLabel ?? productName,
        detail_data: detailData ?? (quantity ? { quantity } : null),
        stripe_session_id: stripeSessionId,
        external_ref: externalRef,
    };
    if (queueId) payload.session_id = queueId;

    let data;
    try {
        data = await botFetch('/queue/entries', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    } catch (e) {
        // The session-status guard returns 409 session_not_open when an admin
        // closed the session between the bot's getActiveQueue() and the
        // entry insert. Surface it as a structured result so the webhook
        // handler can post #ops "buyer paid but session closed — manual
        // triage" without obscuring the buyer's purchase row.
        if (e.status === 409 && typeof e.body === 'string' && e.body.includes('session_not_open')) {
            return { lastInsertRowid: null, duplicate: false, entry: null, closedSession: true };
        }
        throw e;
    }

    return {
        lastInsertRowid: data?.entry?.id ? parseInt(String(data.entry.id).replace(/^q_/, ''), 10) : null,
        duplicate: !!data?.duplicate,
        entry: data?.entry,
        closedSession: false,
    };
}

export async function getEntries(queueId) {
    const data = await botFetch(`/queue/sessions/${encodeURIComponent(queueId)}/entries`);
    return (data?.entries || []).map(adaptEntry);
}

export async function getUniqueBuyers(queueId) {
    const data = await botFetch(`/queue/sessions/${encodeURIComponent(queueId)}/entries`);
    return (data?.uniqueBuyers || []).map((buyer) => ({ buyer }));
}

export async function getRecentQueues(limit = 5) {
    const data = await botFetch(`/queue/sessions?limit=${encodeURIComponent(limit)}`);
    return (data?.sessions || []).map((s) => {
        const adapted = adaptSession(s);
        adapted.total_entries = s.totalEntries ?? 0;
        return adapted;
    });
}

/**
 * Mark the queue entry for a Stripe session as refunded. Idempotent on
 * the WP side — re-submitting returns `{ entry, duplicate: true }`. Used
 * by the unified refund propagator on `charge.refunded`, `charge.dispute.*`
 * and the manual `!refund` command. Returns null when no entry exists for
 * that session (e.g. ad-hoc shipping with no queue mirror).
 */
export async function markEntryRefundedBySession(stripeSessionId, { refundAmountCents = null, reason = null, isPartial = false } = {}) {
    try {
        const data = await botFetch('/queue/entries/refund', {
            method: 'POST',
            body: JSON.stringify({
                stripe_session_id: stripeSessionId,
                refund_amount: refundAmountCents,
                reason,
                is_partial: !!isPartial,
            }),
        });
        return { entry: adaptEntry(data?.entry), duplicate: !!data?.duplicate };
    } catch (e) {
        if (e.status === 404) return null;
        throw e;
    }
}

/**
 * Update a queue entry — typically a status transition
 * (queued → active → completed/skipped). The numeric WP entry id is
 * accepted directly; callers don't need to construct the "q_" prefix.
 */
export async function updateEntry(entryId, { status, discordHandle, displayName, detailLabel, detailData } = {}) {
    const payload = {};
    if (status !== undefined) payload.status = status;
    if (discordHandle !== undefined) payload.discord_handle = discordHandle;
    if (displayName !== undefined) payload.display_name = displayName;
    if (detailLabel !== undefined) payload.detail_label = detailLabel;
    if (detailData !== undefined) payload.detail_data = detailData;

    const data = await botFetch(`/queue/entries/${encodeURIComponent(entryId)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
    });
    return { entry: adaptEntry(data?.entry), changes: data?.entry ? 1 : 0 };
}

/**
 * The current "active" entry for a session, if any. Active is the row
 * being served on stream right now. Returns null when nothing is active.
 */
export async function getActiveEntry(queueId) {
    const data = await botFetch(`/queue/sessions/${encodeURIComponent(queueId)}/entries?status=active`);
    const row = (data?.entries || [])[0];
    return row ? adaptEntry(row) : null;
}

/**
 * The next queued entry to advance to (oldest queued first). Returns
 * null when the queue has no more queued entries.
 */
export async function getNextQueuedEntry(queueId) {
    const data = await botFetch(`/queue/sessions/${encodeURIComponent(queueId)}/entries?status=queued`);
    const row = (data?.entries || [])[0];
    return row ? adaptEntry(row) : null;
}

/**
 * All queued entries for a session, oldest first. Used by the !queue
 * skip command to translate a 1-based position number (as displayed
 * on the homepage) into the underlying entry id.
 */
export async function getQueuedEntries(queueId) {
    const data = await botFetch(`/queue/sessions/${encodeURIComponent(queueId)}/entries?status=queued`);
    return (data?.entries || []).map(adaptEntry);
}

/**
 * Test-only: wipe all queue sessions + entries on the WP side. Called
 * by !reset after the legacy SQLite tables are cleared so the WP
 * source-of-truth queue starts fresh too. Returns counts.
 */
export async function resetAll() {
    const data = await botFetch('/queue/reset', { method: 'POST', body: '{}' });
    return {
        entriesDeleted: data?.entriesDeleted ?? 0,
        sessionsDeleted: data?.sessionsDeleted ?? 0,
    };
}

// Exported for tests.
export const __internal = { adaptSession, adaptEntry, isoToMysql, labelFromType, extractQuantity };
