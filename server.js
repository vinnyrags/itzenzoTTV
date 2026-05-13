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
import { battles, cardListings, purchases, discordLinks, stripeEvents, activityEvents } from './db.js';
import {
    handleCheckoutCritical,
    handleCheckoutNotifications,
    handleCheckoutCompleted,
    notifyCatalogProductDeactivated,
    priceEventProductId,
} from './webhooks/stripe.js';
import { propagateRefund } from './lib/refund-propagator.js';
import { handleRefundEvent, handleDisputeEvent } from './lib/refund-bridge.js';
import { handleTwitchWebhook } from './webhooks/twitch.js';
import { handleShippingEasyWebhook } from './webhooks/shippingeasy.js';
import { createLimiter } from './webhook-limiter.js';
import { metadataFor as tosMetadataFor, CURRENT_VERSION as CURRENT_TOS_VERSION } from './lib/tos-acceptance.js';

/**
 * Attach the buyer's ToS acceptance audit fields to a Stripe Checkout
 * Session params object, and mirror the full metadata onto
 * payment_intent_data.metadata so disputes filed against the
 * PaymentIntent (which is where Stripe's dispute portal points)
 * carry the same record the Session does. No-op for the audit fields
 * when discordUserId is empty / has no acceptance row.
 *
 * Mutates and returns the params object.
 */
function applyTosMetadata(params, discordUserId) {
    const tos = tosMetadataFor(discordUserId);
    params.metadata = { ...(params.metadata || {}), ...tos };
    params.payment_intent_data = {
        ...(params.payment_intent_data || {}),
        metadata: { ...params.metadata },
    };
    return params;
}
import { addClient, broadcast as broadcastQueue, clientCount } from './lib/queue-broadcaster.js';
import { updateQueueChannelEmbed } from './commands/queue.js';
import { updateDuckRaceEmbed } from './lib/duck-race-embed.js';
import { client as discordClient } from './discord.js';

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

/**
 * Pre-flight check: probe that a stored Stripe price ID is retrievable
 * AND active in the current mode. Mirrors the WP-side
 * StripeService::findFirstInactivePriceId defense — without it, a
 * battle row carrying a test-mode or archived price ID throws inside
 * stripe.checkout.sessions.create, the buyer sees a generic error, and
 * the actual cause is buried in catch logs.
 *
 * Returns null when OK, or `{ code, message }` when blocked.
 */
