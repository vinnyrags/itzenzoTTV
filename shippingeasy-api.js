/**
 * ShippingEasy API Client
 *
 * Outbound API calls to ShippingEasy for creating orders.
 * Separate from webhooks/shippingeasy.js which handles inbound webhooks.
 */

import crypto from 'node:crypto';
import config from './config.js';
import { sendEmbed } from './discord.js';

/**
 * Split a full name into first and last name.
 */
function splitName(fullName) {
    if (!fullName) return { first_name: 'Customer', last_name: '' };
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) return { first_name: parts[0], last_name: '' };
    return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

/**
 * Generate HMAC SHA256 signature for ShippingEasy API requests.
 *
 * Signature string format: METHOD&path&sorted_query_params[&body]
 * Body is only included for POST/PUT requests.
 */
function signRequest(method, path, params, body = null) {
    const sortedParams = Object.keys(params)
        .sort()
        .map(k => `${k}=${params[k]}`)
        .join('&');

    const parts = [method.toUpperCase(), path, sortedParams];
    if (body) parts.push(body);
    const stringToSign = parts.join('&');

    return crypto
        .createHmac('sha256', config.SHIPPINGEASY_API_SECRET)
        .update(stringToSign)
        .digest('hex');
}

/**
 * Create an order in ShippingEasy.
 *
 * Fire-and-forget: logs errors and posts to #ops, never throws.
 * Returns the ShippingEasy order ID on success, null on failure.
 */
async function createOrder({ stripeSessionId, customerName, email, address, lineItems }) {
    if (!config.SHIPPINGEASY_API_KEY || !config.SHIPPINGEASY_API_SECRET || !config.SHIPPINGEASY_STORE_API_KEY) {
        console.log('ShippingEasy API not configured — skipping order creation');
        return null;
    }

    const { first_name, last_name } = splitName(customerName);

    const items = (lineItems || []).map(item => ({
        item_name: item.name || 'Product',
        sku: stripeSessionId,
        quantity: String(item.quantity || 1),
    }));

    // Ensure at least one line item
    if (items.length === 0) {
        items.push({ item_name: 'Order', sku: stripeSessionId, quantity: '1' });
    }

    const orderPayload = {
        order: {
            external_order_identifier: stripeSessionId,
            ordered_at: new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' +0000'),
            recipients: [{
                first_name,
                last_name,
                address: address.line1 + (address.line2 ? `, ${address.line2}` : ''),
                city: address.city || '',
                state: address.state || '',
                postal_code: address.postal_code || '',
                country: address.country || 'US',
                email: email || '',
                line_items: items,
            }],
        },
    };

    const body = JSON.stringify(orderPayload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const path = `/api/stores/${config.SHIPPINGEASY_STORE_API_KEY}/orders`;
    const params = {
        api_key: config.SHIPPINGEASY_API_KEY,
        api_timestamp: timestamp,
    };

    const signature = signRequest('POST', path, params, body);
    const sortedParams = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const url = `https://app.shippingeasy.com${path}?${sortedParams}&api_signature=${signature}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`ShippingEasy order creation failed: ${response.status} — ${errorText}`);
            await sendEmbed('OPS', {
                title: '⚠️ ShippingEasy Order Failed',
                description: `Could not create order for **${email || 'unknown'}**.\n\n**Error:** ${response.status} — ${errorText.slice(0, 200)}`,
                color: 0xff0000,
            }).catch(() => {});
            return null;
        }

        const data = await response.json();
        const orderId = data.order?.id || data.id || null;
        console.log(`ShippingEasy order created: ${orderId} for ${email}`);
        return orderId ? String(orderId) : null;
    } catch (e) {
        console.error('ShippingEasy order creation error:', e.message);
        await sendEmbed('OPS', {
            title: '⚠️ ShippingEasy Order Error',
            description: `Failed to create order for **${email || 'unknown'}**.\n\n**Error:** ${e.message}`,
            color: 0xff0000,
        }).catch(() => {});
        return null;
    }
}

/**
 * Cancel an unshipped ShippingEasy order.
 *
 * Used when a Stripe refund is issued for a physical order that has not
 * shipped yet — kills the order so it does not get printed and shipped.
 *
 * Resilient: never throws. Returns `true` on success (HTTP 200/204) or when
 * the order is already gone (404). Returns `false` for unexpected failures
 * and posts to #ops so the operator knows manual cleanup may be needed.
 */
async function cancelOrder({ orderId, sessionId = null, email = null }) {
    if (!config.SHIPPINGEASY_API_KEY || !config.SHIPPINGEASY_API_SECRET || !config.SHIPPINGEASY_STORE_API_KEY) {
        console.log('ShippingEasy API not configured — skipping order cancellation');
        return false;
    }

    if (!orderId) return false;

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const path = `/api/stores/${config.SHIPPINGEASY_STORE_API_KEY}/orders/${orderId}/cancellations`;
    const params = {
        api_key: config.SHIPPINGEASY_API_KEY,
        api_timestamp: timestamp,
    };
    const body = JSON.stringify({});
    const signature = signRequest('POST', path, params, body);
    const sortedParams = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const url = `https://app.shippingeasy.com${path}?${sortedParams}&api_signature=${signature}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });

        if (response.ok) {
            console.log(`ShippingEasy order canceled: ${orderId}${sessionId ? ` (session ${sessionId})` : ''}`);
            return true;
        }

        // 404 means the order is already gone — treat as success so we mark canceled in our DB.
        if (response.status === 404) {
            console.log(`ShippingEasy order ${orderId} already gone (404) — treating as canceled`);
            return true;
        }

        const errorText = await response.text();
        console.error(`ShippingEasy order cancellation failed: ${response.status} — ${errorText}`);
        await sendEmbed('OPS', {
            title: '⚠️ ShippingEasy Cancel Failed',
            description: `Could not cancel order **${orderId}**${email ? ` for **${email}**` : ''}. The Stripe refund went through — manually cancel in ShippingEasy.\n\n**Error:** ${response.status} — ${errorText.slice(0, 200)}`,
            color: 0xff0000,
        }).catch(() => {});
        return false;
    } catch (e) {
        console.error('ShippingEasy order cancellation error:', e.message);
        await sendEmbed('OPS', {
            title: '⚠️ ShippingEasy Cancel Error',
            description: `Failed to cancel order **${orderId}**${email ? ` for **${email}**` : ''}. The Stripe refund went through — manually cancel in ShippingEasy.\n\n**Error:** ${e.message}`,
            color: 0xff0000,
        }).catch(() => {});
        return false;
    }
}

export { signRequest, splitName, createOrder, cancelOrder };
