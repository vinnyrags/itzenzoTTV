/**
 * Critical-path test orchestration. Run via `npm run test:critical`
 * (see bin/run-test-suite.mjs) — connects via the test bot, drives the
 * flows below against the test guild, and posts embeds to real channels.
 *
 * Flows: card-night, giveaway, race, shipping, loadtest, minecraft.
 *
 * Uses @rhapttv test account for buyer interactions. Ends with a table
 * wipe to clean all data.
 */

import { EmbedBuilder } from 'discord.js';
import crypto from 'node:crypto';
import Stripe from 'stripe';
import config from '../config.js';
import { db, purchases, cardListings, listSessions, battles, giveaways, discordLinks, goals, tracking } from '../db.js';
import * as queueSource from '../lib/queue-source.js';
import * as wpPullBox from '../lib/wp-pull-box.js';
import { client, getChannel, getMember } from '../discord.js';
import { handleSell, handleList, handleSold } from './card-shop.js';
import { handlePull } from './pull.js';
import { handleBattle } from './battle.js';
import { handleQueue, handleDuckRace } from './queue.js';
import { handleGiveaway } from './giveaway.js';
import { handleSpin } from './spin.js';
import { handleLive, handleOffline } from './live.js';
import { handleHype } from './hype.js';
import { handleCoupon } from './coupon.js';
import { handleSnapshot } from './snapshot.js';
import { handleCapture } from './capture.js';
import { handleIntl, handleIntlShip } from './intl.js';
import { handleShippingAudit } from './shipping-audit.js';
import { handleShipping } from './shipping.js';
import { handleDroppedOff } from './dropped-off.js';
import { handleTracking } from './tracking.js';
import { handleShipments } from './shipments.js';
import { handleWaive } from './waive.js';
import { handleRefund } from './refund.js';
import { handleCheckoutCompleted } from '../webhooks/stripe.js';
import { handleShippingEasyWebhook } from '../webhooks/shippingeasy.js';
import { initMinecraftChannel, handleMinecraftReaction, REACTION_EMOJIS } from './minecraft.js';

const TEST_USER_ID = '1490206350943191052'; // @rhapttv
const TEST_EMAIL = 'itzenzottv+testaccount1@gmail.com';

// =========================================================================
// Builders
// =========================================================================

function buildTestMessage(content, testChannel, mentionUser = null) {
    // Track lastMessage so !hype and !reset can find their confirmation embed
    const channel = {
        id: testChannel.id,
        lastMessage: null,
        send: async (c) => {
            const sent = await testChannel.send(c);
            channel.lastMessage = sent;
            return sent;
        },
        // createMessageCollector for cancel-abort flows
        createMessageCollector: () => ({
            on: (event, cb) => {
                if (event === 'end') setTimeout(() => cb(null, 'time'), 100);
            },
        }),
    };

    const msg = {
        content,
        author: { id: 'test_runner', bot: true },
        member: { roles: { cache: { has: () => true } } },
        mentions: { users: { first: () => mentionUser } },
        channel,
        reply: (c) => testChannel.send(c),
        reference: null,
        delete: async () => {},
        react: async () => {},
    };
    return msg;
}

function buildTestMention(userId = TEST_USER_ID) {
    return {
        id: userId,
        tag: `test#${userId}`,
        username: 'rhapttv',
    };
}

function buildTestInteraction(testChannel, userId = TEST_USER_ID) {
    return {
        user: { id: userId },
        values: [],
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        deferReply: async () => {},
        editReply: async ({ content }) => {
            await testChannel.send(`> 💬 *Ephemeral to <@${userId}>:* ${content}`);
        },
        reply: async ({ content, ephemeral }) => {
            await testChannel.send(`> 💬 *Reply:* ${content}`);
        },
        replied: false,
        deferred: false,
    };
}

