/**
 * Express server for webhook endpoints.
 *
 * Routes:
 *   POST /webhooks/stripe    — Stripe checkout events
 *   POST /webhooks/twitch    — Twitch EventSub events
 *   GET  /battle/checkout/:id     — Direct checkout for pack battle buy-in
 *   GET  /shipping/lookup         — Check shipping coverage by email
 *   GET  /health                  — Health check
 */

import express from 'express';
import Stripe from 'stripe';
import config from './config.js';
import { battles, cardListings, purchases, discordLinks, stripeEvents } from './db.js';
import {
    handleCheckoutCritical,
    handleCheckoutNotifications,
    handleCheckoutCompleted,
    notifyCatalogProductDeactivated,
    priceEventProductId,
} from './webhooks/stripe.js';
import { propagateRefund } from './lib/refund-propagator.js';
import { handleTwitchWebhook } from './webhooks/twitch.js';
import { handleShippingEasyWebhook } from './webhooks/shippingeasy.js';
import { handleCardRequestCritical, handleCardRequestNotifications } from './webhooks/card-request.js';
import { createLimiter } from './webhook-limiter.js';
import { addClient, broadcast as broadcastQueue, clientCount } from './lib/queue-broadcaster.js';

const webhookLimit = createLimiter(10);
import {
    isInternationalByEmail,
    hasShippingCoveredByDiscordId,
    hasShippingCovered,
    getShippingLabel,
    buildShippingOptions,
} from './shipping.js';

const app = express();

/**
 * Stripe custom field for Discord username — only shown when the buyer
 * isn't already known via Discord (no ?user= query param).
 */
const discordUsernameField = {
    key: 'discord_username',
    label: { type: 'custom', custom: 'Discord username' },
    type: 'text',
    optional: true,
};

function customFieldsFor(discordUserId) {
    return discordUserId ? [] : [discordUsernameField];
}

