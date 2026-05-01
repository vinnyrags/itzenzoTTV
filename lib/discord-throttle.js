/**
 * Discord-operations throttle.
 *
 * Bounds how many Discord API operations (sendEmbed, channel.send, DM send,
 * embed edit) can run concurrently AND caps the backlog so a webhook storm
 * doesn't queue thousands of pending Discord calls in memory while the
 * library's internal rate-limit retries spin.
 *
 * Discord.js handles 429 rate-limit retries itself, but with no upper bound
 * on retry budget — under burst (50 checkouts in 5 seconds during a hot
 * drop), every embed and DM send gets queued behind every other one and
 * memory grows unbounded. This throttle gives us:
 *
 *   - A configurable concurrency cap (default 5, env DISCORD_OPS_CONCURRENCY)
 *   - A configurable backlog cap (default 200, env DISCORD_OPS_BACKLOG_LIMIT)
 *   - Drop-with-logging when the backlog exceeds the cap, so degraded mode
 *     fails fast and visibly rather than hanging the event loop
 *
 * Wrap any Discord-touching async function:
 *
 *   import { discordThrottle } from './discord-throttle.js';
 *   await discordThrottle(() => channel.send(content));
 */

const DEFAULT_CONCURRENCY = parseInt(process.env.DISCORD_OPS_CONCURRENCY || '5', 10);
const DEFAULT_BACKLOG = parseInt(process.env.DISCORD_OPS_BACKLOG_LIMIT || '200', 10);

let active = 0;
let dropped = 0;
let lastDropLog = 0;
const queue = [];
let concurrency = DEFAULT_CONCURRENCY;
let backlogLimit = DEFAULT_BACKLOG;

function drain() {
    while (active < concurrency && queue.length > 0) {
        const next = queue.shift();
        active++;
        Promise.resolve()
            .then(() => next.fn())
            .then(
                (result) => {
                    next.resolve(result);
                },
                (err) => {
                    next.reject(err);
                },
            )
            .finally(() => {
                active--;
                drain();
            });
    }
}

/**
 * Submit a Discord operation. Returns the operation's promise. When the
 * backlog is full, the operation is dropped — the returned promise resolves
 * to `undefined` and a counter ticks. Callers that need to know about drops
 * can use `discordThrottleStats()`.
 */
export function discordThrottle(fn) {
    return new Promise((resolve, reject) => {
        if (queue.length >= backlogLimit) {
            dropped++;
            // Throttle logging itself so we don't spam the console under sustained drops.
            const now = Date.now();
            if (now - lastDropLog > 5_000) {
                console.warn(`Discord throttle backlog full (${backlogLimit}); dropped ${dropped} ops total`);
                lastDropLog = now;
            }
            // Resolve with undefined — the dropped op is treated as a no-op
            // by callers (matches the existing fire-and-forget pattern for
            // Discord notifications in webhook phase 2).
            resolve(undefined);
            return;
        }
        queue.push({ fn, resolve, reject });
        drain();
    });
}

export function discordThrottleStats() {
    return { active, queued: queue.length, dropped, concurrency, backlogLimit };
}

// Test-only resetter — restores defaults and clears state between vitest cases.
export function __resetDiscordThrottleForTests() {
    active = 0;
    dropped = 0;
    lastDropLog = 0;
    queue.length = 0;
    concurrency = DEFAULT_CONCURRENCY;
    backlogLimit = DEFAULT_BACKLOG;
}

export function __setDiscordThrottleLimitsForTests({ concurrency: c, backlogLimit: b } = {}) {
    if (typeof c === 'number') concurrency = c;
    if (typeof b === 'number') backlogLimit = b;
}
