/**
 * Stripe Webhook Handler
 *
 * Handles:
 * - Order notifications → #order-feed
 * - Low-stock alerts → #deals
 * - Pack battle payment verification
 * - Queue auto-entries (card products → active queue)
 * - Role promotion (Xipe at 1+, Long at 5+)
 */

import { EmbedBuilder } from 'discord.js';
import Stripe from 'stripe';
import config from '../config.js';
import { db, purchases, battles, cardListings, listSessions, discordLinks } from '../db.js';
import { client, sendToChannel, sendEmbed, getMember, getGuild, findMemberByUsername, addRole, hasRole } from '../discord.js';
import { addToQueue } from '../commands/queue.js';
import { updateBattleMessage } from '../commands/battle.js';
import { clearExpiryTimer, clearListingTtl, updateListingEmbed, updateListSessionEmbed } from '../commands/card-shop.js';
import { addRevenue } from '../community-goals.js';
import { recordShipping } from '../shipping.js';
import { recordPullPurchase, recordPullBoxPurchase } from '../commands/pull.js';
import * as queueSource from '../lib/queue-source.js';
import { createOrder } from '../shippingeasy-api.js';
import { broadcastLowStock, broadcastSoldOut } from '../lib/activity-broadcaster.js';
import { normalizeEmail } from '../lib/normalize-email.js';

const stripe = new Stripe(config.STRIPE_SECRET_KEY);

/**
 * Process a completed checkout session.
 */
/**
 * Phase 1: Critical path — must complete before responding to Stripe.
 * Records purchase, links Discord, stores shipping, creates ShippingEasy order.
 * No Discord API calls here — those happen in Phase 2 (notifications).
 *
 * Returns { customerEmail, discordUserId, lineItems } for Phase 2.
 */
async function handleCheckoutCritical(session) {
    // Ad-hoc shipping — record in unified tracker
    if (session.metadata?.source === 'ad-hoc-shipping') {
        const email = normalizeEmail(session.customer_details?.email);
        if (email) {
            recordShipping(email, session.metadata.discord_user_id || null, session.amount_total || 0, 'ad-hoc', session.id);
        }
        return null;
    }

    // Normalize once at the entry point — every downstream linkDiscord,
    // insertPurchase, recordShipping, and queue mirror keys off this value.
    const customerEmail = normalizeEmail(session.customer_details?.email || session.customer_email);
    const totalAmount = session.amount_total;

    // Resolve line items — prefer metadata (bot endpoints), fall back to Stripe API (WordPress/external)
    let lineItems = [];
    if (session.metadata?.line_items) {
        lineItems = JSON.parse(session.metadata.line_items);
    } else {
        try {
            const fetched = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
            lineItems = fetched.data.map((item) => ({
                name: item.description || 'Unknown Product',
                quantity: item.quantity || 1,
            }));
        } catch (e) {
            console.error('Failed to fetch line items from Stripe:', e.message);
        }
    }

    // Try to find linked Discord user
    const link = purchases.getDiscordIdByEmail.get(customerEmail);
    let discordUserId = link?.discord_user_id || null;

    // Auto-link via metadata discord_user_id (from Discord button purchases)
    if (!discordUserId && session.metadata?.discord_user_id) {
        discordUserId = session.metadata.discord_user_id;
        purchases.linkDiscord.run(discordUserId, customerEmail);
        console.log(`Auto-linked via metadata: ${discordUserId} → ${customerEmail}`);
    }

    // Auto-link via Discord username from checkout custom field (shop/non-Discord purchases)
    if (!discordUserId && session.custom_fields?.length) {
        const field = session.custom_fields.find((f) => f.key === 'discord_username');
        const username = field?.text?.value?.trim().replace(/^@/, '');
        if (username) {
            const member = await findMemberByUsername(username);
            if (member) {
                purchases.linkDiscord.run(member.id, customerEmail);
                discordUserId = member.id;
                console.log(`Auto-linked ${username} (${member.id}) → ${customerEmail}`);
            } else {
                console.log(`Discord username "${username}" not found in server — purchase unlinked`);
            }
        }
    }

    // Record each purchase. INSERT OR IGNORE on stripe_session_id makes
    // the inserts idempotent across Stripe webhook retries; we count actual
    // inserts so the role-threshold counter only ticks up when at least
    // one new purchase row landed (otherwise a retry would over-promote
    // the buyer through the Xipe / Long thresholds).
    let actuallyInserted = 0;
    for (const item of lineItems) {
        const result = purchases.insertPurchase.run(
            session.id,
            discordUserId,
            customerEmail,
            item.name || 'Unknown Product',
            totalAmount
        );
        actuallyInserted += result.changes;
    }

    // Increment purchase count for role promotion tracking — only when this
    // webhook delivery actually created new purchase rows.
    if (discordUserId && actuallyInserted > 0) {
        purchases.incrementPurchaseCount.run(discordUserId);
    }

    // Track revenue toward community goals (shipping excluded)
    const productRevenue = session.amount_subtotal || session.amount_total || 0;
    if (productRevenue > 0) {
        await addRevenue(productRevenue);
    }

    // Track shipping paid at checkout
    const shippingAmount = session.shipping_cost?.amount_total
        || session.total_details?.amount_shipping
        || 0;
    if (shippingAmount > 0 && customerEmail) {
        recordShipping(customerEmail, discordUserId, shippingAmount, 'checkout', session.id);
    }

    // Auto-flag international buyers from shipping address
    const shippingCountry = session.shipping_details?.address?.country;
    if (shippingCountry && shippingCountry !== 'US' && discordUserId) {
        discordLinks.setCountry.run(shippingCountry, discordUserId);
        console.log(`Auto-flagged international: ${discordUserId} → ${shippingCountry}`);
    }

    // Store full shipping address and create ShippingEasy order
    const shippingDetails = session.shipping_details;
    if (shippingDetails?.address) {
        const addr = shippingDetails.address;
        const name = session.customer_details?.name || shippingDetails.name || '';
        purchases.updateShippingAddress.run(
            name,
            addr.line1 + (addr.line2 ? `, ${addr.line2}` : ''),
            addr.city || '',
            addr.state || '',
            addr.postal_code || '',
            addr.country || '',
            session.id,
        );

        const source = session.metadata?.source || '';
        if (source !== 'pack-battle' && source !== 'ad-hoc-shipping') {
            const orderId = await createOrder({
                stripeSessionId: session.id,
                customerName: name,
                email: customerEmail,
                address: addr,
                lineItems: lineItems || [],
            });
            if (orderId) {
                purchases.setShippingEasyOrderId.run(orderId, session.id);
            }
        }
    }

    return { customerEmail, discordUserId, lineItems, totalAmount };
}