// =========================================================================
// Stripe webhook — needs raw body for signature verification
// =========================================================================

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;

    if (config.STRIPE_WEBHOOK_SECRET) {
        const stripe = new Stripe(config.STRIPE_SECRET_KEY);
        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                req.headers['stripe-signature'],
                config.STRIPE_WEBHOOK_SECRET
            );
        } catch (e) {
            console.error('Stripe signature verification failed:', e.message);
            return res.status(400).send('Invalid signature');
        }
    } else {
        event = JSON.parse(req.body);
    }

    // Belt-and-suspenders: dedup on event.id even before we hit any handler.
    // Stripe re-delivers events on non-2xx OR connection-timeout, and we
    // already 2xx fast — but a slow phase-1 in handleCheckoutCritical
    // could race with a retry. INSERT OR IGNORE makes the first delivery
    // win; subsequent retries short-circuit with a clean 200.
    if (event?.id) {
        const claimed = stripeEvents.claimEvent.run(event.id);
        if (claimed.changes === 0) {
            console.log(`Stripe event ${event.id} already processed — skipping`);
            return res.sendStatus(200);
        }
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                // Phase 1: Critical path — record purchase, respond to Stripe fast
                // Limiter bounds concurrent DB operations to prevent event loop stalls
                const context = await webhookLimit(() => handleCheckoutCritical(event.data.object));
                res.sendStatus(200);

                // Phase 2: Notifications — fire-and-forget after responding to Stripe
                if (context) {
                    handleCheckoutNotifications(event.data.object, context).catch(e =>
                        console.error('Notification error:', e.message)
                    );
                }
                return;
            }
            // Catalog drift: when Stripe drops a product (or its price)
            // out of "purchasable" state, push that into WP immediately
            // so a stale cart never reaches Stripe checkout. 200 first,
            // then fire-and-forget the WP notify so a slow WP can't
            // delay our Stripe response.
            case 'product.updated': {
                const product = event.data.object;
                const wasActive = event.data.previous_attributes?.active;
                res.sendStatus(200);
                if (product?.active === false && wasActive === true) {
                    notifyCatalogProductDeactivated(product.id).catch(e =>
                        console.error('catalog notify error:', e.message)
                    );
                }
                return;
            }
            case 'product.deleted': {
                const product = event.data.object;
                res.sendStatus(200);
                if (product?.id) {
                    notifyCatalogProductDeactivated(product.id).catch(e =>
                        console.error('catalog notify error:', e.message)
                    );
                }
                return;
            }
            case 'price.updated': {
                const price = event.data.object;
                const wasActive = event.data.previous_attributes?.active;
                res.sendStatus(200);
                if (price?.active === false && wasActive === true) {
                    const productId = priceEventProductId(price);
                    if (productId) {
                        notifyCatalogProductDeactivated(productId).catch(e =>
                            console.error('catalog notify error:', e.message)
                        );
                    }
                }
                return;
            }
            case 'price.deleted': {
                const price = event.data.object;
                res.sendStatus(200);
                const productId = priceEventProductId(price);
                if (productId) {
                    notifyCatalogProductDeactivated(productId).catch(e =>
                        console.error('catalog notify error:', e.message)
                    );
                }
                return;
            }
            // Refund triggered from the Stripe Dashboard / API. The event
            // carries a charge object with the payment_intent; we map back
            // to the originating checkout session by looking it up against
            // the payment_intent. 200 first, then propagate fire-and-forget.
            case 'charge.refunded': {
                const charge = event.data.object;
                res.sendStatus(200);
                handleRefundEvent(charge, 'webhook_refund').catch(e =>
                    console.error('refund propagation error:', e.message)
                );
                return;
            }
            // Dispute opened — funds may already be withheld by Stripe. Treat
            // like a refund for queue / shipping purposes; do NOT DM the buyer.
            case 'charge.dispute.created': {
                const dispute = event.data.object;
                res.sendStatus(200);
                handleDisputeEvent(dispute).catch(e =>
                    console.error('dispute propagation error:', e.message)
                );
                return;
            }
            // Dispute closed — outcome carried in `status`. Refund-the-buyer
            // outcomes (`lost`) are propagation no-ops because the charge
            // is already refunded; merchant-won outcomes don't trigger anything.
            case 'charge.dispute.closed': {
                const dispute = event.data.object;
                res.sendStatus(200);
                console.log(`charge.dispute.closed status=${dispute.status} for charge=${dispute.charge}`);
                return;
            }
            default:
                console.log('Unhandled Stripe event:', event.type);
        }
    } catch (e) {
        console.error('Error handling Stripe event:', e.message);
    }

    res.sendStatus(200);
});

/**
 * Resolve a Stripe charge → checkout session id by querying the sessions
 * list with payment_intent. Returns null when no matching session exists
 * (charge could be from a non-checkout flow — payment links, invoices —
 * we only care about checkout-session-driven purchases).
 */
async function chargeSessionId(charge) {
    const stripe = new Stripe(config.STRIPE_SECRET_KEY);
    const paymentIntentId = typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : charge.payment_intent?.id;
    if (!paymentIntentId) return null;
    try {
        const list = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
        return list.data?.[0]?.id || null;
    } catch (e) {
        console.error(`Could not resolve session for payment_intent ${paymentIntentId}:`, e.message);
        return null;
    }
}

async function handleRefundEvent(charge, source) {
    const sessionId = await chargeSessionId(charge);
    if (!sessionId) {
        console.log(`refund: no checkout session for charge ${charge.id} — ignoring`);
        return;
    }
    const totalRefunded = charge.amount_refunded || 0;
    const isFull = totalRefunded >= charge.amount;
    await propagateRefund(sessionId, {
        source,
        amountCents: isFull ? null : totalRefunded,
        reason: charge.refunds?.data?.[0]?.reason || null,
        refundId: charge.refunds?.data?.[0]?.id || null,
    });
}

