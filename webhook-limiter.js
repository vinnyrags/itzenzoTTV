/**
 * Concurrency limiter for webhook processing.
 *
 * Bounds how many synchronous SQLite operations can run simultaneously,
 * preventing event loop stalls under high concurrent load.
 */

export function createLimiter(maxConcurrent = 10) {
    let active = 0;
    const waiting = [];

    return async function limit(fn) {
        if (active >= maxConcurrent) {
            await new Promise(resolve => waiting.push(resolve));
        }
        active++;
        try {
            return await fn();
        } finally {
            active--;
            if (waiting.length > 0) waiting.shift()();
        }
    };
}