async function preflightPriceActive(stripe, priceId) {
    try {
        const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
        if (!price.active) {
            return { code: 'price_inactive', message: 'The pack-battle product is archived in Stripe.' };
        }
        if (price.product && typeof price.product !== 'string' && !price.product.active) {
            return { code: 'product_inactive', message: 'The pack-battle product is archived in Stripe.' };
        }
        return null;
    } catch (e) {
        if (
            e?.type === 'StripeInvalidRequestError' &&
            /No such price/i.test(e?.message || '')
        ) {
            return {
                code: 'price_not_found',
                message: 'The pack-battle product is not available in this Stripe mode.',
                detail: e.message,
            };
        }
        // Network / auth / rate limit — let the main createCheckoutSession
        // call surface the real error through its own catch.
        return null;
    }
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

    // L3 service-integration tests fire real Stripe events to exercise the
    // full webhook pipeline. Stripe forwards every event to ALL configured
    // endpoints — including production's. The local test instance asserts
    // its own SQLite state; production must never process or announce.
    // Test-fired events carry metadata.test='1' as the marker. We guard
    // only on production (NODE_ENV='production' is set by systemd) so the
    // local test Nous still processes normally for its assertions.
    if (
        process.env.NODE_ENV === 'production' &&
        event?.data?.object?.metadata?.test === '1'
    ) {
        console.log(`[stripe] skipping test event ${event.id} on production`);
        return res.sendStatus(200);
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

// charge → session resolution + dispatch to propagateRefund lives in
// lib/refund-bridge.js so the two narrow responsibilities (resolve session,
// hand to propagator) can be tested without booting the express server.

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
// Live queue — WP fires `queue.changed` events; we relay them to all
// connected SSE clients (the itzenzo.tv homepage LIVE QUEUE section).
// RTS card-view requests are queue entries (`type=rts`) and arrive on the
// same channel as orders/pack-battles/pull-boxes — no separate webhook.
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

        // Refresh the Discord #queue embed for the affected session. Without
        // this, website-originated entries (RTS submissions, future WP-direct
        // flows) only update the homepage Live Queue via SSE — the Discord
        // embed silently stays stale because nothing on the Discord side
        // observes the WP-level action. Discord-source entries (orders, pull-
        // box buys, battle entries via Stripe webhooks) already refresh the
        // embed in their addToQueue handler, so this is a redundant no-op
        // for those paths; the WP-source case is the load-bearing one.
        const dataObj = data ?? {};
        let sessionId = null;
        if (event.startsWith('entry.') && dataObj.rawEntry && dataObj.rawEntry.sessionId) {
            sessionId = Number(dataObj.rawEntry.sessionId);
        } else if (event === 'roster.updated' && dataObj.sessionId) {
            sessionId = Number(dataObj.sessionId);
        } else if (event.startsWith('session.') && dataObj.session && dataObj.session.id) {
            sessionId = Number(dataObj.session.id);
        }
        if (sessionId) {
            // Fire-and-forget — don't block the webhook response on Discord
            // rate limits or transient failures. The next queue mutation
            // will retry the refresh anyway.
            updateQueueChannelEmbed(sessionId).catch((e) => {
                console.error(`queue-changed embed refresh failed for session ${sessionId}:`, e.message);
            });
            // Same fire-and-forget for the #duck-race embed. roster.updated
            // events fire it; entry.* and session.* events also fire it
            // (status flips, winner declarations, etc.). updateDuckRaceEmbed
            // silently noops when CHANNELS.DUCK_RACE is unset, so dev
            // environments without the channel configured don't break.
            updateDuckRaceEmbed(sessionId).catch((e) => {
                console.error(`queue-changed duck-race embed refresh failed for session ${sessionId}:`, e.message);
            });
        }

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

// =========================================================================
// Card offers — WP fires `card.offer_received` when a buyer submits the
// /collection Make-an-Offer form. We DM the operator (with #ops fallback)
// and broadcast an activity envelope for the homepage feed.
// =========================================================================

app.post('/webhooks/card-offer-received', express.json({ limit: '64kb' }), async (req, res) => {
    const providedSecret = req.get('X-Bot-Secret') || '';
    if (!config.LIVESTREAM_SECRET || providedSecret !== config.LIVESTREAM_SECRET) {
        return res.sendStatus(403);
    }

    const { event, data } = req.body || {};
    if (event !== 'card.offer_received' || !data) {
        return res.sendStatus(400);
    }

    // Ack first, fan out async — same pattern as queue-changed. Discord
    // API can be slow and we don't want to hold the WP socket open.
    res.sendStatus(200);

    try {
        const { handleCardOffer } = await import('./handlers/cardOffer.js');
        await handleCardOffer({ data, client: discordClient });
    } catch (e) {
        console.error('card-offer dispatch failed:', e.message);
    }
});

// Backfill endpoint for the itzenzo.tv homepage Activity Feed. Returns
// the most-recent `limit` persisted events (default 50, capped at 200)
// in chronological order — most recent FIRST, matching the frontend's
// expected ordering. Public read-only; rate limits handled by the
// frontend's natural cache behavior (only fires on page mount).
//
// Persistence happens in lib/queue-broadcaster.js's broadcast(): every
// event flowing through SSE is also written to the activity_events
// SQLite table. So this endpoint is the canonical answer to "what
// happened that the feed missed because the bot restarted / the buyer
// just opened the page".
app.get('/activity/recent', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const requested = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, 200)
        : 50;
    try {
        const rows = activityEvents.recent.all(limit);
        const events = rows.map((row) => {
            let data = {};
            try { data = JSON.parse(row.data || '{}'); } catch { /* fall through to empty */ }
            return { id: row.id, event: row.event, data, createdAt: row.created_at };
        });
        res.json({ events });
    } catch (e) {
        console.error('activity/recent query failed:', e.message);
        res.status(500).json({ error: 'activity feed unavailable' });
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

        // Pre-flight inactive-price check before any session work.
        const preflight = await preflightPriceActive(stripe, battle.stripe_price_id);
        if (preflight) {
            console.error(
                `Battle checkout pre-flight blocked: ${preflight.code} | priceId=${battle.stripe_price_id} | battleId=${battle.id}`,
                preflight.detail || '',
            );
            return res
                .status(503)
                .send('This pack battle is not available right now — the operator has been notified.');
        }

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
            if (link) {
                params.customer_email = link.customer_email;
                // Receipts to the buyer's address — fulfills the
                // "you'll get a Stripe receipt for every purchase"
                // claim on /how-it-works/buying. receipt_email is a
                // separate Stripe field from customer_email; both
                // need to be set for the prefill + receipt to flow.
                params.receipt_email = link.customer_email;
            }
        }

        // No shipping on battle buy-in — only the winner gets shipped product.
        // Winner's shipping is handled after /battle winner declaration.

        applyTosMetadata(params, discordUserId);
        const session = await stripe.checkout.sessions.create(params);

        res.redirect(303, session.url);
    } catch (e) {
        console.error(
            `Battle checkout error: ${e?.constructor?.name || 'Error'}: ${e.message} | priceId=${battle.stripe_price_id} | battleId=${battle.id}`,
        );
        // Backstop for the inactive-price race (pre-flight passed but
        // Stripe archived between then and now).
        if (/No such price/i.test(e?.message || '')) {
            return res
                .status(503)
                .send('This pack battle is not available right now — the operator has been notified.');
        }
        res.status(500).send('Checkout failed. Try again or purchase from the shop directly.');
    }
});