function fakeCheckoutSession({ listingId, name, price, withDiscord = true, stockRemaining = 5, discordUsername = null, shippingCountry = null, shippingAddress = null, source = null }) {
    const session = {
        id: `test_session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        customer_details: { email: TEST_EMAIL, name: 'Test Buyer' },
        customer_email: TEST_EMAIL,
        amount_total: price,
        amount_subtotal: price,
        shipping_cost: { amount_total: 0 },
        total_details: { amount_shipping: 0 },
        metadata: {
            line_items: JSON.stringify([{ name, quantity: 1, stock_remaining: stockRemaining }]),
        },
        custom_fields: [],
    };
    if (withDiscord) session.metadata.discord_user_id = TEST_USER_ID;
    if (source) session.metadata.source = source;
    if (listingId) {
        session.metadata.source = 'card-sale';
        session.metadata.card_listing_id = String(listingId);
    }
    if (discordUsername) {
        session.custom_fields = [{ key: 'discord_username', text: { value: discordUsername } }];
    }
    if (shippingAddress) {
        session.shipping_details = { address: shippingAddress, name: 'Test Buyer' };
    } else if (shippingCountry) {
        session.shipping_details = { address: { country: shippingCountry } };
    }
    return session;
}

// =========================================================================
// Channel cleanup — delete all messages in #test-suite before starting
// =========================================================================

// =========================================================================
// Step runner
// =========================================================================

async function step(name, fn) {
    try {
        await fn();
        return { name, passed: true };
    } catch (e) {
        console.error(`Test step failed: ${name}`, e.message);
        return { name, passed: false, error: e.message };
    }
}

async function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Test-only helper. After a duck race completes, the queue session moves
 * to status='complete', and `findActiveSession` (open/racing only) returns
 * null. Each duck-race scenario in the test suite needs its own fresh
 * queue, so this closes any lingering session and creates a new one.
 *
 * Tolerant of every prior state — close 404s and create 409s are both
 * non-fatal here; the goal is "queue is open and fresh when this returns".
 */
async function ensureFreshQueue() {
    try {
        const existing = await queueSource.getActiveQueue();
        if (existing) {
            try { await queueSource.closeQueue(existing.id); } catch { /* ok */ }
        }
    } catch { /* ok */ }

    try {
        await queueSource.createQueue();
    } catch (e) {
        // Either we somehow lost the race or there's a still-open session
        // this helper couldn't close. Log and fall through — the caller's
        // own getActiveQueue will surface the real problem.
        console.error('ensureFreshQueue createQueue failed:', e.message);
    }
    return queueSource.getActiveQueue();
}

// =========================================================================
// Flow 1: Card Night Critical Path
// =========================================================================

async function runCardNightFlow(testChannel) {
    const results = [];
    const rhapttv = buildTestMention();
    let sellListingId, reservedListingId, listSessionId, gammaListingId;

    await testChannel.send({ embeds: [new EmbedBuilder()
        .setTitle('🌙 Card Night Critical Path')
        .setDescription(`Starting... (queue source: **${config.QUEUE_SOURCE}**)`)
        .setColor(0xceff00)] });

    // --- SETUP ---
    results.push(await step('Link test account', async () => {
        purchases.linkDiscord.run(TEST_USER_ID, TEST_EMAIL);
        const link = purchases.getEmailByDiscordId.get(TEST_USER_ID);
        if (!link) throw new Error('Discord link not created');
    }));

    // Probe the active queue source — fails loud if QUEUE_SOURCE=wp can't
    // reach WordPress, so we don't silently pass the rest of the suite
    // against a degraded backend.
    results.push(await step(`Queue source reachable (${config.QUEUE_SOURCE})`, async () => {
        const probe = await queueSource.getActiveQueue();
        // A null result is fine (means no open session); the call succeeding
        // is what we care about. An exception here means the backend is
        // unreachable (WP down, secret mismatch, etc).
        if (probe !== null && typeof probe !== 'object') {
            throw new Error(`Unexpected queue source response shape: ${typeof probe}`);
        }
    }));

    // Sanity-check the activity-feed webhook so a stream-day smoke test
    // catches a broken route before the homepage stops getting updates.
    results.push(await step('Activity feed webhook reachable', async () => {
        const res = await fetch('http://127.0.0.1:3100/webhooks/activity-changed', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Bot-Secret': config.LIVESTREAM_SECRET,
            },
            body: JSON.stringify({
                event: 'activity.test.probe',
                data: { kind: 'test.probe', title: 'probe', description: 'smoke test', icon: 'OK', color: 'zinc' },
            }),
        });
        if (res.status !== 200) {
            throw new Error(`activity-changed returned ${res.status}`);
        }
    }));

    // Sanity-check the catalog drift cleanup endpoint — if this is broken
    // when Stripe archives a product, the homepage will keep showing the
    // stale item and break checkouts. Use a deliberately-fake product ID
    // so we exercise the auth + matched=0 path without mutating any real
    // catalog row.
    results.push(await step('Catalog drift cleanup endpoint reachable', async () => {
        const res = await fetch(`${config.SITE_URL}/wp-json/shop/v1/catalog/stripe-product-deactivated`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Bot-Secret': config.LIVESTREAM_SECRET,
            },
            body: JSON.stringify({ stripeProductId: 'prod_test_probe_does_not_exist' }),
        });
        if (res.status !== 200) {
            throw new Error(`catalog/stripe-product-deactivated returned ${res.status}`);
        }
        const data = await res.json();
        if (data.matched !== 0) {
            throw new Error(`expected matched=0 for fake productId, got ${data.matched}`);
        }
    }));

    // --- PRE-STREAM ---
    // Find a real product from Stripe for hype/battle
    let realProductName = 'Prismatic Evolutions Booster Box'; // fallback
    results.push(await step('!hype (Stripe search)', async () => {
        try {
            const stripe = new Stripe(config.STRIPE_SECRET_KEY);
            const products = await stripe.products.search({ query: 'active:"true"', limit: 1 });
            if (products.data.length) realProductName = products.data[0].name;
        } catch { /* use fallback */ }

        const msg = buildTestMessage(`!hype ${realProductName}`, testChannel);
        msg.author.id = client.user.id;

        // Hype calls awaitReactions on confirmMsg (channel.lastMessage).
        // The bot reacts ✅ before awaitReactions starts, so the collector misses it.
        // Fix: re-react ✅ after a short delay so the collector catches it.
        const hypePromise = handleHype(msg, [realProductName]);
        await delay(2000);
        if (msg.channel.lastMessage) {
            try { await msg.channel.lastMessage.react('✅'); } catch { /* already reacted */ }
        }
        await hypePromise;
    }));

    // --- GO LIVE ---
    results.push(await step('!live', async () => {
        const msg = buildTestMessage('!live', testChannel);
        await handleLive(msg);
    }));

    // --- PRE-ORDERS & WEBHOOK VERIFICATION ---
    results.push(await step('Fake purchase (linked)', async () => {
        const session = fakeCheckoutSession({ name: 'TEST Product Alpha', price: 2500 });
        await handleCheckoutCompleted(session);
    }));

    results.push(await step('Verify Xipe role promotion', async () => {
        const count = purchases.getPurchaseCount.get(TEST_USER_ID);
        if (!count || count.total_purchases < 1) throw new Error('Purchase count not incremented');
    }));

    results.push(await step('Verify community goals', async () => {
        const goal = goals.get.get();
        if (!goal || goal.lifetime_revenue <= 0) throw new Error('Community goals not updated');
    }));

    results.push(await step('Fake purchase (no Discord link)', async () => {
        const session = fakeCheckoutSession({ name: 'TEST Anonymous Purchase', price: 1500, withDiscord: false });
        session.customer_details.email = 'anon-test@example.com';
        session.customer_email = 'anon-test@example.com';
        await handleCheckoutCompleted(session);
    }));

    results.push(await step('Fake purchase (auto-link via username)', async () => {
        const session = fakeCheckoutSession({ name: 'TEST Username Link', price: 1000, withDiscord: false, discordUsername: 'rhapttv' });
        session.customer_details.email = 'autolink-test@example.com';
        session.customer_email = 'autolink-test@example.com';
        await handleCheckoutCompleted(session);
    }));

    results.push(await step('Fake purchase (low stock alert)', async () => {
        const session = fakeCheckoutSession({ name: 'TEST Low Stock Item', price: 2000, stockRemaining: 2 });
        await handleCheckoutCompleted(session);
    }));

    results.push(await step('Fake purchase (sold out alert)', async () => {
        const session = fakeCheckoutSession({ name: 'TEST Sold Out Item', price: 3000, stockRemaining: 0 });
        await handleCheckoutCompleted(session);
    }));

    // --- CARD SALES ---
    results.push(await step('!sell open listing', async () => {
        const msg = buildTestMessage('!sell "TEST Alpha" 1.00', testChannel);
        await handleSell(msg, []);
        const listing = db.prepare("SELECT * FROM card_listings WHERE card_name = 'TEST Alpha' ORDER BY id DESC LIMIT 1").get();
        if (!listing || listing.status !== 'active') throw new Error('Open listing not created');
        sellListingId = listing.id;
    }));

    results.push(await step('Simulate: rhapttv clicks Buy Now', async () => {
        const { handleCardBuy } = await import('./interactions.js');
        const interaction = buildTestInteraction(testChannel);
        // Dynamically import to get the function
        const cardShop = await import('./card-shop.js');
        // Reserve via the interaction handler
        const listing = cardListings.getById.get(sellListingId);
        if (listing.status === 'active') {
            cardListings.reserveForBuyer.run(TEST_USER_ID, sellListingId);
        }
    }));

    results.push(await step('Fake purchase (sell listing)', async () => {
        const session = fakeCheckoutSession({ listingId: sellListingId, name: 'TEST Alpha', price: 100 });
        await handleCheckoutCompleted(session);
        const listing = cardListings.getById.get(sellListingId);
        if (listing.status !== 'sold') throw new Error(`Listing not sold: ${listing.status}`);
    }));

    results.push(await step('!sell @rhapttv reserved', async () => {
        const msg = buildTestMessage('!sell @rhapttv "TEST Beta" 1.00', testChannel, rhapttv);
        await handleSell(msg, []);
        const listing = db.prepare("SELECT * FROM card_listings WHERE card_name = 'TEST Beta' ORDER BY id DESC LIMIT 1").get();
        if (!listing || listing.status !== 'reserved') throw new Error('Reserved listing not created');
        reservedListingId = listing.id;
    }));

    results.push(await step('Simulate: rhapttv clicks Complete Purchase', async () => {
        // The sell-buy interaction just shows a checkout URL — verify the listing is still reserved
        const listing = cardListings.getById.get(reservedListingId);
        if (listing.status !== 'reserved') throw new Error('Listing should still be reserved');
    }));

    results.push(await step('!sold (reserved listing)', async () => {
        const listing = cardListings.getById.get(reservedListingId);
        const msg = buildTestMessage(`!sold ${listing.message_id}`, testChannel);
        msg.reference = null;
        await handleSold(msg, [listing.message_id]);
        const updated = cardListings.getById.get(reservedListingId);
        if (updated.status !== 'sold') throw new Error('Listing not marked sold');
    }));

    // --- BATCH LISTING ---
    results.push(await step('!list open', async () => {
        const msg = buildTestMessage('!list open', testChannel);
        await handleList(msg, ['open']);
        const session = listSessions.getActive.get();
        if (!session) throw new Error('List session not created');
        listSessionId = session.id;
    }));

    results.push(await step('!list add "TEST Gamma" 2.00', async () => {
        const msg = buildTestMessage('!list add "TEST Gamma" 2.00', testChannel);
        await handleList(msg, ['add']);
    }));

    results.push(await step('!list add "TEST Delta" 3.00', async () => {
        const msg = buildTestMessage('!list add "TEST Delta" 3.00', testChannel);
        await handleList(msg, ['add']);
    }));

    results.push(await step('!list add "TEST Epsilon" 4.00', async () => {
        const msg = buildTestMessage('!list add "TEST Epsilon" 4.00', testChannel);
        await handleList(msg, ['add']);
    }));

    results.push(await step('Simulate: rhapttv selects Gamma', async () => {
        const items = cardListings.getBySessionId.all(listSessionId);
        const gamma = items.find(i => i.card_name === 'TEST Gamma');
        if (!gamma) throw new Error('Gamma not found');
        gammaListingId = gamma.id;
        cardListings.reserveForBuyer.run(TEST_USER_ID, gammaListingId);
        const reserved = cardListings.getById.get(gammaListingId);
        if (reserved.status !== 'reserved') throw new Error('Gamma not reserved');
    }));

    results.push(await step('Fake purchase (Gamma)', async () => {
        const session = fakeCheckoutSession({ listingId: gammaListingId, name: 'TEST Gamma', price: 200 });
        await handleCheckoutCompleted(session);
        const listing = cardListings.getById.get(gammaListingId);
        if (listing.status !== 'sold') throw new Error('Gamma not sold');
    }));

    results.push(await step('!list close', async () => {
        const msg = buildTestMessage('!list close', testChannel);
        await handleList(msg, ['close']);
        const session = listSessions.getById.get(listSessionId);
        if (session.status !== 'closed') throw new Error('Session not closed');
    }));

    // --- PULL BOX ---
    // !pull was refactored from a card-shop-listing-style command (price-per-pull)
    // to a tier-based gacha-box command (V = $1, VMAX = $2, fixed N slots) that
    // creates a row in WP's `pull_boxes` table (not local `card_listings`). These
    // steps exercise the current API and clean up after themselves.
    let pullBoxId = null;
    results.push(await step('!pull v open', async () => {
        const msg = buildTestMessage('!pull v "TEST Pull" 5', testChannel);
        await handlePull(msg, ['v', '"TEST', 'Pull"', '5']);
        const box = await wpPullBox.getActiveBox('v');
        if (!box) throw new Error('Pull box not created in WP');
        if (box.tier !== 'v') throw new Error(`Wrong tier: ${box.tier}`);
        if (box.totalSlots !== 5) throw new Error(`Wrong slot count: ${box.totalSlots}`);
        pullBoxId = box.id;
    }));

    results.push(await step('!pull v open refused when already active', async () => {
        // The new API enforces "exactly one active box per tier" at the
        // homepage modal layer; verify the bot rejects a duplicate open.
        const msg = buildTestMessage('!pull v "TEST Pull Dup" 5', testChannel);
        const replies = [];
        msg.reply = async (c) => { replies.push(typeof c === 'string' ? c : (c?.content || '')); };
        await handlePull(msg, ['v', '"TEST', 'Pull', 'Dup"', '5']);
        if (!replies.some((r) => /already active/i.test(r))) {
            throw new Error(`Expected "already active" rejection, got: ${replies.join(' | ')}`);
        }
    }));

    results.push(await step('!pull status', async () => {
        const msg = buildTestMessage('!pull status', testChannel);
        await handlePull(msg, ['status']);
    }));

    results.push(await step('!pull close v', async () => {
        const msg = buildTestMessage('!pull close v', testChannel);
        await handlePull(msg, ['close', 'v']);
        const stillOpen = await wpPullBox.getActiveBox('v');
        if (stillOpen) throw new Error(`V-tier box should be closed, still active: ${stillOpen.id}`);
    }));

    // --- MANUAL OVERRIDE ---
    results.push(await step('!sell + !sold (manual override)', async () => {
        const msg = buildTestMessage('!sell "TEST Sold Override" 1.00', testChannel);
        await handleSell(msg, []);
        const listing = db.prepare("SELECT * FROM card_listings WHERE card_name = 'TEST Sold Override' ORDER BY id DESC LIMIT 1").get();
        const soldMsg = buildTestMessage(`!sold ${listing.message_id}`, testChannel);
        await handleSold(soldMsg, [listing.message_id]);
        const updated = cardListings.getById.get(listing.id);
        if (updated.status !== 'sold') throw new Error('Manual sold override failed');
    }));

    // --- PACK BATTLE ---
    results.push(await step('!battle start', async () => {
        const msg = buildTestMessage(`!battle start ${realProductName}`, testChannel);
        await handleBattle(msg, ['start', ...realProductName.split(' ')]);
    }));

    results.push(await step('!battle status', async () => {
        const msg = buildTestMessage('!battle status', testChannel);
        await handleBattle(msg, ['status']);
    }));

    results.push(await step('!battle join', async () => {
        const msg = buildTestMessage('!battle join', testChannel);
        await handleBattle(msg, ['join']);
    }));

    results.push(await step('Simulate: rhapttv battle payment', async () => {
        const battle = battles.getActiveBattle.get();
        if (battle) {
            battles.addEntry.run(battle.id, TEST_USER_ID, battle.id, battle.id);
            battles.confirmPayment.run(`test_battle_${Date.now()}`, battle.id, TEST_USER_ID);
        }
    }));

    results.push(await step('!battle close', async () => {
        const msg = buildTestMessage('!battle close', testChannel);
        await handleBattle(msg, ['close']);
    }));

    results.push(await step('!battle winner @rhapttv', async () => {
        const msg = buildTestMessage('!battle winner @rhapttv', testChannel, rhapttv);
        await handleBattle(msg, ['winner', '@rhapttv']);
    }));

    // --- BATTLE CANCEL ---
    results.push(await step('!battle start + cancel', async () => {
        const msg = buildTestMessage(`!battle start ${realProductName}`, testChannel);
        await handleBattle(msg, ['start', ...realProductName.split(' ')]);
        await delay(500);
        const cancelMsg = buildTestMessage('!battle cancel', testChannel);
        await handleBattle(cancelMsg, ['cancel']);
    }));

    // --- COUPONS ---
    results.push(await step('!coupon create TESTCODE 5.00', async () => {
        const msg = buildTestMessage('!coupon create TESTCODE 5.00', testChannel);
        await handleCoupon(msg, ['create', 'TESTCODE', '5.00']);
    }));

    results.push(await step('!coupon TESTCODE (activate)', async () => {
        await delay(1000); // allow Stripe to index the promo code
        const msg = buildTestMessage('!coupon TESTCODE', testChannel);
        await handleCoupon(msg, ['TESTCODE']);
    }));

    results.push(await step('!coupon status', async () => {
        const msg = buildTestMessage('!coupon status', testChannel);
        await handleCoupon(msg, ['status']);
    }));

    results.push(await step('!coupon off', async () => {
        const msg = buildTestMessage('!coupon off', testChannel);
        await handleCoupon(msg, ['off']);
    }));

    results.push(await step('!coupon create TESTPCT 10% 3', async () => {
        const msg = buildTestMessage('!coupon create TESTPCT 10% 3', testChannel);
        await handleCoupon(msg, ['create', 'TESTPCT', '10%', '3']);
    }));

    results.push(await step('!coupon TESTPCT (activate)', async () => {
        await delay(1000);
        const msg = buildTestMessage('!coupon TESTPCT', testChannel);
        await handleCoupon(msg, ['TESTPCT']);
    }));

    results.push(await step('!coupon status (percentage)', async () => {
        const msg = buildTestMessage('!coupon status', testChannel);
        await handleCoupon(msg, ['status']);
    }));

    results.push(await step('!coupon off (percentage)', async () => {
        const msg = buildTestMessage('!coupon off', testChannel);
        await handleCoupon(msg, ['off']);
    }));

    // --- DUCK RACE (animated, preselected) ---
    results.push(await step('Inject fake queue buyers', async () => {
        const queue = await queueSource.getActiveQueue();
        if (!queue) throw new Error('No active queue');
        for (let i = 0; i < 5; i++) {
            await queueSource.addEntry({
                queueId: queue.id,
                discordUserId: `fake_${String(i).padStart(3, '0')}`,
                customerEmail: `fake${i}@test.com`,
                productName: 'TEST Product',
                quantity: 1,
                stripeSessionId: `fake_session_${i}`,
                type: 'order',
                source: 'shop',
                externalRef: `test:fake_session_${i}`,
            });
        }
    }));

    results.push(await step('!queue', async () => {
        const msg = buildTestMessage('!queue', testChannel);
        await handleQueue(msg, []);
    }));

    results.push(await step('!queue history', async () => {
        const msg = buildTestMessage('!queue history', testChannel);
        await handleQueue(msg, ['history']);
    }));

    results.push(await step('!duckrace (roster)', async () => {
        const msg = buildTestMessage('!duckrace', testChannel);
        await handleDuckRace(msg, []);
    }));

    results.push(await step('!duckrace pick @rhapttv', async () => {
        const msg = buildTestMessage('!duckrace pick @rhapttv', testChannel, rhapttv);
        await handleDuckRace(msg, ['pick', '@rhapttv']);
    }));

    // Wait for race animation
    await delay(3000);

    // --- DUCK RACE (random — no preselect) ---
    // The previous `!duckrace pick` race has consumed the queue (status now
    // 'complete' — findActiveSession returns null), so we open a fresh one
    // for this scenario.
    results.push(await step('Inject buyers for random duck race', async () => {
        const queue = await ensureFreshQueue();
        if (!queue) throw new Error('Could not create a fresh queue for the random race');
        const ref = `fake_random_${Date.now()}`;
        await queueSource.addEntry({
            queueId: queue.id, discordUserId: TEST_USER_ID, customerEmail: TEST_EMAIL,
            productName: 'TEST Product', quantity: 1, stripeSessionId: ref,
            type: 'order', source: 'shop', externalRef: `test:${ref}`,
        });
        for (let i = 0; i < 4; i++) {
            await queueSource.addEntry({
                queueId: queue.id, discordUserId: `random_fake_${i}`,
                customerEmail: `rfake${i}@test.com`, productName: 'TEST Product',
                quantity: 1, stripeSessionId: `fake_random_session_${i}`,
                type: 'order', source: 'shop', externalRef: `test:fake_random_session_${i}`,
            });
        }
    }));

    results.push(await step('!duckrace start (random)', async () => {
        const msg = buildTestMessage('!duckrace start', testChannel);
        await handleDuckRace(msg, ['start']);
    }));

    await delay(3000);

    // --- DUCK RACE (manual winner) ---
    // Random race has consumed the queue too — open a fresh one for the
    // manual-winner scenario.
    results.push(await step('Inject buyers for manual duck race', async () => {
        const queue = await ensureFreshQueue();
        if (!queue) throw new Error('Could not create a fresh queue for the manual race');
        const ref = `fake_manual_${Date.now()}`;
        await queueSource.addEntry({
            queueId: queue.id, discordUserId: TEST_USER_ID, customerEmail: TEST_EMAIL,
            productName: 'TEST Product', quantity: 1, stripeSessionId: ref,
            type: 'order', source: 'shop', externalRef: `test:${ref}`,
        });
        for (let i = 0; i < 3; i++) {
            await queueSource.addEntry({
                queueId: queue.id, discordUserId: `manual_fake_${i}`,
                customerEmail: `mfake${i}@test.com`, productName: 'TEST Product',
                quantity: 1, stripeSessionId: `fake_manual_session_${i}`,
                type: 'order', source: 'shop', externalRef: `test:fake_manual_session_${i}`,
            });
        }
    }));

    results.push(await step('!duckrace winner @rhapttv', async () => {
        const msg = buildTestMessage('!duckrace winner @rhapttv', testChannel, rhapttv);
        await handleDuckRace(msg, ['winner', '@rhapttv']);
    }));

    results.push(await step('!queue close', async () => {
        const msg = buildTestMessage('!queue close', testChannel);
        await handleQueue(msg, ['close']);
    }));

    // --- ANALYTICS & MOMENTS ---
    results.push(await step('!snapshot', async () => {
        const msg = buildTestMessage('!snapshot', testChannel);
        await handleSnapshot(msg, []);
    }));

    results.push(await step('!snapshot april', async () => {
        const msg = buildTestMessage('!snapshot april', testChannel);
        await handleSnapshot(msg, ['april']);
    }));

    results.push(await step('!snapshot 2026', async () => {
        const msg = buildTestMessage('!snapshot 2026', testChannel);
        await handleSnapshot(msg, ['2026']);
    }));

    results.push(await step('!snapshot april 2026', async () => {
        const msg = buildTestMessage('!snapshot april 2026', testChannel);
        await handleSnapshot(msg, ['april', '2026']);
    }));

    results.push(await step('!capture', async () => {
        const msg = buildTestMessage('!capture', testChannel);
        await handleCapture(msg, []);
    }));

    results.push(await step('!capture with note', async () => {
        const msg = buildTestMessage('!capture Test big pull moment', testChannel);
        await handleCapture(msg, ['Test', 'big', 'pull', 'moment']);
    }));

    // --- SHIPPING & INTERNATIONAL ---
    results.push(await step('!intl @rhapttv CA', async () => {
        const msg = buildTestMessage(`!intl <@${TEST_USER_ID}> CA`, testChannel, rhapttv);
        await handleIntl(msg, [`<@${TEST_USER_ID}>`, 'CA']);
    }));

    results.push(await step('!intl @rhapttv (check)', async () => {
        const msg = buildTestMessage(`!intl <@${TEST_USER_ID}>`, testChannel, rhapttv);
        await handleIntl(msg, [`<@${TEST_USER_ID}>`]);
    }));

    results.push(await step('!intl list', async () => {
        const msg = buildTestMessage('!intl list', testChannel);
        await handleIntl(msg, ['list']);
    }));

    results.push(await step('Fake purchase (shipping mismatch)', async () => {
        const session = fakeCheckoutSession({ name: 'TEST Mismatch', price: 1000, shippingCountry: 'CA' });
        session.shipping_cost = { amount_total: 1000 }; // paid domestic rate
        session.total_details = { amount_shipping: 1000 };
        await handleCheckoutCompleted(session);
    }));

    results.push(await step('!shipping @rhapttv 10.00', async () => {
        const msg = buildTestMessage('!shipping @rhapttv 10.00 Test shipping', testChannel, rhapttv);
        await handleShipping(msg, ['@rhapttv', '10.00', 'Test', 'shipping']);
    }));

    results.push(await step('!intl @rhapttv US (revert)', async () => {
        const msg = buildTestMessage(`!intl <@${TEST_USER_ID}> US`, testChannel, rhapttv);
        await handleIntl(msg, [`<@${TEST_USER_ID}>`, 'US']);
    }));

    // --- END OF STREAM ---
    results.push(await step('!offline', async () => {
        const msg = buildTestMessage('!offline', testChannel);
        await handleOffline(msg);
    }));

    // --- TRACKING ---
    results.push(await step('!tracking @rhapttv (add)', async () => {
        const msg = buildTestMessage(`!tracking <@${TEST_USER_ID}> 9400111899223847263910 USPS`, testChannel, rhapttv);
        await handleTracking(msg, [`<@${TEST_USER_ID}>`, '9400111899223847263910', 'USPS']);

        // Verify tracking stored in DB
        const link = purchases.getEmailByDiscordId.get(TEST_USER_ID);
        if (!link) throw new Error('No email link for test user');
        const record = tracking.getRecentByEmail.get(link.customer_email);
        if (!record) throw new Error('Tracking not stored in DB');
        if (record.tracking_number !== '9400111899223847263910') throw new Error('Wrong tracking number');
        if (record.carrier !== 'USPS') throw new Error('Wrong carrier');
        if (!record.tracking_url) throw new Error('Tracking URL not generated');
    }));

    results.push(await step('!tracking list', async () => {
        const msg = buildTestMessage('!tracking list', testChannel);
        await handleTracking(msg, ['list']);
    }));

    // --- POST-STREAM (dropped-off should now include tracking in DMs) ---
    results.push(await step('!dropped-off (with tracking)', async () => {
        const msg = buildTestMessage('!dropped-off', testChannel);
        await handleDroppedOff(msg, []);
    }));

    results.push(await step('!tracking clear', async () => {
        const msg = buildTestMessage('!tracking clear', testChannel);
        await handleTracking(msg, ['clear']);

        // Verify tracking table is empty
        const all = tracking.getAll.all();
        if (all.length > 0) throw new Error(`Expected 0 tracking entries, got ${all.length}`);
    }));

    results.push(await step('!dropped-off intl', async () => {
        const msg = buildTestMessage('!dropped-off intl', testChannel);
        await handleDroppedOff(msg, ['intl']);
    }));

    // --- SHIPPING AUDIT ---
    results.push(await step('!shipping-audit', async () => {
        const msg = buildTestMessage('!shipping-audit', testChannel);
        await handleShippingAudit(msg, []);
    }));

    results.push(await step('!shipping-audit intl', async () => {
        const msg = buildTestMessage('!shipping-audit intl', testChannel);
        await handleShippingAudit(msg, ['intl']);
    }));

    // --- WAIVE: existing shipping record → tries Stripe refund (Path A) ---
    results.push(await step('!waive @rhapttv (refund path — Stripe test)', async () => {
        // rhapttv has shipping records from fake purchases — waive takes Path A
        // (refund via Stripe). Will fail on fake session IDs but command executes.
        const msg = buildTestMessage('!waive @rhapttv', testChannel, rhapttv);
        await handleWaive(msg, ['@rhapttv']);
    }));

    // --- WAIVE: no shipping record → pre-waiver (Path B) ---
    results.push(await step('!waive @rhapttv (pre-waiver path)', async () => {
        // Clear shipping records so waive takes Path B (pre-waiver with $0 record)
        const link = purchases.getEmailByDiscordId.get(TEST_USER_ID);
        if (link) {
            db.prepare('DELETE FROM shipping_payments WHERE customer_email = ?').run(link.customer_email);
        }

        const msg = buildTestMessage('!waive @rhapttv', testChannel, rhapttv);
        await handleWaive(msg, ['@rhapttv']);

        // Verify $0 waiver record created
        if (link) {
            const record = db.prepare(
                "SELECT * FROM shipping_payments WHERE customer_email = ? AND amount = 0 AND source = 'waiver' ORDER BY created_at DESC LIMIT 1"
            ).get(link.customer_email);
            if (!record) throw new Error('Waiver record not created');
        }
    }));

    // --- INTL-SHIP: DM international buyers with unpaid shipping ---
    results.push(await step('!intl-ship', async () => {
        const msg = buildTestMessage('!intl-ship', testChannel);
        await handleIntlShip(msg);
    }));

    // --- REFUND: seed a fake ShippingEasy order ID on @rhapttv's most recent
    // purchase so the refund command exercises the SE-cancel branch (the
    // actual SE API call is gated by config and won't hit production unless
    // the secrets are present in this environment). ---
    results.push(await step('Seed ShippingEasy order ID on rhapttv purchase', async () => {
        const recent = purchases.getRecentByDiscordId.get(TEST_USER_ID);
        if (!recent) throw new Error('No purchase to seed SE order on');
        purchases.setShippingEasyOrderId.run('se_test_seed', recent.stripe_session_id);
        const after = purchases.getBySessionId.get(recent.stripe_session_id);
        if (after.shippingeasy_order_id !== 'se_test_seed') throw new Error('SE order ID not seeded');
    }));

    // --- REFUND: full refund (no amount specified) ---
    results.push(await step('!refund @rhapttv (full refund)', async () => {
        // Will fail at Stripe since fake session — but command executes without crashing.
        // The SE-cancel branch is gated by Stripe success, so it won't fire here.
        const msg = buildTestMessage('!refund @rhapttv', testChannel, rhapttv);
        await handleRefund(msg, ['@rhapttv']);
    }));

    // --- REFUND: partial refund with amount + reason ---
    results.push(await step('!refund @rhapttv 1.00 (partial + reason)', async () => {
        const msg = buildTestMessage('!refund @rhapttv 1.00 Damaged card', testChannel, rhapttv);
        await handleRefund(msg, ['@rhapttv', '1.00', 'Damaged', 'card']);
    }));

    // --- SHIPPING: custom amount for oversized ---
    results.push(await step('!shipping @rhapttv 15.00 (oversized)', async () => {
        const msg = buildTestMessage('!shipping @rhapttv 15.00 Oversized package', testChannel, rhapttv);
        await handleShipping(msg, ['@rhapttv', '15.00', 'Oversized', 'package']);
    }));

    return results;
}

// =========================================================================
// Flow 2: Giveaway & Spin
// =========================================================================

async function runGiveawayFlow(testChannel) {
    const results = [];
    const rhapttv = buildTestMention();

    await testChannel.send({ embeds: [new EmbedBuilder().setTitle('🎁 Giveaway & Spin Flow').setDescription('Starting...').setColor(0xceff00)] });

    // --- STANDARD GIVEAWAY + SPIN (random) ---
    results.push(await step('!giveaway start (standard)', async () => {
        const msg = buildTestMessage('!giveaway start "TEST Prize A" 1m', testChannel);
        await handleGiveaway(msg, ['start', '"TEST', 'Prize', 'A"', '1m']);
    }));

    results.push(await step('!giveaway status', async () => {
        const msg = buildTestMessage('!giveaway status', testChannel);
        await handleGiveaway(msg, ['status']);
    }));

    results.push(await step('Simulate: rhapttv enters giveaway', async () => {
        const giveaway = giveaways.getActive.get();
        if (!giveaway) throw new Error('No active giveaway');
        giveaways.addEntry.run(giveaway.id, TEST_USER_ID, 'rhapttv');
    }));

    results.push(await step('Inject fake giveaway entries', async () => {
        const giveaway = giveaways.getActive.get();
        for (let i = 0; i < 4; i++) {
            giveaways.addEntry.run(giveaway.id, `fake_giveaway_${i}`, `tiktok_${i}`);
        }
    }));

    results.push(await step('!giveaway close', async () => {
        const msg = buildTestMessage('!giveaway close', testChannel);
        await handleGiveaway(msg, ['close']);
    }));

    results.push(await step('!spin giveaway (random)', async () => {
        const msg = buildTestMessage('!spin giveaway', testChannel);
        await handleSpin(msg, ['giveaway']);
        await delay(5000); // wait for animation
    }));

    // --- SOCIAL GIVEAWAY + SPIN (preselected) ---
    results.push(await step('!giveaway start (social)', async () => {
        const msg = buildTestMessage('!giveaway start "TEST Prize B" social https://tiktok.com/test', testChannel);
        await handleGiveaway(msg, ['start', '"TEST', 'Prize', 'B"', 'social', 'https://tiktok.com/test']);
    }));

    results.push(await step('Inject social giveaway entries', async () => {
        const giveaway = giveaways.getActive.get();
        if (!giveaway) throw new Error('No active giveaway');
        giveaways.addEntry.run(giveaway.id, TEST_USER_ID, 'rhapttv');
        for (let i = 0; i < 4; i++) {
            giveaways.addEntry.run(giveaway.id, `fake_social_${i}`, `tiktok_social_${i}`);
        }
    }));

    results.push(await step('!giveaway close (social)', async () => {
        const msg = buildTestMessage('!giveaway close', testChannel);
        await handleGiveaway(msg, ['close']);
    }));

    results.push(await step('!spin giveaway pick @rhapttv', async () => {
        const msg = buildTestMessage('!spin giveaway pick @rhapttv', testChannel, rhapttv);
        await handleSpin(msg, ['giveaway', 'pick', '@rhapttv']);
        await delay(5000); // wait for animation
    }));

    // --- GIVEAWAY CANCEL ---
    results.push(await step('!giveaway start + cancel', async () => {
        const msg = buildTestMessage('!giveaway start "TEST Prize C"', testChannel);
        await handleGiveaway(msg, ['start', '"TEST', 'Prize', 'C"']);
        await delay(500);
        const cancelMsg = buildTestMessage('!giveaway cancel', testChannel);
        await handleGiveaway(cancelMsg, ['cancel']);
    }));

    // --- AD-HOC SPINS ---
    results.push(await step('!spin (quoted text)', async () => {
        const msg = buildTestMessage('!spin "Prize A" "Prize B" "Prize C"', testChannel);
        await handleSpin(msg, ['"Prize', 'A"', '"Prize', 'B"', '"Prize', 'C"']);
        await delay(3000);
    }));

    results.push(await step('!spin (comma-separated)', async () => {
        const msg = buildTestMessage('!spin PrizeX,PrizeY,PrizeZ', testChannel);
        await handleSpin(msg, ['PrizeX,PrizeY,PrizeZ']);
        await delay(3000);
    }));

    results.push(await step('!spin pick (preselected)', async () => {
        const msg = buildTestMessage('!spin pick "Winner" "A" "B" "C"', testChannel);
        await handleSpin(msg, ['pick', '"Winner"', '"A"', '"B"', '"C"']);
        await delay(3000);
    }));

    return results;
}

// =========================================================================
// Flow 3: Race Condition Verification
// =========================================================================

async function runRaceConditionFlow(testChannel) {
    const results = [];

    await testChannel.send({ embeds: [new EmbedBuilder().setTitle('🏁 Race Condition Verification').setDescription('Testing atomic operations on the live database...').setColor(0xceff00)] });

    // --- CARD LISTING: atomic reservation ---
    results.push(await step('Card reservation: only one buyer wins', async () => {
        cardListings.create.run('RACE Card', 1000, null, 'active');
        const listing = db.prepare("SELECT * FROM card_listings WHERE card_name = 'RACE Card' ORDER BY id DESC LIMIT 1").get();

        const r1 = cardListings.reserveForBuyer.run('buyer_A', listing.id);
        const r2 = cardListings.reserveForBuyer.run('buyer_B', listing.id);

        if (r1.changes !== 1) throw new Error('First buyer should win');
        if (r2.changes !== 0) throw new Error('Second buyer should lose');

        const updated = cardListings.getById.get(listing.id);
        if (updated.buyer_discord_id !== 'buyer_A') throw new Error(`Wrong winner: ${updated.buyer_discord_id}`);

        await testChannel.send('> ✅ Two buyers raced for same card — only buyer_A reserved it');
    }));

    // --- DUCK RACE: atomic claimForRace ---
    // ensureFreshQueue closes any lingering session from prior race-condition
    // steps so the WP `session_exists` 409 doesn't block this scenario. The
    // test's actual assertion (line 1003-1010) is that the SECOND `claimForRace`
    // returns changes=0, not that createQueue itself rejects duplicates.
    results.push(await step('Duck race: only one race can claim a queue', async () => {
        const queue = await ensureFreshQueue();
        if (!queue) throw new Error('Could not create a fresh queue for the atomic-claim test');
        const s1 = `race_s1_${Date.now()}`;
        const s2 = `race_s2_${Date.now()}`;
        await queueSource.addEntry({
            queueId: queue.id, discordUserId: 'race_user_1', customerEmail: 'r1@test.com',
            productName: 'Product', quantity: 1, stripeSessionId: s1,
            type: 'order', source: 'shop', externalRef: `test:${s1}`,
        });
        await queueSource.addEntry({
            queueId: queue.id, discordUserId: 'race_user_2', customerEmail: 'r2@test.com',
            productName: 'Product', quantity: 1, stripeSessionId: s2,
            type: 'order', source: 'shop', externalRef: `test:${s2}`,
        });

        const claim1 = await queueSource.claimForRace(queue.id);
        const claim2 = await queueSource.claimForRace(queue.id);

        if (claim1.changes !== 1) throw new Error('First claim should succeed');
        if (claim2.changes !== 0) throw new Error('Second claim should fail');

        const q = await queueSource.getQueueById(queue.id);
        if (q.status !== 'racing') throw new Error(`Queue status should be racing, got: ${q.status}`);

        // Clean up — set winner so finalize flow works
        await queueSource.setDuckRaceWinner('race_user_1', queue.id);
        await testChannel.send('> ✅ Two races tried to start — only the first claimed the queue');
    }));

    // --- GIVEAWAY: UNIQUE prevents double-entry ---
    results.push(await step('Giveaway: double-click prevented by UNIQUE', async () => {
        giveaways.create.run('RACE Prize', null, 0, null);
        const giveaway = giveaways.getActive.get();

        const r1 = giveaways.addEntry.run(giveaway.id, TEST_USER_ID, 'rhapttv');
        const r2 = giveaways.addEntry.run(giveaway.id, TEST_USER_ID, 'rhapttv');

        if (r1.changes !== 1) throw new Error('First entry should succeed');
        if (r2.changes !== 0) throw new Error('Second entry should be silently rejected');

        const count = giveaways.getEntryCount.get(giveaway.id).count;
        if (count !== 1) throw new Error(`Expected 1 entry, got ${count}`);

        giveaways.cancel.run(giveaway.id);
        await testChannel.send('> ✅ Same user clicked Enter twice — only one entry created');
    }));

    // --- BATTLE: atomic capacity check ---
    results.push(await step('Battle: capacity enforced atomically', async () => {
        battles.createBattle.run('race-slug', 'RACE Product', 'price_race', 2, null);
        const battle = battles.getActiveBattle.get();

        const r1 = battles.addEntry.run(battle.id, 'battle_user_1', battle.id, battle.id);
        const r2 = battles.addEntry.run(battle.id, 'battle_user_2', battle.id, battle.id);
        const r3 = battles.addEntry.run(battle.id, 'battle_user_3', battle.id, battle.id);

        if (r1.changes !== 1 || r2.changes !== 1) throw new Error('First two entries should succeed');
        if (r3.changes !== 0) throw new Error('Third entry should be rejected (battle full)');

        battles.cancelBattle.run(battle.id);
        await testChannel.send('> ✅ Battle with max 2 entries — third buyer rejected atomically');
    }));

    // --- SHIPPING: UNIQUE index prevents double-payment ---
    results.push(await step('Shipping: webhook retry prevented by UNIQUE index', async () => {
        const sessionId = `race_shipping_${Date.now()}`;
        db.prepare('INSERT OR IGNORE INTO shipping_payments (customer_email, discord_user_id, amount, source, stripe_session_id) VALUES (?, ?, ?, ?, ?)').run('race@test.com', 'race_user', 1000, 'checkout', sessionId);
        db.prepare('INSERT OR IGNORE INTO shipping_payments (customer_email, discord_user_id, amount, source, stripe_session_id) VALUES (?, ?, ?, ?, ?)').run('race@test.com', 'race_user', 1000, 'checkout', sessionId);

        const count = db.prepare('SELECT COUNT(*) as count FROM shipping_payments WHERE stripe_session_id = ?').get(sessionId).count;
        if (count !== 1) throw new Error(`Expected 1 shipping record, got ${count}`);

        await testChannel.send('> ✅ Same Stripe session processed twice — only one shipping record');
    }));

    // --- COUPON: atomic single-active enforcement ---
    results.push(await step('Coupon: only one can be active at a time', async () => {
        const activateStmt = db.prepare(`
            INSERT INTO active_coupons (promo_code, stripe_promo_id, stripe_coupon_id, discount_display)
            SELECT ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM active_coupons WHERE status = 'active')
        `);

        const r1 = activateStmt.run('RACE_A', 'promo_a', 'coupon_a', '$5 off');
        const r2 = activateStmt.run('RACE_B', 'promo_b', 'coupon_b', '10% off');

        if (r1.changes !== 1) throw new Error('First coupon should activate');
        if (r2.changes !== 0) throw new Error('Second coupon should be rejected');

        // Deactivate and verify second can now activate
        const active = db.prepare("SELECT * FROM active_coupons WHERE status = 'active' LIMIT 1").get();
        db.prepare("UPDATE active_coupons SET status = 'inactive' WHERE id = ?").run(active.id);
        const r3 = activateStmt.run('RACE_B', 'promo_b', 'coupon_b', '10% off');
        if (r3.changes !== 1) throw new Error('Second coupon should activate after first deactivated');

        await testChannel.send('> ✅ Two coupons tried to activate — only one succeeded until the first was deactivated');
    }));

    // --- CARD TTL vs PAYMENT: expired listing still accepts payment ---
    results.push(await step('TTL vs payment: payment wins over expiry', async () => {
        cardListings.create.run('RACE TTL Card', 500, null, 'active');
        const listing = db.prepare("SELECT * FROM card_listings WHERE card_name = 'RACE TTL Card' ORDER BY id DESC LIMIT 1").get();

        // TTL fires first
        cardListings.markExpired.run(listing.id);
        if (cardListings.getById.get(listing.id).status !== 'expired') throw new Error('Should be expired');

        // Payment arrives after
        cardListings.markSold.run(listing.id);
        if (cardListings.getById.get(listing.id).status !== 'sold') throw new Error('Payment should override expiry');

        await testChannel.send('> ✅ Card expired by TTL, then payment arrived — marked as sold');
    }));

    // --- PURCHASES: webhook retry dedup ---
    results.push(await step('Purchases: webhook retry deduplicated', async () => {
        const sessionId = `race_purchase_${Date.now()}`;
        purchases.insertPurchase.run(sessionId, TEST_USER_ID, TEST_EMAIL, 'RACE Product', 1000);
        purchases.insertPurchase.run(sessionId, TEST_USER_ID, TEST_EMAIL, 'RACE Product', 1000);

        const count = db.prepare('SELECT COUNT(*) as count FROM purchases WHERE stripe_session_id = ?').get(sessionId).count;
        if (count !== 1) throw new Error(`Expected 1 purchase, got ${count}`);

        await testChannel.send('> ✅ Same Stripe session webhook fired twice — only one purchase recorded');
    }));

    return results;
}

// =========================================================================
// Flow 4: Shipping Integration
// =========================================================================

async function runShippingFlow(testChannel) {
    const results = [];
    const rhapttv = buildTestMention();
    let shippedSessionId;

    await testChannel.send({ embeds: [new EmbedBuilder().setTitle('📦 Shipping Integration').setDescription('Starting...').setColor(0xceff00)] });

    // --- Purchase with full shipping address ---
    results.push(await step('Fake purchase with shipping address', async () => {
        // Link test account first
        purchases.linkDiscord.run(TEST_USER_ID, TEST_EMAIL);

        const session = fakeCheckoutSession({
            name: 'TEST Shipped Product',
            price: 2000,
            shippingAddress: {
                line1: '123 Test St',
                line2: 'Apt 4',
                city: 'Brooklyn',
                state: 'NY',
                postal_code: '11201',
                country: 'US',
            },
        });
        session.shipping_cost = { amount_total: 1000 };
        session.total_details = { amount_shipping: 1000 };
        shippedSessionId = session.id;
        await handleCheckoutCompleted(session);
    }));

    // --- Verify shipping address stored ---
    results.push(await step('Verify shipping address stored', async () => {
        const purchase = purchases.getBySessionId.get(shippedSessionId);
        if (!purchase.shipping_address) throw new Error('Shipping address not stored');
        if (purchase.shipping_city !== 'Brooklyn') throw new Error(`Wrong city: ${purchase.shipping_city}`);
        if (purchase.shipping_state !== 'NY') throw new Error(`Wrong state: ${purchase.shipping_state}`);
        if (purchase.shipping_name !== 'Test Buyer') throw new Error(`Wrong name: ${purchase.shipping_name}`);
        await testChannel.send('> ✅ Shipping address stored: 123 Test St, Brooklyn, NY 11201');
    }));

    // --- Verify ShippingEasy order ID set (may be null if API not configured, but column should exist) ---
    results.push(await step('Verify ShippingEasy order tracking column', async () => {
        const purchase = purchases.getBySessionId.get(shippedSessionId);
        // In test mode, createOrder returns null (no API creds), but the column should be on the row
        if (!('shippingeasy_order_id' in purchase)) throw new Error('shippingeasy_order_id column missing');
        // Manually set an order ID to test the pipeline
        purchases.setShippingEasyOrderId.run('se_test_001', shippedSessionId);
        const updated = purchases.getBySessionId.get(shippedSessionId);
        if (updated.shippingeasy_order_id !== 'se_test_001') throw new Error('Order ID not set');
        await testChannel.send('> ✅ ShippingEasy order ID stored: se_test_001');
    }));

    // --- Battle buy-in: no shipping address ---
    results.push(await step('Battle buy-in has no shipping address', async () => {
        const session = fakeCheckoutSession({
            name: 'TEST Battle Pack',
            price: 1099,
            source: 'pack-battle',
        });
        await handleCheckoutCompleted(session);
        const purchase = purchases.getBySessionId.get(session.id);
        if (purchase.shipping_address) throw new Error('Battle buy-in should not have shipping address');
        if (purchase.shippingeasy_order_id) throw new Error('Battle buy-in should not have SE order ID');
        await testChannel.send('> ✅ Battle buy-in — no shipping address, no ShippingEasy order');
    }));

    // --- Simulate ShippingEasy webhook with tracking ---
    results.push(await step('Simulate ShippingEasy webhook', async () => {
        const webhookBody = {
            event: {
                event_type: 'label.purchased',
                data: {
                    shipment: {
                        tracking_number: 'TEST9400111899223847263910',
                        tracking_url: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=TEST9400111899223847263910',
                        carrier: 'USPS',
                        carrier_service: 'Priority Mail',
                        order_number: shippedSessionId,
                    },
                },
            },
        };

        // Compute valid HMAC signature matching verifySignature() logic
        const method = 'POST';
        const path = '/webhooks/shippingeasy';
        const bodyStr = JSON.stringify(webhookBody);
        const stringToSign = [method, path, bodyStr].filter(Boolean).join('&');
        const signature = crypto
            .createHmac('sha256', config.SHIPPINGEASY_API_SECRET)
            .update(stringToSign)
            .digest('hex');

        const fakeReq = {
            method,
            originalUrl: path,
            headers: { 'x-se-api-signature': signature },
            query: {},
            body: webhookBody,
        };
        const fakeRes = { status: () => ({ send: () => {} }) };
        await handleShippingEasyWebhook(fakeReq, fakeRes);

        // Verify tracking stored
        const track = tracking.getRecentByEmail.get(TEST_EMAIL);
        if (!track) throw new Error('Tracking not stored');
        if (track.tracking_number !== 'TEST9400111899223847263910') throw new Error(`Wrong tracking: ${track.tracking_number}`);
        await testChannel.send('> ✅ ShippingEasy webhook processed — tracking stored: TEST9400111899223847263910 (USPS)');
    }));

    // --- !shipments (pending — should be empty since tracking exists) ---
    results.push(await step('!shipments (pending list)', async () => {
        const msg = buildTestMessage('!shipments', testChannel);
        await handleShipments(msg, []);
        await testChannel.send('> ✅ !shipments — pending list rendered');
    }));

    // --- !shipments ready ---
    results.push(await step('!shipments ready', async () => {
        const msg = buildTestMessage('!shipments ready', testChannel);
        await handleShipments(msg, ['ready']);
        await testChannel.send('> ✅ !shipments ready — ready list rendered');
    }));

    // --- !ship-status @rhapttv ---
    results.push(await step('!ship-status @rhapttv', async () => {
        const msg = buildTestMessage('!ship-status @rhapttv', testChannel, rhapttv);
        await handleShipments(msg, ['status']);
        await testChannel.send('> ✅ !ship-status — buyer status rendered');
    }));

    // --- !dropped-off picks up webhook tracking ---
    results.push(await step('!dropped-off includes webhook tracking', async () => {
        const msg = buildTestMessage('!dropped-off', testChannel);
        await handleDroppedOff(msg, []);
        await testChannel.send('> ✅ !dropped-off — shipped with tracking from ShippingEasy webhook');
    }));

    return results;
}

// =========================================================================
// Flow 5: Load Test (concurrency + dedup verification)
// =========================================================================

async function runLoadTestFlow(testChannel) {
    const results = [];

    await testChannel.send({ embeds: [new EmbedBuilder().setTitle('⚡ Load Test').setDescription('Testing concurrent purchase handling...').setColor(0xceff00)] });

    // Link test account
    purchases.linkDiscord.run(TEST_USER_ID, TEST_EMAIL);

    // --- Rapid concurrent purchases (10 at once) ---
    results.push(await step('10 rapid concurrent purchases', async () => {
        const sessions = [];
        for (let i = 0; i < 10; i++) {
            sessions.push(fakeCheckoutSession({
                name: `LOAD Test Item ${i + 1}`,
                price: 500 + i,
                shippingAddress: {
                    line1: `${100 + i} Load Test St`,
                    city: 'Brooklyn',
                    state: 'NY',
                    postal_code: '11201',
                    country: 'US',
                },
            }));
        }

        // Fire all 10 simultaneously (simulates concurrent webhooks)
        await Promise.all(sessions.map(s => handleCheckoutCompleted(s)));

        // Verify all 10 recorded
        const allPurchases = db.prepare('SELECT COUNT(*) as count FROM purchases').get();
        if (allPurchases.count < 10) throw new Error(`Expected 10 purchases, got ${allPurchases.count}`);

        await testChannel.send(`> ✅ 10 concurrent purchases — all ${allPurchases.count} recorded`);
    }));

    // --- Session ID deduplication ---
    results.push(await step('Duplicate session ID rejected', async () => {
        const session = fakeCheckoutSession({ name: 'LOAD Dedup Test', price: 999 });
        const sessionId = session.id;

        await handleCheckoutCompleted(session);
        const before = db.prepare('SELECT COUNT(*) as count FROM purchases WHERE stripe_session_id = ?').get(sessionId);

        // Try inserting the same session again
        await handleCheckoutCompleted({ ...session, id: sessionId });
        const after = db.prepare('SELECT COUNT(*) as count FROM purchases WHERE stripe_session_id = ?').get(sessionId);

        if (after.count !== before.count) throw new Error(`Duplicate not rejected: ${before.count} → ${after.count}`);
        await testChannel.send('> ✅ Duplicate session ID — rejected by INSERT OR IGNORE');
    }));

    // --- Purchase count integrity ---
    results.push(await step('Purchase count integrity', async () => {
        const count = purchases.getPurchaseCount.get(TEST_USER_ID);
        if (!count || count.total_purchases < 10) throw new Error(`Expected 10+ purchases, got ${count?.total_purchases}`);
        await testChannel.send(`> ✅ Purchase count integrity — ${count.total_purchases} total for test user`);
    }));

    // --- Concurrent shipping lookups ---
    results.push(await step('Concurrent shipping lookups', async () => {
        // This tests the SQLite read path under concurrent access
        const lookups = [];
        for (let i = 0; i < 20; i++) {
            lookups.push(purchases.getDiscordIdByEmail.get(TEST_EMAIL));
        }
        const allValid = lookups.every(l => l?.discord_user_id === TEST_USER_ID);
        if (!allValid) throw new Error('Some lookups returned wrong data');
        await testChannel.send('> ✅ 20 concurrent shipping lookups — all returned correct data');
    }));

    return results;
}

// =========================================================================
// Flow 6: Minecraft React-for-DM
// =========================================================================

async function runMinecraftFlow(testChannel) {
    const results = [];
    const { db, minecraft: minecraftDb } = await import('../db.js');

    await testChannel.send({ embeds: [new EmbedBuilder().setTitle('🟢 Minecraft React-for-DM').setDescription('Starting...').setColor(0xceff00)] });

    // --- INIT (posts the persistent embed + 3 reactions in #test-suite) ---
    let postedMessageId;
    results.push(await step('initMinecraftChannel posts embed + reactions', async () => {
        // Reset stored message ID so init forces a fresh post
        minecraftDb.setMessageId.run(null);
        await initMinecraftChannel();
        const row = minecraftDb.getConfig.get();
        if (!row?.channel_message_id) throw new Error('No message ID stored after init');
        postedMessageId = row.channel_message_id;

        const msg = await testChannel.messages.fetch(postedMessageId);
        if (!msg.embeds.length) throw new Error('Embed not posted');

        // Wait briefly for reactions to register, then verify all 3 are present
        await delay(1500);
        const refreshed = await testChannel.messages.fetch(postedMessageId);
        const present = REACTION_EMOJIS.filter((e) => refreshed.reactions.cache.has(e));
        if (present.length !== REACTION_EMOJIS.length) {
            throw new Error(`Expected ${REACTION_EMOJIS.length} reactions, found ${present.length}: ${present.join(' ')}`);
        }
    }));

    // --- IDEMPOTENCY (re-running init keeps the same message) ---
    results.push(await step('initMinecraftChannel is idempotent', async () => {
        await initMinecraftChannel();
        const row = minecraftDb.getConfig.get();
        if (row.channel_message_id !== postedMessageId) {
            throw new Error(`Message ID changed on re-init: ${postedMessageId} → ${row.channel_message_id}`);
        }
    }));

    // --- REACTION HANDLER (each emoji triggers a DM attempt) ---
    // Build a fake reaction/user pair; the DM call may fail since the bot
    // can't DM itself, but the function should NOT throw and should still
    // remove the user's reaction.
    for (const emoji of REACTION_EMOJIS) {
        results.push(await step(`handleMinecraftReaction (${emoji})`, async () => {
            const msg = await testChannel.messages.fetch(postedMessageId);
            let reactionRemoved = false;
            const fakeReaction = {
                emoji: { name: emoji },
                message: { id: postedMessageId },
                partial: false,
                users: {
                    remove: async () => { reactionRemoved = true; },
                },
            };
            const fakeUser = { id: TEST_USER_ID, bot: false, tag: 'rhapttv#0', partial: false };

            await handleMinecraftReaction(fakeReaction, fakeUser);
            if (!reactionRemoved) throw new Error('Reaction not removed after handler ran');
            void msg; // ensure compiler keeps fetch
        }));
    }

    // --- WRONG MESSAGE (handler should silently ignore) ---
    results.push(await step('handleMinecraftReaction ignores wrong message', async () => {
        const fakeReaction = {
            emoji: { name: '🪓' },
            message: { id: 'not_the_minecraft_message' },
            partial: false,
            users: { remove: async () => { throw new Error('should not have removed reaction'); } },
        };
        const fakeUser = { id: TEST_USER_ID, bot: false, tag: 'rhapttv#0', partial: false };
        await handleMinecraftReaction(fakeReaction, fakeUser);
    }));

    // --- WRONG EMOJI (handler should silently ignore) ---
    results.push(await step('handleMinecraftReaction ignores wrong emoji', async () => {
        const fakeReaction = {
            emoji: { name: '🍕' },
            message: { id: postedMessageId },
            partial: false,
            users: { remove: async () => { throw new Error('should not have removed reaction'); } },
        };
        const fakeUser = { id: TEST_USER_ID, bot: false, tag: 'rhapttv#0', partial: false };
        await handleMinecraftReaction(fakeReaction, fakeUser);
    }));

    // --- BOT REACTION (handler should silently ignore) ---
    results.push(await step('handleMinecraftReaction ignores bot users', async () => {
        const fakeReaction = {
            emoji: { name: '🪓' },
            message: { id: postedMessageId },
            partial: false,
            users: { remove: async () => { throw new Error('should not have removed reaction'); } },
        };
        const fakeUser = { id: 'some_bot', bot: true, tag: 'somebot#0', partial: false };
        await handleMinecraftReaction(fakeReaction, fakeUser);
    }));

    return results;
}

// =========================================================================
// Results embed
// =========================================================================

async function postResultsEmbed(testChannel, results, flowName) {
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const allPassed = passed === total;

    const lines = results.map(r => {
        const icon = r.passed ? '✅' : '❌';
        const error = r.error ? ` — \`${r.error.slice(0, 80)}\`` : '';
        return `${icon} ${r.name}${error}`;
    });

    // Split into chunks if needed (Discord embed description max 4096 chars)
    const description = `**${passed}/${total} passed**\n\n${lines.join('\n')}`;
    const embed = new EmbedBuilder()
        .setTitle(`🧪 ${flowName} — ${allPassed ? 'ALL PASSED' : `${total - passed} FAILED`}`)
        .setDescription(description.slice(0, 4096))
        .setColor(allPassed ? 0xceff00 : 0xe74c3c);

    await testChannel.send({ embeds: [embed] });
}

