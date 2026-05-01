/**
 * Discord throttle — TC15 coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    discordThrottle,
    discordThrottleStats,
    __resetDiscordThrottleForTests,
    __setDiscordThrottleLimitsForTests,
} from '../lib/discord-throttle.js';

beforeEach(() => {
    __resetDiscordThrottleForTests();
});

describe('concurrency cap', () => {
    it('caps active operations at the concurrency setting', async () => {
        __setDiscordThrottleLimitsForTests({ concurrency: 2, backlogLimit: 100 });

        let peakActive = 0;
        const tracker = () =>
            new Promise((resolve) => {
                peakActive = Math.max(peakActive, discordThrottleStats().active);
                setTimeout(resolve, 20);
            });

        await Promise.all([
            discordThrottle(tracker),
            discordThrottle(tracker),
            discordThrottle(tracker),
            discordThrottle(tracker),
            discordThrottle(tracker),
        ]);

        expect(peakActive).toBeLessThanOrEqual(2);
    });

    it('drains queue as ops complete', async () => {
        __setDiscordThrottleLimitsForTests({ concurrency: 1, backlogLimit: 100 });

        const order = [];
        const op = (n) => () => {
            order.push(n);
            return Promise.resolve(n);
        };

        await Promise.all([
            discordThrottle(op(1)),
            discordThrottle(op(2)),
            discordThrottle(op(3)),
        ]);

        expect(order).toEqual([1, 2, 3]);
        expect(discordThrottleStats().queued).toBe(0);
        expect(discordThrottleStats().active).toBe(0);
    });
});

describe('backlog cap (drop with logging)', () => {
    it('drops the operation when backlog exceeds the limit', async () => {
        __setDiscordThrottleLimitsForTests({ concurrency: 1, backlogLimit: 2 });

        // Block the first op
        let release;
        const block = new Promise((r) => { release = r; });

        // 1 active + 2 queued = at capacity. The 4th one drops.
        const ops = [
            discordThrottle(() => block),
            discordThrottle(() => Promise.resolve('q1')),
            discordThrottle(() => Promise.resolve('q2')),
            discordThrottle(() => Promise.resolve('dropped')),
        ];

        // 4th op resolves to undefined immediately (not 'dropped')
        const fourthResult = await ops[3];
        expect(fourthResult).toBeUndefined();
        expect(discordThrottleStats().dropped).toBe(1);

        // Release the blocking op so the test cleanup is happy
        release('done');
        await Promise.all([ops[0], ops[1], ops[2]]);
    });
});

describe('error propagation', () => {
    it('rejects promise when op throws', async () => {
        const err = new Error('Discord API down');
        await expect(discordThrottle(() => Promise.reject(err))).rejects.toBe(err);
    });

    it('does not stop draining queue after one op fails', async () => {
        __setDiscordThrottleLimitsForTests({ concurrency: 1, backlogLimit: 100 });

        const a = discordThrottle(() => Promise.reject(new Error('nope')));
        const b = discordThrottle(() => Promise.resolve('ok'));

        await expect(a).rejects.toThrow('nope');
        await expect(b).resolves.toBe('ok');
    });
});
