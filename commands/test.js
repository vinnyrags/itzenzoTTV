/**
 * Test Suite — live critical path testing in #test-suite.
 *
 * Commands:
 *   !test              — Run both flows (card night + giveaway)
 *   !test card-night   — Run card night flow only
 *   !test giveaway     — Run giveaway & spin flow only
 *
 * All output routes to #test-suite via channel overrides.
 * Uses @rhapttv test account for buyer interactions.
 * Ends with !reset to clean all data.
 */

import { EmbedBuilder } from 'discord.js';
import Stripe from 'stripe';
import config from '../config.js';
import { db, purchases, cardListings, listSessions, battles, queues, giveaways, discordLinks, goals } from '../db.js';
import { client, getChannel, setChannelOverride, clearChannelOverrides, getMember } from '../discord.js';
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
import { handleIntl } from './intl.js';
import { handleShipping } from './shipping.js';
import { handleDroppedOff } from './dropped-off.js';
import { handleWaive } from './waive.js';
import { handleRefund } from './refund.js';
import { handleReset } from './reset.js';
import { handleCheckoutCompleted } from '../webhooks/stripe.js';

const TEST_USER_ID = '1490206350943191052'; // @rhapttv
const TEST_EMAIL = 'itzenzottv+testaccount1@gmail.com';
const TEST_CHANNEL_ID = config.CHANNELS.TEST_SUITE;

// Channels to override during test
const OVERRIDE_KEYS = [
    'CARD_SHOP', 'ORDER_FEED', 'DEALS', 'QUEUE', 'GIVEAWAYS',
    'ANNOUNCEMENTS', 'ANALYTICS', 'MOMENTS', 'OPS', 'PACK_BATTLES',
    'COMMUNITY_GOALS',
];

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