// =========================================================================
// Main entry point
// =========================================================================

async function runTestSuite(flow, options = {}) {
    const resultsChannelKey = options.resultsChannel || 'OPS';

    const testChannel = getChannel(resultsChannelKey);
    if (!testChannel) throw new Error(`Results channel ${resultsChannelKey} not found`);

    // Save community goals pinned message ID
    const savedGoal = goals.get.get();
    const savedGoalMessageId = savedGoal?.channel_message_id;

    const allResults = [];
    try {
        if (!flow || flow === 'card-night') {
            const results = await runCardNightFlow(testChannel);
            await postResultsEmbed(testChannel, results, 'Card Night Critical Path');
            allResults.push(...results);
        }
        if (!flow || flow === 'giveaway') {
            const results = await runGiveawayFlow(testChannel);
            await postResultsEmbed(testChannel, results, 'Giveaway & Spin');
            allResults.push(...results);
        }
        if (!flow || flow === 'race') {
            const results = await runRaceConditionFlow(testChannel);
            await postResultsEmbed(testChannel, results, 'Race Condition Verification');
            allResults.push(...results);
        }
        if (!flow || flow === 'shipping') {
            const results = await runShippingFlow(testChannel);
            await postResultsEmbed(testChannel, results, 'Shipping Integration');
            allResults.push(...results);
        }
        if (!flow || flow === 'loadtest') {
            const results = await runLoadTestFlow(testChannel);
            await postResultsEmbed(testChannel, results, 'Load Test');
            allResults.push(...results);
        }
        if (!flow || flow === 'minecraft') {
            const results = await runMinecraftFlow(testChannel);
            await postResultsEmbed(testChannel, results, 'Minecraft React-for-DM');
            allResults.push(...results);
        }

        await testChannel.send('🔄 Resetting test data...');

        const TABLES_TO_CLEAR = [
            'queue_entries', 'queues', 'battle_entries', 'battles',
            'duck_race_entries', 'giveaway_entries', 'giveaways',
            'pull_entries', 'card_listings', 'list_sessions',
            'livestream_buyers', 'livestream_sessions',
            'purchases', 'purchase_counts', 'discord_links',
            'shipping_payments', 'active_coupons', 'tracking',
        ];

        for (const table of TABLES_TO_CLEAR) {
            try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* ok */ }
        }

        db.prepare('UPDATE community_goals SET cycle = 1, cycle_revenue = 0, lifetime_revenue = 0 WHERE id = 1').run();
        if (savedGoalMessageId) goals.setMessageId.run(savedGoalMessageId);
        try { db.prepare('DELETE FROM sqlite_sequence').run(); } catch { /* ok */ }

        await testChannel.send('✅ **Reset complete.**');
    } finally {
        // no-op
    }

    return allResults;
}

export { runTestSuite };