// =========================================================================
// Pack battle WEB buy-in — POST endpoint for itzenzo.tv homepage flow.
// Mirrors the Discord GET /battle/checkout/:id flow but for buyers without
// a Discord identity. Returns { url } JSON so the frontend can redirect.
// ToS acceptance happens via the modal click on the homepage; we capture
// the audit fields (version + timestamp + IP + UA) inline here since web
// buyers don't have a tos_acceptances row to look up.
// =========================================================================

app.post('/web/battle/checkout', express.json(), async (req, res) => {
    const battle = battles.getActiveBattle.get();

    if (!battle || !battle.stripe_price_id) {
        return res.status(404).json({
            error: 'no_active_battle',
            message: 'No active pack battle right now.',
        });
    }

    const submittedVersion = String(req.body?.terms_version || '').trim();
    if (!submittedVersion) {
        return res.status(400).json({
            error: 'terms_not_accepted',
            message: 'Please accept the Terms of Service & Refund Policy before checking out.',
        });
    }
    if (submittedVersion !== CURRENT_TOS_VERSION) {
        return res.status(400).json({
            error: 'terms_version_outdated',
            message: `The Terms of Service have been updated since you opened the page. Refresh and re-accept the current version (v${CURRENT_TOS_VERSION}) to continue.`,
            current_version: CURRENT_TOS_VERSION,
            submitted: submittedVersion,
        });
    }

    try {
        const stripe = new Stripe(config.STRIPE_SECRET_KEY);

        // Pre-flight inactive-price check before any session work.
        const preflight = await preflightPriceActive(stripe, battle.stripe_price_id);
        if (preflight) {
            console.error(
                `Web battle checkout pre-flight blocked: ${preflight.code} | priceId=${battle.stripe_price_id} | battleId=${battle.id}`,
                preflight.detail || '',
            );
            return res.status(503).json({
                error: 'battle_unavailable',
                message: "This pack battle isn't available right now — the operator has been notified. Try again in a moment.",
                priceId: battle.stripe_price_id,
            });
        }

        // Build web-buyer ToS audit fields on the fly. Same shape as
        // the WP-side TouAcceptance::validate audit record so dispute
        // defense looks identical regardless of buy surface.
        const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const remoteIp = xff || req.socket?.remoteAddress || 'unknown';
        const userAgent = String(req.headers['user-agent'] || 'unknown').slice(0, 500);
        const tosMetadata = {
            terms_version: CURRENT_TOS_VERSION,
            terms_accepted_at: new Date().toISOString(),
            terms_accepted_source: 'web',
            terms_accepted_ip: remoteIp,
            terms_accepted_ua: userAgent,
        };

        const params = {
            mode: 'payment',
            line_items: [{ price: battle.stripe_price_id, quantity: 1 }],
            allow_promotion_codes: true,
            success_url: `${config.SHOP_URL}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${config.SHOP_URL}/?cancelled=1`,
            metadata: {
                battle_id: String(battle.id),
                source: 'pack-battle',
                discord_user_id: '',
                ...tosMetadata,
            },
            // Web buyers always get the Discord-username field (same as
            // the Discord flow when no ?user= is supplied) so the bot
            // can match their entry post-purchase if they have an account.
            custom_fields: customFieldsFor(null),
        };
        params.payment_intent_data = {
            metadata: { ...params.metadata },
        };

        const session = await stripe.checkout.sessions.create(params);
        res.json({ url: session.url });
    } catch (e) {
        console.error(
            `Web battle checkout error: ${e?.constructor?.name || 'Error'}: ${e.message} | priceId=${battle.stripe_price_id} | battleId=${battle.id}`,
        );
        // Backstop for the inactive-price race (pre-flight passed but
        // Stripe archived between then and now).
        if (/No such price/i.test(e?.message || '')) {
            return res.status(503).json({
                error: 'battle_unavailable',
                message: "This pack battle isn't available right now — the operator has been notified. Try again in a moment.",
                priceId: battle.stripe_price_id,
            });
        }
        res.status(502).json({
            error: 'checkout_failed',
            message: 'Could not start checkout: ' + e.message,
        });
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
            if (link) {
                params.customer_email = link.customer_email;
                // Receipts to the buyer's address — fulfills the
                // "you'll get a Stripe receipt for every purchase"
                // claim on /how-it-works/buying. receipt_email is a
                // separate Stripe field from customer_email; both
                // need to be set for the prefill + receipt to flow.
                params.receipt_email = link.customer_email;
            }
        }

        // Conditional shipping: skip if buyer already covered this period
        const covered = discordUserId
            ? hasShippingCoveredByDiscordId(discordUserId)
            : false;

        if (!covered) {
            params.shipping_options = buildShippingOptions(discordUserId);
            params.shipping_address_collection = { allowed_countries: config.SHIPPING.COUNTRIES };
        }

        applyTosMetadata(params, discordUserId);
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

app.get('/pull-box/checkout', async (req, res) => {
    const wpPullBox = await import('./lib/wp-pull-box.js');

    let box;
    try {
        box = await wpPullBox.getActiveBox();
    } catch (e) {
        console.error('Pull-box service unreachable:', e.message);
        return res.status(503).send('Pull-box service unavailable. Try again in a moment.');
    }
    if (!box) {
        return res.status(404).send('No pull box is currently open.');
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
                discord_user_id: discordUserId || '',
            },
            custom_fields: customFieldsFor(discordUserId),
        };

        // Prefill email for linked buyers
        if (discordUserId) {
            const link = purchases.getEmailByDiscordId.get(discordUserId);
            if (link) {
                params.customer_email = link.customer_email;
                // Receipts to the buyer's address — fulfills the
                // "you'll get a Stripe receipt for every purchase"
                // claim on /how-it-works/buying. receipt_email is a
                // separate Stripe field from customer_email; both
                // need to be set for the prefill + receipt to flow.
                params.receipt_email = link.customer_email;
            }
        }

        const covered = discordUserId ? hasShippingCoveredByDiscordId(discordUserId) : false;
        if (!covered) {
            params.shipping_options = buildShippingOptions(discordUserId);
            params.shipping_address_collection = { allowed_countries: config.SHIPPING.COUNTRIES };
        }

        applyTosMetadata(params, discordUserId);
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
            if (link) {
                params.customer_email = link.customer_email;
                // Receipts to the buyer's address — fulfills the
                // "you'll get a Stripe receipt for every purchase"
                // claim on /how-it-works/buying. receipt_email is a
                // separate Stripe field from customer_email; both
                // need to be set for the prefill + receipt to flow.
                params.receipt_email = link.customer_email;
            }
        }

        // Conditional shipping based on buyer identity
        const covered = discordUserId
            ? hasShippingCoveredByDiscordId(discordUserId)
            : false;

        if (!covered) {
            params.shipping_options = buildShippingOptions(discordUserId);
            params.shipping_address_collection = { allowed_countries: config.SHIPPING.COUNTRIES };
        }

        applyTosMetadata(params, discordUserId);
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
        const params = {
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
        };
        // Prefill email + send receipt for linked buyers (matches the
        // pattern in every other Stripe session.create above).
        if (req.query.user) {
            const link = purchases.getEmailByDiscordId.get(req.query.user);
            if (link) {
                params.customer_email = link.customer_email;
                params.receipt_email = link.customer_email;
            }
        }
        applyTosMetadata(params, req.query.user);
        const session = await stripe.checkout.sessions.create(params);

        res.redirect(303, session.url);
    } catch (e) {
        console.error('Shipping checkout error:', e.message);
        res.status(500).send('Could not create shipping form. Contact a mod.');
    }
});