/**
 * Phase 2: Notifications — Discord DMs, embeds, role promotions, queue entries.
 * Fire-and-forget after Stripe has been responded to. Failures are logged but
 * don't affect the purchase record.
 */
async function handleCheckoutNotifications(session, context) {
    const { customerEmail, discordUserId, lineItems, totalAmount } = context;

    // Low-stock and sold-out alerts
    for (const item of lineItems) {
        const stock = item.stock_remaining;
        const productName = item.name || 'Unknown Product';
        if (stock !== undefined && stock <= config.LOW_STOCK_THRESHOLD && stock > 0) {
            await sendEmbed('DEALS', {
                title: '\u26A0\uFE0F Low Stock Alert',
                description: `**${productName}** \u2014 only **${stock}** left in stock!`,
                color: 0xe74c3c,
            });
            broadcastLowStock(productName, stock);
        }
        if (stock !== undefined && stock === 0) {
            await sendEmbed('DEALS', {
                title: '\uD83D\uDEAB Sold Out',
                description: `**${productName}** is now sold out!`,
                color: 0x95a5a6,
            });
            broadcastSoldOut(productName);
        }
    }

    // Order notification in #order-feed
    if (lineItems.length > 0) {
        const hasIdentity = !!discordUserId;
        const itemList = lineItems.map((item) => {
            const name = item.name || 'Unknown Product';
            const qty = item.quantity || 1;
            return `\u2022 **${name}**${qty > 1 ? ` (\u00D7${qty})` : ''}`;
        }).join('\n');

        const description = hasIdentity
            ? `<@${discordUserId}> just picked up:\n${itemList}`
            : lineItems.length === 1
                ? `**${lineItems[0].name || 'Unknown Product'}**${(lineItems[0].quantity || 1) > 1 ? ` (\u00D7${lineItems[0].quantity})` : ''} was purchased`
                : `New order placed:\n${itemList}`;

        await sendEmbed('ORDER_FEED', {
            title: '\uD83D\uDED2 New Order!',
            description,
            color: 0xceff00,
            footer: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
        });
    }

    // DM the buyer a purchase receipt (skip card sales — they get their own DM)
    if (discordUserId && session.metadata?.source !== 'card-sale') {
        try {
            const member = await getMember(discordUserId);
            if (member) {
                const dm = await member.createDM();
                const itemList = lineItems.map((item) => {
                    const name = item.name || 'Unknown Product';
                    const qty = item.quantity || 1;
                    return `• **${name}**${qty > 1 ? ` ×${qty}` : ''}`;
                }).join('\n');

                const totalDollars = (totalAmount / 100).toFixed(2);
                const embed = new EmbedBuilder()
                    .setTitle('🧾 Purchase Receipt')
                    .setDescription(`${itemList}\n\n**Total:** $${totalDollars}\n\n📅 Orders ship weekly — expect delivery 5-7 business days after shipping`)
                    .setColor(0xceff00)
                    .setFooter({ text: 'Thank you for your purchase!' });

                await dm.send({ embeds: [embed] });
            }
        } catch (e) {
            console.error(`Failed to DM receipt to ${discordUserId}:`, e.message);
        }
    }

    // Add to queue (skip battles and individual card sales). One purchase
    // becomes ONE consolidated queue entry — line items roll up into a
    // single "Nx Item, Mx Item" label so multi-item orders show as a
    // single row everywhere (homepage Live Queue + Discord embed).
    if (session.metadata?.source !== 'pack-battle' && session.metadata?.source !== 'card-sale' && lineItems.length > 0) {
        // Resolve the buyer's Discord handle so the homepage can render
        // "@vinnyrags" instead of falling back to the redacted email when
        // the email→discord_user_id link already exists. (For first-time
        // buyers who entered the username at Stripe checkout, the handle
        // was already known via findMemberByUsername a few lines above.)
        let discordHandle = null;
        if (discordUserId) {
            try {
                const member = await getMember(discordUserId);
                discordHandle = member?.user?.username || member?.user?.tag || null;
            } catch {
                // Member fetch failed — proceed without; WP serializer falls
                // back to redacted email, which is still recognizable to the buyer.
            }
        }

        const items = lineItems.map((item) => ({
            name: item.name || 'Unknown Product',
            quantity: item.quantity || 1,
        }));
        const added = await addToQueue({
            discordUserId,
            discordHandle,
            customerEmail,
            items,
            stripeSessionId: session.id,
        });
        if (added) {
            const summary = items.map((i) => `${i.quantity}x ${i.name}`).join(', ');
            console.log(`Queue entry: ${summary} for ${discordHandle || discordUserId || customerEmail}`);
        }
    }

    // Role promotion
    if (discordUserId) {
        await checkRolePromotion(discordUserId);
    }

    // Check battle payment
    await checkBattlePayment(session, discordUserId);

    // Check card sale payment
    await checkCardSalePayment(session, discordUserId, lineItems);

    // Check pull-box (slot-based) payment
    await checkPullBoxPayment(session, discordUserId, customerEmail, lineItems);

    // Detect shipping mismatch
    await checkShippingMismatch(session, discordUserId, customerEmail);
}

