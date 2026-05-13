/**
 * SQLite queue adapter — wraps the legacy `queues.*` prepared statements
 * in async functions so callers can use a single async interface regardless
 * of source. Behavior is unchanged from the historical SQLite path.
 *
 * `getRecentQueues()` returns rows enriched with a `total_entries` count
 * to match the WP adapter's shape.
 */

import { queues } from '../db.js';

export async function getActiveQueue() {
    return queues.getActiveQueue.get() || null;
}

export async function getQueueById(id) {
    return queues.getQueueById.get(id) || null;
}

export async function createQueue() {
    const result = queues.createQueue.run();
    const session = queues.getQueueById.get(result.lastInsertRowid);
    return { lastInsertRowid: result.lastInsertRowid, session };
}

export async function closeQueue(id) {
    return queues.closeQueue.run(id);
}

export async function claimForRace(id) {
    return queues.claimForRace.run(id);
}

export async function setDuckRaceWinner(winnerUserId, queueId) {
    return queues.setDuckRaceWinner.run(winnerUserId, queueId);
}

export async function setChannelMessage(messageId, queueId) {
    return queues.setChannelMessage.run(messageId, queueId);
}

/**
 * The legacy SQLite queue tables don't carry a duck_race_channel_message_id
 * column — that field only exists in the WP source-of-truth schema. Returning
 * a sqliteUnsupported sentinel so the dispatcher caller can skip the WP-only
 * persistence path cleanly without crashing the legacy code path.
 */
export async function setDuckRaceChannelMessage(/* messageId, queueId */) {
    return { changes: 0, sqliteUnsupported: true };
}

export async function addEntry({
    queueId,
    discordUserId = null,
    customerEmail = null,
    productName = null,
    quantity = 1,
    stripeSessionId = null,
}) {
    const result = queues.addEntry.run(
        queueId,
        discordUserId,
        customerEmail,
        productName,
        quantity,
        stripeSessionId
    );
    return { lastInsertRowid: result.lastInsertRowid, duplicate: false };
}

export async function getEntries(queueId) {
    return queues.getEntries.all(queueId);
}

export async function getUniqueBuyers(queueId) {
    return queues.getUniqueBuyers.all(queueId);
}

export async function getRecentQueues(limit = 5) {
    const rows = queues.getRecentQueues.all(limit);
    return rows.map((r) => ({
        ...r,
        total_entries: queues.getEntries.all(r.id).length,
    }));
}

/**
 * Status transitions are a WP-only concept — the legacy SQLite schema
 * doesn't carry an entry status column. Returning a no-op so `!queue
 * next` falls cleanly back to the WP-source-only path.
 */
export async function updateEntry(entryId, fields = {}) {
    return { entry: null, changes: 0, sqliteUnsupported: true };
}

export async function markEntryRefundedBySession(/* stripeSessionId, opts */) {
    // No-op for the legacy SQLite source — refund propagation is a WP-only
    // concern. Returning null lets the propagator skip the queue mirror
    // step gracefully.
    return null;
}

export async function getActiveEntry(/* queueId */) {
    return null;
}

export async function getNextQueuedEntry(/* queueId */) {
    return null;
}

export async function getQueuedEntries(/* queueId */) {
    return [];
}

export async function resetAll() {
    // Legacy SQLite tables are cleared by the !reset command's existing
    // TABLES_TO_CLEAR loop; nothing to do here.
    return { entriesDeleted: 0, sessionsDeleted: 0, sqliteHandledExternally: true };
}