// =========================================================================
// Shipping status lookup — check if a buyer has shipping covered
// =========================================================================

/**
 * Compute the shipping lookup result for a buyer's email. Shared
 * between the GET /shipping/lookup status check and the POST
 * /shipping/start-checkout flow so both surfaces apply the same
 * coverage logic + rate selection.
 *
 * Coverage requires Discord-link verification on purpose — see the
 * inline note on the `covered` line below. Returns null only if the
 * email itself is empty/invalid; otherwise always returns a populated
 * lookup object the caller can act on.
 */
function computeShippingLookup(email) {
    if (!email) return null;
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;

    const intl = isInternationalByEmail(normalized);
    const link = purchases.getDiscordIdByEmail.get(normalized);
    const known = !!link;
    const countryRow = link ? discordLinks.getCountry.get(link.discord_user_id) : null;
    const countryKnown = countryRow?.country != null;

    // Coverage requires Discord-link verification — without it, any buyer
    // could enter another buyer's email at the cart and inherit a free-
    // shipping period that wasn't theirs. The link gate ensures the buyer
    // we're crediting is the same identity that paid for shipping in the
    // first place. Internal callers that already know the buyer's Discord
    // identity (webhooks, `/shipping`) use `hasShippingCoveredByDiscordId`
    // which keys on the Discord id, not the email, and so isn't affected.
    const covered = known && hasShippingCovered(normalized);

    const rate = covered ? 0 : (intl ? config.SHIPPING.INTERNATIONAL : config.SHIPPING.DOMESTIC);
    const label = intl ? 'International Shipping' : 'Standard Shipping (US)';

    return { email: normalized, known, covered, international: intl, countryKnown, rate, label };
}