async function handleDisputeEvent(dispute) {
    const stripe = new Stripe(config.STRIPE_SECRET_KEY);
    let charge = null;
    try {
        charge = await stripe.charges.retrieve(typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id);
    } catch (e) {
        console.error(`Could not retrieve charge ${dispute.charge} for dispute:`, e.message);
        return;
    }
    const sessionId = await chargeSessionId(charge);
    if (!sessionId) {
        console.log(`dispute: no checkout session for charge ${charge.id} — ignoring`);
        return;
    }
    await propagateRefund(sessionId, {
        source: 'webhook_dispute',
        amountCents: dispute.amount || charge.amount,
        reason: `Dispute ${dispute.reason || 'unknown'} — ${dispute.status}`,
        refundId: dispute.id,
    });
}

// =========================================================================
// Twitch webhook — needs raw body for signature verification
// =========================================================================

app.post('/webhooks/twitch', express.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString(); },
}), handleTwitchWebhook);

// =========================================================================
// ShippingEasy webhook — tracking info from label purchases
// =========================================================================

app.post('/webhooks/shippingeasy', express.json(), handleShippingEasyWebhook);

// =========================================================================
// Card view request — WordPress pings us when a shopper queues a card
// =========================================================================

app.post('/webhooks/card-request-notify', express.json(), async (req, res) => {
    const providedSecret = req.get('X-Bot-Secret') || '';
    if (config.LIVESTREAM_SECRET && providedSecret !== config.LIVESTREAM_SECRET) {
        return res.sendStatus(403);
    }

    try {
        const context = await webhookLimit(() => handleCardRequestCritical(req.body));
        res.sendStatus(200);

        if (context) {
            handleCardRequestNotifications(req.body, context).catch((e) =>
                console.error('Card request notification error:', e.message),
            );
        }
    } catch (e) {
        console.error('Card request webhook error:', e.message);
        res.sendStatus(200);
    }
});

// =========================================================================
// Live queue — WP fires `queue.changed` events; we relay them to all
// connected SSE clients (the itzenzo.tv homepage LIVE QUEUE section).
// =========================================================================

app.post('/webhooks/queue-changed', express.json({ limit: '256kb' }), (req, res) => {
    const providedSecret = req.get('X-Bot-Secret') || '';
    if (!config.LIVESTREAM_SECRET || providedSecret !== config.LIVESTREAM_SECRET) {
        return res.sendStatus(403);
    }

    const { event, data } = req.body || {};
    if (typeof event !== 'string' || !event) {
        return res.sendStatus(400);
    }

    try {
        broadcastQueue(event, data ?? {});
        res.sendStatus(200);
    } catch (e) {
        console.error('queue-changed broadcast failed:', e.message);
        res.sendStatus(500);
    }
});

// =========================================================================
// Activity feed — display-ready event envelopes (pull-box claims, etc.)
// fired from WP. Producers in Nous itself (battles, coupons, pull-box
// lifecycle, low-stock, community goals) call broadcast() directly.
// =========================================================================

app.post('/webhooks/activity-changed', express.json({ limit: '64kb' }), (req, res) => {
    const providedSecret = req.get('X-Bot-Secret') || '';
    if (!config.LIVESTREAM_SECRET || providedSecret !== config.LIVESTREAM_SECRET) {
        return res.sendStatus(403);
    }

    const { event, data } = req.body || {};
    if (typeof event !== 'string' || !event) {
        return res.sendStatus(400);
    }

    try {
        broadcastQueue(event, data ?? {});
        res.sendStatus(200);
    } catch (e) {
        console.error('activity-changed broadcast failed:', e.message);
        res.sendStatus(500);
    }
});