/**
 * Pull-box payments under the new slot-based system. Routes both flows:
 *
 *   Homepage flow: metadata.pull_box_slots is a comma-separated list of
 *   slots that were pre-claimed at session-create time. We just confirm
 *   them.
 *
 *   Discord flow: no slots in metadata. We auto-pick the lowest-numbered
 *   open slots in the active box, claim them atomically, and confirm.
 *
 * In both cases the consolidated queue mirror happens once (per buy,
 * not per slot) so the homepage Live Queue shows a single row.
 */
async function checkPullBoxPayment(session, discordUserId, customerEmail, lineItems = []) {
    if (session.metadata?.source !== 'pull_box') return;

    const pullBoxId = Number(session.metadata?.pull_box_id);
    if (!pullBoxId) return;

    const explicitSlotsRaw = session.metadata?.pull_box_slots || '';
    const explicitSlots = explicitSlotsRaw
        ? explicitSlotsRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)
        : null;

    const quantity = lineItems[0]?.quantity || 1;

    // Resolve buyer's Discord handle (when known) so the slot rows
    // and the queue entry both render with the friendly display label.
    let discordHandle = null;
    if (discordUserId) {
        try {
            const member = await getMember(discordUserId);
            discordHandle = member?.user?.username || member?.user?.tag || null;
        } catch {
            // Member fetch failed — proceed without; serializer falls
            // back to redacted email which is still recognizable.
        }
    }

    await recordPullBoxPurchase({
        stripeSessionId: session.id,
        pullBoxId,
        explicitSlots,
        quantity,
        discordUserId,
        discordHandle,
        customerEmail,
    });

    console.log(`Pull box #${pullBoxId} purchase: ${(explicitSlots || []).length || quantity} slot(s) for ${discordHandle || discordUserId || customerEmail}`);
}