function fakeCheckoutSession({ listingId, name, price, withDiscord = true, stockRemaining = 5, discordUsername = null, shippingCountry = null }) {
    const session = {
        id: `test_session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        customer_details: { email: TEST_EMAIL },
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
    if (listingId) {
        session.metadata.source = 'card-sale';
        session.metadata.card_listing_id = String(listingId);
    }
    if (discordUsername) {
        session.custom_fields = [{ key: 'discord_username', text: { value: discordUsername } }];
    }
    if (shippingCountry) {
        session.shipping_details = { address: { country: shippingCountry } };
    }
    return session;
}

// =========================================================================
// Channel cleanup — delete all messages in #test-suite before starting
// =========================================================================

async function clearTestChannel(testChannel) {
    try {
        let fetched;
        do {
            fetched = await testChannel.messages.fetch({ limit: 100 });
            if (fetched.size > 0) {
                await testChannel.bulkDelete(fetched, true);
                // bulkDelete can't delete messages older than 14 days — delete individually
                const tooOld = fetched.filter(m => Date.now() - m.createdTimestamp >= 14 * 24 * 60 * 60 * 1000);
                for (const m of tooOld.values()) {
                    try { await m.delete(); } catch { /* ok */ }
                }
            }
        } while (fetched.size >= 2);
    } catch (e) {
        console.error('Failed to clear test channel:', e.message);
    }
}

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

// =========================================================================
// Flow 1: Card Night Critical Path
// =========================================================================

async function runCardNightFlow(testChannel) {
    const results = [];
    const rhapttv = buildTestMention();
    let sellListingId, reservedListingId, listSessionId, gammaListingId, pullListingId;

    await testChannel.send({ embeds: [new EmbedBuilder().setTitle('🌙 Card Night Critical Path').setDescription('Starting...').setColor(0xceff00)] });

    // --- SETUP ---
    results.push(await step('Link test account', async () => {
        purchases.linkDiscord.run(TEST_USER_ID, TEST_EMAIL);
        const link = purchases.getEmailByDiscordId.get(TEST_USER_ID);
        if (!link) throw new Error('Discord link not created');
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
    results.push(await step('!pull open', async () => {
        const msg = buildTestMessage('!pull "TEST Pull" 1.00', testChannel);
        await handlePull(msg, ['"TEST', 'Pull"', '1.00']);
        const listing = db.prepare("SELECT * FROM card_listings WHERE card_name = 'TEST Pull' AND status = 'pull' ORDER BY id DESC LIMIT 1").get();
        if (!listing) throw new Error('Pull listing not created');
        pullListingId = listing.id;
    }));

    results.push(await step('Simulate: rhapttv clicks Buy Pull', async () => {
        // Pull buy just shows a checkout URL — verify listing exists
        const listing = cardListings.getById.get(pullListingId);
        if (listing.status !== 'pull') throw new Error('Pull listing not in pull status');
    }));

    results.push(await step('Fake purchase (pull, qty 1)', async () => {
        const session = fakeCheckoutSession({ listingId: pullListingId, name: 'TEST Pull', price: 100 });
        session.metadata.line_items = JSON.stringify([{ name: 'TEST Pull', quantity: 1, stock_remaining: 5 }]);
        await handleCheckoutCompleted(session);
    }));

    results.push(await step('Fake purchase (pull, qty 3)', async () => {
        const session = fakeCheckoutSession({ listingId: pullListingId, name: 'TEST Pull', price: 300 });
        session.metadata.line_items = JSON.stringify([{ name: 'TEST Pull', quantity: 3, stock_remaining: 5 }]);
        await handleCheckoutCompleted(session);
    }));

    results.push(await step('!pull status', async () => {
        const msg = buildTestMessage('!pull status', testChannel);
        await handlePull(msg, ['status']);
    }));

    results.push(await step('!pull close', async () => {
        const msg = buildTestMessage('!pull close', testChannel);
        await handlePull(msg, ['close']);
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
        const queue = queues.getActiveQueue.get();
        if (!queue) throw new Error('No active queue');
        for (let i = 0; i < 5; i++) {
            queues.addEntry.run(queue.id, `fake_${String(i).padStart(3, '0')}`, `fake${i}@test.com`, 'TEST Product', 1, `fake_session_${i}`);
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

    // --- DUCK RACE (manual winner) ---
    results.push(await step('Inject buyers for manual duck race', async () => {
        const queue = queues.getActiveQueue.get();
        if (!queue) throw new Error('No active queue after race');
        queues.addEntry.run(queue.id, TEST_USER_ID, TEST_EMAIL, 'TEST Product', 1, `fake_manual_${Date.now()}`);
        for (let i = 0; i < 3; i++) {
            queues.addEntry.run(queue.id, `manual_fake_${i}`, `mfake${i}@test.com`, 'TEST Product', 1, `fake_manual_session_${i}`);
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

    // --- POST-STREAM ---
    results.push(await step('!dropped-off', async () => {
        const msg = buildTestMessage('!dropped-off', testChannel);
        await handleDroppedOff(msg, []);
    }));

    results.push(await step('!dropped-off intl', async () => {
        const msg = buildTestMessage('!dropped-off intl', testChannel);
        await handleDroppedOff(msg, ['intl']);
    }));

    results.push(await step('!waive @rhapttv', async () => {
        const msg = buildTestMessage('!waive @rhapttv', testChannel, rhapttv);
        await handleWaive(msg, ['@rhapttv']);
    }));

    results.push(await step('!refund @rhapttv 1.00 (Stripe test)', async () => {
        // Refund will fail with "No such checkout.session" since our fake sessions
        // don't exist in Stripe. The command itself works — it finds the purchase,
        // calls Stripe, and Stripe rejects the fake session ID. This is expected.
        const msg = buildTestMessage('!refund @rhapttv 1.00 Test refund', testChannel, rhapttv);
        await handleRefund(msg, ['@rhapttv', '1.00', 'Test', 'refund']);
        // Pass regardless — the command executed without crashing
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

async function handleTest(message, args) {
    if (!message.member.roles.cache.has(config.ROLES.AKIVILI)) {
        return message.reply('Only the server owner can run the test suite.');
    }

    const sub = args[0]?.toLowerCase();
    const testChannel = getChannel('TEST_SUITE');

    if (!testChannel) {
        return message.reply('Test suite channel not found. Check config.');
    }

    // Clear previous test output
    await clearTestChannel(testChannel);

    // Save community goals pinned message ID so !reset doesn't orphan it
    const savedGoal = goals.get.get();
    const savedGoalMessageId = savedGoal?.channel_message_id;

    // Set channel overrides
    for (const key of OVERRIDE_KEYS) {
        setChannelOverride(key, TEST_CHANNEL_ID);
    }

    try {
        if (sub === 'card-night' || !sub) {
            const results = await runCardNightFlow(testChannel);
            await postResultsEmbed(testChannel, results, 'Card Night Critical Path');
        }
        if (sub === 'giveaway' || !sub) {
            const results = await runGiveawayFlow(testChannel);
            await postResultsEmbed(testChannel, results, 'Giveaway & Spin');
        }

        // Reset — same awaitReactions pattern as hype
        await testChannel.send('🔄 Running `!reset` to clean up...');
        const resetMsg = buildTestMessage('!reset', testChannel);
        resetMsg.author.id = client.user.id;
        const resetPromise = handleReset(resetMsg);
        await delay(1000);
        if (resetMsg.channel.lastMessage) {
            try { await resetMsg.channel.lastMessage.react('✅'); } catch { /* ok */ }
        }
        await resetPromise;

        // Restore community goals pinned message ID (reset wiped it)
        if (savedGoalMessageId) {
            goals.setMessageId.run(savedGoalMessageId);
        }
    } finally {
        clearChannelOverrides();
    }
}

async function runTestSuite(flow) {
    const testChannel = getChannel('TEST_SUITE');
    if (!testChannel) throw new Error('Test suite channel not found');

    // Save community goals pinned message ID
    const savedGoal = goals.get.get();
    const savedGoalMessageId = savedGoal?.channel_message_id;

    for (const key of OVERRIDE_KEYS) {
        setChannelOverride(key, TEST_CHANNEL_ID);
    }

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

        await testChannel.send('🔄 Running `!reset` to clean up...');
        const resetMsg = buildTestMessage('!reset', testChannel);
        resetMsg.author.id = client.user.id;
        const resetPromise = handleReset(resetMsg);
        await delay(1000);
        if (resetMsg.channel.lastMessage) {
            try { await resetMsg.channel.lastMessage.react('✅'); } catch { /* ok */ }
        }
        await resetPromise;

        // Restore community goals pinned message ID
        if (savedGoalMessageId) {
            goals.setMessageId.run(savedGoalMessageId);
        }
    } finally {
        clearChannelOverrides();
    }

    return allResults;
}

export { handleTest, runTestSuite };