app.get('/queue/stream', (req, res) => {
    res.set({
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache, no-transform',
        Connection:          'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 5000\n\n');

    const lastEventId = req.get('Last-Event-ID') || req.query.lastEventId || null;
    const cleanup = addClient(res, lastEventId);

    req.on('close', () => {
        cleanup();
        try { res.end(); } catch { /* already ended */ }
    });
});

// =========================================================================
// Pack battle direct checkout — creates a Stripe session and redirects
// =========================================================================

app.get('/battle/checkout/:id', async (req, res) => {
    const battle = battles.getActiveBattle.get();

    if (!battle || !battle.stripe_price_id) {
        return res.status(404).send('No active battle or no product linked.');
    }

    const discordUserId = req.query.user;

    // Prevent duplicate entries — one buy per user per battle
    if (discordUserId) {
        const existing = battles.getEntries.all(battle.id);
        if (existing.some((e) => e.discord_user_id === discordUserId)) {
            return res.status(400).send('You already entered this battle. One entry per person.');
        }
    }

    try {
        const stripe = new Stripe(config.STRIPE_SECRET_KEY);

        const params = {
            mode: 'payment',
            line_items: [{ price: battle.stripe_price_id, quantity: 1 }],
            allow_promotion_codes: true,
            success_url: `${config.SITE_URL}/shop/thank-you/`,
            cancel_url: config.SHOP_URL,
            metadata: {
                battle_id: String(battle.id),
                source: 'pack-battle',
                discord_user_id: discordUserId || '',
            },
            custom_fields: customFieldsFor(discordUserId),
        };

        // Prefill email for linked buyers
        if (discordUserId) {
            const link = purchases.getEmailByDiscordId.get(discordUserId);
            if (link) params.customer_email = link.customer_email;
        }

        // No shipping on battle buy-in — only the winner gets shipped product.
        // Winner's shipping is handled after !battle winner declaration.

        const session = await stripe.checkout.sessions.create(params);

        res.redirect(303, session.url);
    } catch (e) {
        console.error('Battle checkout error:', e.message);
        res.status(500).send('Checkout failed. Try again or purchase from the shop directly.');
    }
});

// =========================================================================
// =========================================================================
// Card shop checkout — creates a Stripe session for individual card sales
// =========================================================================

app.get('/card-shop/checkout/:listingId', async (req, res) => {
    const listing = cardListings.getById.get(Number(req.params.listingId));

    if (!listing || !['active', 'reserved', 'pull'].includes(listing.status)) {
        return res.status(404).send('This card is no longer available.');
    }

    try {
        const stripe = new Stripe(config.STRIPE_SECRET_KEY);
        const discordUserId = req.query.user;

        const isPull = listing.status === 'pull';
        const lineItem = {
            price_data: {
                currency: 'usd',
                product_data: { name: listing.card_name },
                unit_amount: listing.price,
            },
            quantity: 1,
        };

        if (isPull) {
            lineItem.adjustable_quantity = { enabled: true, minimum: 1, maximum: 20 };
        }

        const params = {
            mode: 'payment',
            line_items: [lineItem],
            allow_promotion_codes: true,
            success_url: `${config.SITE_URL}/shop/thank-you/`,
            cancel_url: config.SHOP_URL,
            metadata: {
                card_listing_id: String(listing.id),
                card_name: listing.card_name,
                source: 'card-sale',
                reserved_for: listing.buyer_discord_id || '',
                discord_user_id: discordUserId || '',
            },
            custom_fields: customFieldsFor(discordUserId),
        };

        // Prefill email for linked buyers
        if (discordUserId) {
            const link = purchases.getEmailByDiscordId.get(discordUserId);
            if (link) params.customer_email = link.customer_email;
        }

        // Conditional shipping: skip if buyer already covered this period
        const covered = discordUserId
            ? hasShippingCoveredByDiscordId(discordUserId)
            : false;

        if (!covered) {
            params.shipping_options = buildShippingOptions(discordUserId);
            params.shipping_address_collection = { allowed_countries: config.SHIPPING.COUNTRIES };
        }

        const session = await stripe.checkout.sessions.create(params);

        cardListings.setStripeSessionId.run(session.id, listing.id);
        res.redirect(303, session.url);
    } catch (e) {
        console.error('Card shop checkout error:', e.message);
        res.status(500).send('Checkout failed. Try again or contact a mod.');
    }
});

// =========================================================================
// Pull-box checkout — creates a Stripe session for a pull-box buy.
// Tier-based: looks up the active pull box for the tier, uses its
// configured Stripe price ID. Discord buyers don't pre-claim slots —
// the webhook auto-picks the lowest open slots after payment.
// =========================================================================

app.get('/pull-box/checkout/:tier', async (req, res) => {
    const tier = req.params.tier;
    if (!['v', 'vmax'].includes(tier)) {
        return res.status(400).send('Invalid tier. Must be v or vmax.');
    }

    const wpPullBox = await import('./lib/wp-pull-box.js');

    let box;
    try {
        box = await wpPullBox.getActiveBox(tier);
    } catch (e) {
        console.error('Pull-box service unreachable:', e.message);
        return res.status(503).send('Pull-box service unavailable. Try again in a moment.');
    }
    if (!box) {
        return res.status(404).send('No pull box is currently open for this tier.');
    }
    if (!box.stripePriceId) {
        console.error(`Pull box #${box.id} has no stripe_price_id — check shop settings ACF config`);
        return res.status(503).send('Pull box not fully configured. Contact a mod.');
    }

    const claimed = (box.claimedSlots || []).length;
    const remaining = box.totalSlots - claimed;
    if (remaining <= 0) {
        return res.status(409).send('Pull box is sold out.');
    }

    try {
        const stripe = new Stripe(config.STRIPE_SECRET_KEY);
        const discordUserId = req.query.user;

        const lineItem = {
            price: box.stripePriceId,
            quantity: 1,
            adjustable_quantity: {
                enabled: true,
                minimum: 1,
                maximum: Math.min(20, remaining),
            },
        };

        const params = {
            mode: 'payment',
            line_items: [lineItem],
            allow_promotion_codes: true,
            success_url: `${config.SHOP_URL}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: config.SHOP_URL,
            metadata: {
                source: 'pull_box',
                pull_box_id: String(box.id),
                tier,
                discord_user_id: discordUserId || '',
            },
            custom_fields: customFieldsFor(discordUserId),
        };

        // Prefill email for linked buyers
        if (discordUserId) {
            const link = purchases.getEmailByDiscordId.get(discordUserId);
            if (link) params.customer_email = link.customer_email;
        }

        const covered = discordUserId ? hasShippingCoveredByDiscordId(discordUserId) : false;
        if (!covered) {
            params.shipping_options = buildShippingOptions(discordUserId);
            params.shipping_address_collection = { allowed_countries: config.SHIPPING.COUNTRIES };
        }

        const session = await stripe.checkout.sessions.create(params);
        res.redirect(303, session.url);
    } catch (e) {
        console.error('Pull-box checkout error:', e.message);
        res.status(500).send('Checkout failed. Try again or contact a mod.');
    }
});

// =========================================================================
// Product direct checkout — creates a Stripe session for a product by price ID
// =========================================================================

app.get('/product/checkout/:priceId', async (req, res) => {
    try {
        const stripe = new Stripe(config.STRIPE_SECRET_KEY);
        const discordUserId = req.query.user;

        const params = {
            mode: 'payment',
            line_items: [{ price: req.params.priceId, quantity: 1 }],
            allow_promotion_codes: true,
            success_url: `${config.SITE_URL}/shop/thank-you/`,
            cancel_url: config.SHOP_URL,
            metadata: {
                source: 'hype-checkout',
                discord_user_id: discordUserId || '',
            },
            custom_fields: customFieldsFor(discordUserId),
        };

        // Prefill email for linked buyers
        if (discordUserId) {
            const link = purchases.getEmailByDiscordId.get(discordUserId);
            if (link) params.customer_email = link.customer_email;
        }

        // Conditional shipping based on buyer identity
        const covered = discordUserId
            ? hasShippingCoveredByDiscordId(discordUserId)
            : false;

        if (!covered) {
            params.shipping_options = buildShippingOptions(discordUserId);
            params.shipping_address_collection = { allowed_countries: config.SHIPPING.COUNTRIES };
        }

        const session = await stripe.checkout.sessions.create(params);

        res.redirect(303, session.url);
    } catch (e) {
        console.error('Product checkout error:', e.message);
        res.status(500).send('Checkout failed. Try again or visit the shop directly.');
    }
});

// =========================================================================
// Ad-hoc shipping checkout — creates a Stripe session for any amount
// =========================================================================

app.get('/shipping/checkout', async (req, res) => {
    const amountCents = parseInt(req.query.amount, 10);
    const reason = req.query.reason || 'Shipping';

    if (!amountCents || amountCents <= 0) {
        return res.status(400).send('Invalid shipping amount.');
    }

    // Guard against double-paying shipping
    const discordUserId = req.query.user;
    if (discordUserId && hasShippingCoveredByDiscordId(discordUserId)) {
        return res.status(200).send('Your shipping is already covered this period — no action needed!');
    }

    try {
        const stripe = new Stripe(config.STRIPE_SECRET_KEY);
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: reason,
                            description: `Shipping — $${(amountCents / 100).toFixed(2)}`,
                        },
                        unit_amount: amountCents,
                    },
                    quantity: 1,
                },
            ],
            success_url: `${config.SHOP_URL}?shipping_paid=1`,
            cancel_url: config.SHOP_URL,
            metadata: {
                source: 'ad-hoc-shipping',
                discord_user_id: req.query.user || '',
                reason,
            },
            shipping_address_collection: { allowed_countries: config.SHIPPING.COUNTRIES },
            custom_fields: customFieldsFor(req.query.user),
        });

        res.redirect(303, session.url);
    } catch (e) {
        console.error('Shipping checkout error:', e.message);
        res.status(500).send('Could not create shipping form. Contact a mod.');
    }
});

// =========================================================================
// Shipping status lookup — check if a buyer has shipping covered
// =========================================================================

app.get('/shipping/lookup', (req, res) => {
    const email = req.query.email?.trim().toLowerCase();
    if (!email) {
        return res.status(400).json({ error: 'Missing email parameter' });
    }

    const intl = isInternationalByEmail(email);

    // Check if we know this email and whether their country is flagged
    const link = purchases.getDiscordIdByEmail.get(email);
    const known = !!link;
    const countryRow = link ? discordLinks.getCountry.get(link.discord_user_id) : null;
    const countryKnown = countryRow?.country != null;

    // Coverage requires Discord-link verification — without it, any buyer
    // could enter another buyer's email at the cart and inherit a free-
    // shipping period that wasn't theirs. The link gate ensures the buyer
    // we're crediting is the same identity that paid for shipping in the
    // first place. Internal callers that already know the buyer's Discord
    // identity (webhooks, `!shipping`) use `hasShippingCoveredByDiscordId`
    // which keys on the Discord id, not the email, and so isn't affected.
    const covered = known && hasShippingCovered(email);

    const rate = covered ? 0 : (intl ? config.SHIPPING.INTERNATIONAL : config.SHIPPING.DOMESTIC);
    const label = intl ? 'International Shipping' : 'Standard Shipping (US)';

    res.json({ email, known, covered, international: intl, countryKnown, rate, label });
});

// =========================================================================
// Health check
// =========================================================================

app.get('/queue/stream/stats', (req, res) => {
    res.json({ connectedClients: clientCount() });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// =========================================================================
// Test suite endpoint
// =========================================================================

app.post('/test/run', async (req, res) => {
    try {
        const { runTestSuite } = await import('./commands/test.js');
        const flow = req.query.flow || undefined;
        const results = await runTestSuite(flow);
        const passed = results.filter(r => r.passed).length;
        res.json({ passed, total: results.length, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Start the Express server.
 *
 * Binds to 127.0.0.1 so the bot is only reachable through nginx on the
 * production host (nginx proxies /bot/ → http://127.0.0.1:3100/). External
 * traffic must hit nginx, which terminates TLS and applies any host-level
 * rate limiting before reaching the bot. Override via BOT_BIND_HOST=0.0.0.0
 * if a deployment needs the bot exposed directly on all interfaces.
 */
function startServer() {
    const host = config.BOT_BIND_HOST;
    app.listen(config.PORT, host, () => {
        console.log(`Webhook server listening on ${host}:${config.PORT}`);
    });
}

export { app, startServer };