/**
 * Combined handler — used by tests and direct calls.
 * Runs both phases sequentially (same behavior as before the split).
 */
async function handleCheckoutCompleted(session) {
    const context = await handleCheckoutCritical(session);
    if (context) {
        await handleCheckoutNotifications(session, context);
    }
}

/**
 * Check if the buyer selected domestic shipping but entered a non-US address.
 * If mismatched, DM the buyer a checkout link for the difference (or DM the
 * server owner if the buyer has no Discord account).
 */
async function checkShippingMismatch(session, discordUserId, customerEmail) {
    const shippingCountry = session.shipping_details?.address?.country;
    const shippingPaid = session.shipping_cost?.amount_total
        || session.total_details?.amount_shipping
        || 0;

    // Only relevant when shipping was charged and address is non-US
    if (!shippingCountry || shippingCountry === 'US' || shippingPaid === 0) return;

    // Check if they paid the domestic rate instead of international
    const difference = config.SHIPPING.INTERNATIONAL - shippingPaid;
    if (difference <= 0) return;

    const checkoutUrl = `${config.SHOP_URL.replace(/\/shop$/, '')}/bot/shipping/checkout`
        + `?amount=${difference}`
        + `&reason=${encodeURIComponent('Shipping Difference — International')}`
        + (discordUserId ? `&user=${discordUserId}` : '');

    console.log(`Shipping mismatch: ${customerEmail} paid ${shippingPaid} but address is ${shippingCountry} (owes ${difference})`);

    if (discordUserId) {
        // DM the buyer directly
        try {
            const member = await getMember(discordUserId);
            if (member) {
                const dm = await member.createDM();
                const embed = new EmbedBuilder()
                    .setTitle('📦 Shipping Adjustment Needed')
                    .setDescription(
                        `It looks like your order shipped to **${shippingCountry}** but was charged the US shipping rate.\n\n` +
                        `There's a **$${(difference / 100).toFixed(2)}** difference for international shipping. ` +
                        `Please use the link below to cover it — thanks!\n\n` +
                        `🛒 **[Pay Shipping Difference](${checkoutUrl})**`
                    )
                    .setColor(0xceff00);

                await dm.send({ embeds: [embed] });
                console.log(`Sent shipping mismatch DM to ${discordUserId}`);
            }
        } catch (e) {
            console.error(`Failed to DM buyer ${discordUserId} about shipping mismatch:`, e.message);
        }
    }

    // Always notify the server owner
    try {
        const guild = getGuild();
        if (guild) {
            const owner = await guild.members.fetch(guild.ownerId);
            if (owner) {
                const dm = await owner.createDM();
                const embed = new EmbedBuilder()
                    .setTitle('⚠️ Shipping Mismatch Detected')
                    .setDescription(
                        `**Email:** ${customerEmail}\n` +
                        `**Country:** ${shippingCountry}\n` +
                        `**Paid:** $${(shippingPaid / 100).toFixed(2)} (domestic)\n` +
                        `**Owed:** $${(config.SHIPPING.INTERNATIONAL / 100).toFixed(2)} (international)\n` +
                        `**Difference:** $${(difference / 100).toFixed(2)}\n` +
                        (discordUserId
                            ? `**Discord:** <@${discordUserId}> — DM sent with checkout link`
                            : `**Discord:** Not linked — reach out manually`) +
                        `\n\n🛒 **[Checkout Link](${checkoutUrl})**`
                    )
                    .setColor(0xe74c3c);

                await dm.send({ embeds: [embed] });
            }
        }
    } catch (e) {
        console.error('Failed to notify owner about shipping mismatch:', e.message);
    }
}

/**
 * Check and apply role promotions based on purchase count.
 * Lan (0) → Xipe (1+) → Long (5+)
 */
