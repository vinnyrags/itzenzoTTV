/**
 * Tests for the Stripe catalog drift handlers in webhooks/stripe.js:
 *   - notifyCatalogProductDeactivated()
 *   - priceEventProductId()
 *
 * These don't touch SQLite — they POST to the WP REST endpoint that
 * sets stock=0 on any catalog post referencing a now-inactive Stripe
 * product. We mock global fetch and assert the right HTTP shape goes
 * out, plus the early-return guards.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
    default: {
        SITE_URL: 'https://test.example.com',
        LIVESTREAM_SECRET: 'secret-for-test',
        STRIPE_SECRET_KEY: 'sk_test_unused',
        SHOP_URL: 'https://shop.test',
        LOW_STOCK_THRESHOLD: 3,
        XIPE_PURCHASE_THRESHOLD: 1,
        LONG_PURCHASE_THRESHOLD: 5,
        CHANNELS: { PACK_BATTLES: '0', ANNOUNCEMENTS: '0', ORDER_FEED: '0', DEALS: '0', OPS: '0', CARD_SHOP: '0', SHIPPING_LABELS: '0' },
        ROLES: { AHA: '0', AKIVILI: '0', NANOOK: '0', XIPE: '0', LONG: '0' },
        SHIPPING: { INTERNATIONAL: 2500 },
    },
}));

import {
    notifyCatalogProductDeactivated,
    priceEventProductId,
} from '../webhooks/stripe.js';

beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ matched: 1, updated: 1 }),
    });
});

describe('notifyCatalogProductDeactivated', () => {
    it('POSTs to the WP catalog endpoint with bot secret + JSON body', async () => {
        await notifyCatalogProductDeactivated('prod_abc');

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, options] = fetch.mock.calls[0];
        expect(url).toBe('https://test.example.com/wp-json/shop/v1/catalog/stripe-product-deactivated');
        expect(options.method).toBe('POST');
        expect(options.headers['X-Bot-Secret']).toBe('secret-for-test');
        expect(options.headers['Content-Type']).toBe('application/json');
        expect(JSON.parse(options.body)).toEqual({ stripeProductId: 'prod_abc' });
    });

    it('skips network call when stripeProductId is empty', async () => {
        await notifyCatalogProductDeactivated('');
        await notifyCatalogProductDeactivated(null);
        await notifyCatalogProductDeactivated(undefined);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('logs but does not throw on WP non-2xx', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({}),
        });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(notifyCatalogProductDeactivated('prod_x')).resolves.toBeUndefined();
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('500'));
        errSpy.mockRestore();
    });

    it('logs but does not throw on network rejection', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('econnreset'));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(notifyCatalogProductDeactivated('prod_y')).resolves.toBeUndefined();
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('prod_y'), 'econnreset');
        errSpy.mockRestore();
    });

    it('logs match counts when WP found references', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ matched: 3, updated: 3 }),
        });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await notifyCatalogProductDeactivated('prod_z');
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('cleared 3/3 WP post(s)'));
        logSpy.mockRestore();
    });

    it('quietly succeeds when WP found no references (matched=0)', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ matched: 0, updated: 0 }),
        });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await notifyCatalogProductDeactivated('prod_unknown');
        // Don't spam logs for the common no-op case
        expect(logSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
    });
});

describe('priceEventProductId', () => {
    it('extracts product id when product is a string', () => {
        expect(priceEventProductId({ id: 'price_1', product: 'prod_abc' })).toBe('prod_abc');
    });

    it('extracts product id when product is expanded into an object', () => {
        expect(priceEventProductId({ id: 'price_1', product: { id: 'prod_xyz' } })).toBe('prod_xyz');
    });

    it('returns null on missing product', () => {
        expect(priceEventProductId({ id: 'price_1' })).toBeNull();
    });

    it('returns null on null/undefined input', () => {
        expect(priceEventProductId(null)).toBeNull();
        expect(priceEventProductId(undefined)).toBeNull();
    });
});
