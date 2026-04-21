/**
 * Tests for webhook concurrency limiter.
 */

import { describe, it, expect } from 'vitest';
import { createLimiter } from '../webhook-limiter.js';

describe('createLimiter', () => {
    it('allows up to maxConcurrent tasks simultaneously', async () => {
        const limit = createLimiter(2);
        let active = 0;
        let maxActive = 0;

        const task = () => limit(async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise(r => setTimeout(r, 50));
            active--;
        });

        await Promise.all([task(), task(), task(), task()]);
        expect(maxActive).toBe(2);
    });

    it('returns the function result', async () => {
        const limit = createLimiter(5);
        const result = await limit(() => Promise.resolve(42));
        expect(result).toBe(42);
    });

    it('releases slot on error', async () => {
        const limit = createLimiter(1);

        try {
            await limit(() => Promise.reject(new Error('fail')));
        } catch { /* expected */ }

        // Should not be stuck — next call should proceed
        const result = await limit(() => Promise.resolve('ok'));
        expect(result).toBe('ok');
    });

    it('processes all queued tasks', async () => {
        const limit = createLimiter(1);
        const results = [];

        await Promise.all([
            limit(async () => { results.push(1); }),
            limit(async () => { results.push(2); }),
            limit(async () => { results.push(3); }),
        ]);

        expect(results).toHaveLength(3);
        expect(results).toContain(1);
        expect(results).toContain(2);
        expect(results).toContain(3);
    });
});