async function checkRolePromotion(discordUserId) {
    const row = purchases.getPurchaseCount.get(discordUserId);
    if (!row) return;

    const count = row.total_purchases;
    const member = await getMember(discordUserId);
    if (!member) return;

    // Promote to Xipe at 1+ purchases
    if (count >= config.XIPE_PURCHASE_THRESHOLD) {
        const added = await addRole(member, config.ROLES.XIPE);
        if (added) {
            console.log(`Promoted ${member.user.tag} to Xipe (${count} purchases)`);
        }
    }

    // Promote to Long at 5+ purchases
    if (count >= config.LONG_PURCHASE_THRESHOLD) {
        if (!hasRole(member, config.ROLES.LONG)) {
            await addRole(member, config.ROLES.LONG);
            console.log(`Promoted ${member.user.tag} to Long (${count} purchases)`);

            // Announce promotion
            await sendEmbed('ANNOUNCEMENTS', {
                title: '🎓 New Long Member!',
                description: `<@${discordUserId}> has been promoted to **Long** (Permanence) for making ${count} purchases! Your loyalty has been recognized.`,
                color: 0x3498db,
            });
        }
    }
}

/**
 * Check if a payment is a pack battle purchase and auto-enter the buyer.
 * Purchase = entry. No reaction needed.
 */
async function checkBattlePayment(session, discordUserId) {
    // Only process pack-battle purchases
    if (session.metadata?.source !== 'pack-battle') return;

    const battle = battles.getActiveBattle.get();
    if (!battle) return;

    // Attempt to add entry — the INSERT subquery atomically checks capacity
    const odiscordUserId = discordUserId || `unknown-${session.id}`;
    const result = battles.addEntry.run(battle.id, odiscordUserId, battle.id, battle.id);

    if (result.changes === 0) {
        // Battle is full — entry was rejected by the subquery
        console.log(`Battle #${battle.id} is full — payment from ${odiscordUserId} not added`);
        const buyerLabel = discordUserId ? `<@${discordUserId}>` : (session.customer_details?.email || 'unknown');
        await sendEmbed('OPS', {
            title: '⚠️ Battle Overfill — Refund Needed',
            description: `**${battle.product_name}** battle is full (${battle.max_entries}/${battle.max_entries}) but ${buyerLabel} just paid.\n\nStripe session: \`${session.id}\`\n\nThis buyer needs a refund.`,
            color: 0xe74c3c,
        });
        return;
    }
    battles.confirmPayment.run(session.id, battle.id, odiscordUserId);

    // Mirror entry into the unified queue (when QUEUE_SOURCE=wp this hits
    // WordPress; under sqlite this is a no-op since the SQLite adapter
    // only handles `order` entries via addToQueue). Idempotent on
    // external_ref so Stripe webhook retries don't duplicate.
    try {
        const activeQueue = await queueSource.getActiveQueue();
        if (activeQueue) {
            await queueSource.addEntry({
                queueId: activeQueue.id,
                discordUserId: discordUserId || null,
                customerEmail: session.customer_details?.email || null,
                productName: battle.product_name,
                quantity: 1,
                stripeSessionId: session.id,
                type: 'pack_battle',
                source: discordUserId ? 'discord' : 'shop',
                externalRef: `stripe:${session.id}:battle`,
                detailLabel: battle.product_name,
                detailData: { battleId: battle.id, format: battle.format || null },
            });
        }
    } catch (e) {
        console.error('Failed to mirror pack-battle entry to queue:', e.message);
    }

    const entries = battles.getEntries.all(battle.id);
    const paidEntries = battles.getPaidEntries.all(battle.id);

    // Auto-close if battle is now full
    if (paidEntries.length >= battle.max_entries) {
        const { next } = battles.getNextBattleNumber.get();
        battles.setBattleNumber.run(next, battle.id);
        battles.closeBattle.run(battle.id);

        await updateBattleMessage({ ...battle, battle_number: next }, entries, paidEntries, 'closed');
        await sendToChannel('PACK_BATTLES', `⚔️ <@${odiscordUserId}> is in! (${paidEntries.length}/${battle.max_entries}) — **Battle full! Entries closed.**`);
    } else {
        await updateBattleMessage(battle, entries, paidEntries, 'open');
        await sendToChannel('PACK_BATTLES', `⚔️ <@${odiscordUserId}> is in! (${paidEntries.length}/${battle.max_entries})`);
    }
}

