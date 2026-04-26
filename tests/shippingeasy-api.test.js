/**
 * Tests for ShippingEasy API client — signing, name splitting, and DB queries.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { createTestDb, buildStmts } from './setup.js';

// Mock config before importing signRequest
vi.mock('../config.js', () => ({
    default: {
        SHIPPINGEASY_API_KEY: 'test_api_key',
        SHIPPINGEASY_API_SECRET: 'test_secret_key_for_signing',
        SHIPPINGEASY_STORE_API_KEY: 'test_store_key',
    },
}));

const mockSendEmbed = vi.fn().mockResolvedValue(null);
vi.mock('../discord.js', () => ({
    sendEmbed: (...args) => mockSendEmbed(...args),
}));

import { signRequest, splitName, cancelOrder } from '../shippingeasy-api.js';

describe('signRequest', () => {
    it('generates HMAC for GET without body', () => {
        const sig = signRequest('GET', '/api/stores/abc/orders', { api_key: 'k', api_timestamp: '123' });
        expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates different HMAC for POST with body', () => {
        const params = { api_key: 'k', api_timestamp: '123' };
        const getSig = signRequest('GET', '/api/orders', params);
        const postSig = signRequest('POST', '/api/orders', params, '{"order":{}}');
        expect(getSig).not.toBe(postSig);
    });

    it('includes body in POST signature', () => {
        const params = { api_key: 'k', api_timestamp: '123' };
        const sig1 = signRequest('POST', '/api/orders', params, '{"a":1}');
        const sig2 = signRequest('POST', '/api/orders', params, '{"a":2}');
        expect(sig1).not.toBe(sig2);
    });

    it('sorts params alphabetically', () => {
        const sig1 = signRequest('GET', '/api/orders', { b: '2', a: '1' });
        const sig2 = signRequest('GET', '/api/orders', { a: '1', b: '2' });
        expect(sig1).toBe(sig2);
    });
});

describe('splitName', () => {
    it('splits "John Smith" into first and last', () => {
        expect(splitName('John Smith')).toEqual({ first_name: 'John', last_name: 'Smith' });
    });

    it('handles single name', () => {
        expect(splitName('John')).toEqual({ first_name: 'John', last_name: '' });
    });

    it('handles multi-part last name', () => {
        expect(splitName('John Paul Smith')).toEqual({ first_name: 'John', last_name: 'Paul Smith' });
    });

    it('handles empty/null name', () => {
        expect(splitName(null)).toEqual({ first_name: 'Customer', last_name: '' });
        expect(splitName('')).toEqual({ first_name: 'Customer', last_name: '' });
    });

    it('trims whitespace', () => {
        expect(splitName('  John   Smith  ')).toEqual({ first_name: 'John', last_name: 'Smith' });
    });
});

describe('shipping address DB queries', () => {
    let db, stmts;

    beforeEach(() => {
        db = createTestDb();
        stmts = buildStmts(db);
    });

    it('stores and retrieves shipping address', () => {
        stmts.purchases.insertPurchase.run('sess_1', 'user_1', 'test@example.com', 'Test Product', 1000);
        stmts.purchases.updateShippingAddress.run('John Smith', '123 Main St', 'Brooklyn', 'NY', '11201', 'US', 'sess_1');

        const purchase = stmts.purchases.getBySessionId.get('sess_1');
        expect(purchase.shipping_name).toBe('John Smith');
        expect(purchase.shipping_address).toBe('123 Main St');
        expect(purchase.shipping_city).toBe('Brooklyn');
        expect(purchase.shipping_state).toBe('NY');
        expect(purchase.shipping_postal_code).toBe('11201');
        expect(purchase.shipping_country).toBe('US');
    });

    it('stores ShippingEasy order ID', () => {
        stmts.purchases.insertPurchase.run('sess_2', 'user_1', 'test@example.com', 'Test Product', 1000);
        stmts.purchases.setShippingEasyOrderId.run('se_order_123', 'sess_2');

        const purchase = stmts.purchases.getBySessionId.get('sess_2');
        expect(purchase.shippingeasy_order_id).toBe('se_order_123');
    });

    it('getPendingShipments returns orders with SE ID but no tracking', () => {
        stmts.purchases.insertPurchase.run('sess_3', 'user_1', 'test@example.com', 'Product A', 1000);
        stmts.purchases.updateShippingAddress.run('John', '123 Main', 'NYC', 'NY', '10001', 'US', 'sess_3');
        stmts.purchases.setShippingEasyOrderId.run('se_100', 'sess_3');

        const pending = stmts.purchases.getPendingShipments.all();
        expect(pending).toHaveLength(1);
        expect(pending[0].stripe_session_id).toBe('sess_3');
    });

    it('getPendingShipments excludes orders with tracking', () => {
        stmts.purchases.insertPurchase.run('sess_4', 'user_1', 'buyer@example.com', 'Product B', 2000);
        stmts.purchases.updateShippingAddress.run('Jane', '456 Oak', 'LA', 'CA', '90001', 'US', 'sess_4');
        stmts.purchases.setShippingEasyOrderId.run('se_200', 'sess_4');

        // Add tracking for this buyer
        db.prepare(`INSERT INTO tracking (customer_email, tracking_number, carrier, created_at) VALUES (?, ?, ?, datetime('now'))`).run('buyer@example.com', 'TRACK123', 'USPS');

        const pending = stmts.purchases.getPendingShipments.all();
        expect(pending).toHaveLength(0);
    });

    it('getReadyShipments returns orders with tracking', () => {
        stmts.purchases.insertPurchase.run('sess_5', 'user_1', 'buyer2@example.com', 'Product C', 3000);
        stmts.purchases.updateShippingAddress.run('Bob', '789 Pine', 'SF', 'CA', '94101', 'US', 'sess_5');
        stmts.purchases.setShippingEasyOrderId.run('se_300', 'sess_5');

        db.prepare(`INSERT INTO tracking (customer_email, tracking_number, carrier, tracking_url, created_at) VALUES (?, ?, ?, ?, datetime('now'))`).run('buyer2@example.com', 'TRACK456', 'UPS', 'https://ups.com/track');

        const ready = stmts.purchases.getReadyShipments.all();
        expect(ready).toHaveLength(1);
        expect(ready[0].tracking_number).toBe('TRACK456');
        expect(ready[0].carrier).toBe('UPS');
    });

    it('excludes orders without shipping address (battle buy-ins)', () => {
        stmts.purchases.insertPurchase.run('sess_battle', 'user_1', 'test@example.com', 'Battle Pack', 1000);
        // No shipping address set — simulates a battle buy-in

        const pending = stmts.purchases.getPendingShipments.all();
        expect(pending).toHaveLength(0);
    });

    it('getShipmentsByDiscordId returns user shipments with tracking status', () => {
        stmts.purchases.insertPurchase.run('sess_6', 'user_2', 'alice@example.com', 'Product D', 1500);
        stmts.purchases.updateShippingAddress.run('Alice', '100 Elm', 'Boston', 'MA', '02101', 'US', 'sess_6');
        stmts.purchases.setShippingEasyOrderId.run('se_400', 'sess_6');

        const shipments = stmts.purchases.getShipmentsByDiscordId.all('user_2');
        expect(shipments).toHaveLength(1);
        expect(shipments[0].product_name).toBe('Product D');
        expect(shipments[0].tracking_number).toBeNull(); // no tracking yet
    });

    it('markShippingEasyCanceled drops the row out of pending shipments', () => {
        stmts.purchases.insertPurchase.run('sess_cancel', 'user_3', 'cancel@example.com', 'Canceled Product', 4000);
        stmts.purchases.updateShippingAddress.run('Cancel Buyer', '1 Main', 'NYC', 'NY', '10001', 'US', 'sess_cancel');
        stmts.purchases.setShippingEasyOrderId.run('se_cancel', 'sess_cancel');

        expect(stmts.purchases.getPendingShipments.all()).toHaveLength(1);
        stmts.purchases.markShippingEasyCanceled.run('sess_cancel');
        expect(stmts.purchases.getPendingShipments.all()).toHaveLength(0);

        const purchase = stmts.purchases.getBySessionId.get('sess_cancel');
        expect(purchase.shippingeasy_canceled_at).toBeTruthy();
        // The order ID is preserved for audit even after cancellation.
        expect(purchase.shippingeasy_order_id).toBe('se_cancel');
    });
});

describe('cancelOrder', () => {
    beforeEach(() => {
        mockSendEmbed.mockClear();
    });

    it('returns false (and does not fetch) when API is not configured', async () => {
        // The module-level config mock is set, so cancelOrder is "configured".
        // To test the unconfigured path we'd need a separate suite — here we
        // just assert the orderId guard: missing orderId → false.
        global.fetch = vi.fn();
        const ok = await cancelOrder({ orderId: null });
        expect(ok).toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('POSTs to the cancellations endpoint with HMAC signature', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: () => Promise.resolve(''),
            json: () => Promise.resolve({}),
        });
        global.fetch = fetchMock;

        const ok = await cancelOrder({ orderId: 'se_42', sessionId: 'cs_x', email: 'a@b.com' });

        expect(ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledOnce();
        const url = fetchMock.mock.calls[0][0];
        expect(url).toContain('/api/stores/test_store_key/orders/se_42/cancellations');
        expect(url).toContain('api_key=test_api_key');
        expect(url).toMatch(/api_signature=[0-9a-f]{64}/);
        const opts = fetchMock.mock.calls[0][1];
        expect(opts.method).toBe('POST');
    });

    it('treats 404 (already gone) as success', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            text: () => Promise.resolve('not found'),
        });
        const ok = await cancelOrder({ orderId: 'se_gone' });
        expect(ok).toBe(true);
        expect(mockSendEmbed).not.toHaveBeenCalled();
    });

    it('returns false and posts to #ops on unexpected failure', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: () => Promise.resolve('server error'),
        });
        const ok = await cancelOrder({ orderId: 'se_500', email: 'fail@example.com' });
        expect(ok).toBe(false);
        expect(mockSendEmbed).toHaveBeenCalledOnce();
        const [channel, embed] = mockSendEmbed.mock.calls[0];
        expect(channel).toBe('OPS');
        expect(embed.description).toContain('se_500');
        expect(embed.description).toContain('manually cancel in ShippingEasy');
    });

    it('returns false and posts to #ops on network error', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
        const ok = await cancelOrder({ orderId: 'se_err' });
        expect(ok).toBe(false);
        expect(mockSendEmbed).toHaveBeenCalledOnce();
        expect(mockSendEmbed.mock.calls[0][1].description).toContain('ECONNRESET');
    });
});
