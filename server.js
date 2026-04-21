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
import { battles, cardListings, purchases, discordLinks } from './db.js';
import { handleCheckoutCritical, handleCheckoutNotifications, handleCheckoutCompleted } from './webhooks/stripe.js';
import { handleTwitchWebhook } from './webhooks/twitch.js';
import { handleShippingEasyWebhook } from './webhooks/shippingeasy.js';
import { createLimiter } from './webhook-limiter.js';

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
            default:
                console.log('Unhandled Stripe event:', event.type);
        }
    } catch (e) {
        console.error('Error handling Stripe event:', e.message);
    }

    res.sendStatus(200);
});

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
    const covered = hasShippingCovered(email);

    // Check if we know this email and whether their country is flagged
    const link = purchases.getDiscordIdByEmail.get(email);
    const known = !!link;
    const countryRow = link ? discordLinks.getCountry.get(link.discord_user_id) : null;
    const countryKnown = countryRow?.country != null;

    const rate = covered ? 0 : (intl ? config.SHIPPING.INTERNATIONAL : config.SHIPPING.DOMESTIC);
    const label = intl ? 'International Shipping' : 'Standard Shipping (US)';

    res.json({ email, known, covered, international: intl, countryKnown, rate, label });
});

// =========================================================================
// Health check
// =========================================================================

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
 */
function startServer() {
    app.listen(config.PORT, () => {
        console.log(`Webhook server listening on port ${config.PORT}`);
    });
}

export { app, startServer };