/**
 * Check if a payment is for a card sale and mark the listing as sold.
 */
async function checkCardSalePayment(session, discordUserId, lineItems = []) {
    if (session.metadata?.source !== 'card-sale') return;

    const listingId = Number(session.metadata?.card_listing_id);
    if (!listingId) return;

    const listing = cardListings.getById.get(listingId);
    if (!listing || listing.status === 'sold') return;

    // Payment arrived after TTL expired — still honor the sale
    if (listing.status === 'expired') {
        console.log(`Card listing #${listingId} was expired but payment arrived — marking as sold`);
    }

    // Pull boxes stay open — record entry with buyer + quantity
    if (listing.status === 'pull') {
        const quantity = lineItems[0]?.quantity || 1;
        await recordPullPurchase(listingId, discordUserId, session.customer_details?.email, quantity, session.id);
        console.log(`Pull box #${listingId} purchase: ${listing.card_name} ×${quantity} for ${discordUserId || session.customer_details?.email}`);
        return;
    }

    cardListings.markSold.run(listingId);

    // Clear expiry timer and TTL, then update embed
    clearExpiryTimer(listingId);
    clearListingTtl(listingId);

    const updated = cardListings.getById.get(listingId);

    // Update the appropriate embed — list session or standalone
    if (updated.list_session_id) {
        const session = listSessions.getById.get(updated.list_session_id);
        if (session) await updateListSessionEmbed(session);
    } else {
        await updateListingEmbed(updated);
    }

    // Update the buyer's DM in place to show purchase confirmed
    if (discordUserId && listing.buyer_dm_message_id) {
        try {
            const member = await getMember(discordUserId);
            if (member) {
                const dm = await member.createDM();
                const dmMsg = await dm.messages.fetch(listing.buyer_dm_message_id);
                const embed = new EmbedBuilder()
                    .setTitle('✅ Purchase Confirmed!')
                    .setDescription(`**${listing.card_name}** is yours. Thanks for the purchase!`)
                    .setColor(0xceff00);
                await dmMsg.edit({ embeds: [embed], components: [] });
            }
        } catch (e) {
            console.error(`Failed to update card sale DM for ${discordUserId}:`, e.message);
        }
    }

    console.log(`Card listing #${listingId} sold: ${listing.card_name}`);
}

/**
 * Notify WordPress that a Stripe product is no longer purchasable.
 *
 * Triggered by product.updated (active true→false), product.deleted,
 * price.updated (active true→false), and price.deleted webhook events.
 * WP responds by setting stock=0 on every catalog post that references
 * the product and clearing the stale stripe_price_id /
 * stripe_product_id meta — so a buyer never adds an unpurchasable
 * item to their cart, even with a stale cache.
 *
 * Fire-and-forget (we already 200'd Stripe). Logs but doesn't throw on
 * WP-side failures — the pre-flight check in CreateCheckoutEndpoint is
 * a backstop.
 */
export async function notifyCatalogProductDeactivated(stripeProductId) {
    if (!stripeProductId || !config.SITE_URL || !config.LIVESTREAM_SECRET) {
        return;
    }
    try {
        const url = `${config.SITE_URL}/wp-json/shop/v1/catalog/stripe-product-deactivated`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Bot-Secret': config.LIVESTREAM_SECRET,
            },
            body: JSON.stringify({ stripeProductId }),
        });
        if (!response.ok) {
            console.error(`catalog-deactivate ${stripeProductId}: WP returned ${response.status}`);
            return;
        }
        const data = await response.json();
        if (data.matched > 0) {
            console.log(`catalog-deactivate ${stripeProductId}: cleared ${data.updated}/${data.matched} WP post(s)`);
        }
    } catch (e) {
        console.error(`catalog-deactivate ${stripeProductId}:`, e.message);
    }
}

/**
 * Resolve the stripeProductId from a Stripe price object. Price events
 * carry the product as a string ID on the price; this is just a typed
 * accessor so the dispatcher in server.js stays one-liner-clean.
 */
export function priceEventProductId(priceObject) {
    if (!priceObject) return null;
    return typeof priceObject.product === 'string' ? priceObject.product : (priceObject.product?.id ?? null);
}

export { handleCheckoutCritical, handleCheckoutNotifications, handleCheckoutCompleted };