app.get('/shipping/lookup', (req, res) => {
    const lookup = computeShippingLookup(req.query.email);
    if (!lookup) {
        return res.status(400).json({ error: 'Missing email parameter' });
    }
    res.json(lookup);
});

// =========================================================================
// No-Discord shipping payment — buyer enters their email on itzenzo.tv,
// we look up what they owe server-side (no URL-trusted amount), and
// return either a "covered" message or a Stripe Checkout URL.
//
// Replaces the URL-trusting GET /shipping/checkout for non-Discord buyers.
// The GET stays in place for backwards compat with the Discord-flow
// settlement DMs (which already include the correct ?amount=).
// =========================================================================

app.post('/shipping/start-checkout', express.json(), async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
    }

    const lookup = computeShippingLookup(email);
    if (!lookup) {
        return res.status(400).json({ error: 'Invalid email.' });
    }

    if (lookup.covered) {
        return res.json({
            status: 'covered',
            message: "You're already covered for this period — nothing owed.",
            international: lookup.international,
        });
    }

    // Rate is computed server-side from getShippingLookup — never
    // trust an amount passed by the client. This is the security
    // upgrade vs the legacy GET /shipping/checkout, which accepts
    // ?amount= from the URL.
    const amountCents = lookup.rate * 100;
    const reason = lookup.international
        ? 'International Shipping (period coverage)'
        : 'Standard Shipping (period coverage)';

    try {
        const stripe = new Stripe(config.STRIPE_SECRET_KEY);
        const params = {
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
                source: 'web-shipping-payment',
                buyer_email: email,
            },
            customer_email: email,
            // Stripe-issued receipt regardless of Discord link state —
            // the whole point of this flow is to serve buyers who
            // don't use Discord.
            receipt_email: email,
            shipping_address_collection: { allowed_countries: config.SHIPPING.COUNTRIES },
        };
        // ToS audit fields — when called via the WP-side proxy, WP's
        // TouAcceptance::validate has already verified terms_version
        // and produced the audit array. We accept it from the request
        // body and mirror to session.metadata + PI metadata. Internal
        // direct callers (none today, but possible) can skip it; the
        // session just won't carry the audit, which is fine for
        // dispute defense — the buyer never paid without acknowledging.
        const tosMetadata = (req.body?.tos_metadata && typeof req.body.tos_metadata === 'object')
            ? req.body.tos_metadata
            : null;
        if (tosMetadata) {
            params.metadata = { ...params.metadata, ...tosMetadata };
            params.payment_intent_data = { metadata: { ...params.metadata } };
        }
        const session = await stripe.checkout.sessions.create(params);

        res.json({ status: 'checkout', url: session.url, amount_cents: amountCents });
    } catch (e) {
        console.error('Web shipping checkout error:', e.message);
        res.status(500).json({ error: 'Could not create checkout session. Try again.' });
    }
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
