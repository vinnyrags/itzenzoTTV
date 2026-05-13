/**
 * Server-Sent Events broadcaster for live queue updates.
 *
 * Holds the set of SSE clients (browsers on itzenzo.tv watching the LIVE
 * QUEUE section), forwards events from the WordPress queue webhook to all
 * of them, and keeps connections warm with a 15-second heartbeat comment
 * so nginx/Cloudflare don't kill them as idle.
 *
 * Replay buffer: keeps the last 100 events with a monotonic id so a
 * client reconnecting with `Last-Event-ID` doesn't miss anything that
 * happened during the dropout.
 */

import { activityEvents } from '../db.js';

const HEARTBEAT_MS = 15_000;
const REPLAY_BUFFER_SIZE = 100;

const clients = new Set();
const replayBuffer = [];
let nextEventId = 1;

let heartbeatTimer = null;

function startHeartbeatIfNeeded() {
    if (heartbeatTimer || clients.size === 0) return;
    heartbeatTimer = setInterval(() => {
        for (const client of clients) {
            try {
                client.res.write(': heartbeat\n\n');
            } catch {
                // Connection already dead; cleanup happens on close.
            }
        }
    }, HEARTBEAT_MS);
}

function stopHeartbeatIfIdle() {
    if (heartbeatTimer && clients.size === 0) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

/**
 * Add a connected SSE client. Returns a cleanup function the caller binds
 * to req.on('close').
 *
 * If `lastEventId` is provided, replay any buffered events newer than it
 * before live streaming begins.
 */
export function addClient(res, lastEventId = null) {
    const client = { res };
    clients.add(client);
    startHeartbeatIfNeeded();

    if (lastEventId !== null) {
        const since = parseInt(String(lastEventId), 10);
        if (Number.isFinite(since)) {
            for (const buffered of replayBuffer) {
                if (buffered.id > since) {
                    writeEvent(res, buffered);
                }
            }
        }
    }

    return () => {
        clients.delete(client);
        stopHeartbeatIfIdle();
    };
}

function writeEvent(res, evt) {
    try {
        res.write(`id: ${evt.id}\n`);
        res.write(`event: ${evt.event}\n`);
        res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
    } catch {
        // Connection closed mid-write; will be cleaned up by the close handler.
    }
}

/**
 * Broadcast an event to all connected clients and append it to the replay
 * buffer. Called by the queue-changed webhook handler.
 *
 * Persistence: every broadcast is also written to `activity_events` in
 * SQLite so the homepage feed survives both page reloads (backfill via
 * /activity/recent) and bot restarts. Persisted BEFORE the SSE fan-out
 * — if the DB write fails, we log and continue to broadcast (live
 * clients shouldn't be punished for a transient storage hiccup).
 */
export function broadcast(event, data) {
    const evt = { id: nextEventId++, event, data };

    try {
        activityEvents.insert.run(event, JSON.stringify(data ?? {}));
    } catch (e) {
        console.error(`activity_events insert failed for ${event}:`, e.message);
    }

    replayBuffer.push(evt);
    if (replayBuffer.length > REPLAY_BUFFER_SIZE) {
        replayBuffer.shift();
    }

    for (const client of clients) {
        writeEvent(client.res, evt);
    }
}

export function clientCount() {
    return clients.size;
}

// Test hooks — production code should not call these.
export function __resetForTests() {
    clients.clear();
    replayBuffer.length = 0;
    nextEventId = 1;
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}
