/**
 * Refund Command
 *
 * !refund @user [amount] [reason]              — refund next unrefunded purchase
 * !refund session <session_id> [amount] [reason] — refund a specific session
 *
 * Owner-only. Issues Stripe refunds (full or partial).
 * Automatically skips already-refunded purchases and moves to the next one.
 */

import Stripe from 'stripe';
import { EmbedBuilder } from 'discord.js';
import config from '../config.js';
import { purchases } from '../db.js';
import { sendEmbed, getMember } from '../discord.js';
import { cancelOrder as cancelShippingEasyOrder } from '../shippingeasy-api.js';

const stripe = new Stripe(config.STRIPE_SECRET_KEY);

async function handleRefund(message, args) {
    // Owner-only
    if (!message.member.roles.cache.has(config.ROLES.AKIVILI)) {
        return message.reply('Only the server owner can issue refunds.');
    }

    if (args.length === 0) {
        return message.reply(
            'Usage:\n' +
            '`!refund @user [amount] [reason]` — refund next unrefunded purchase\n' +
            '`!refund session <session_id> [amount] [reason]` — refund a specific session'
        );
    }

    const isSessionMode = args[0]?.toLowerCase() === 'session';

    if (isSessionMode) {
        // !refund session <session_id> [amount] [reason]
        const sessionId = args[1];
        if (!sessionId) {
            return message.reply('Usage: `!refund session <session_id> [amount] [reason]`');
        }

        const refundArgs = args.slice(2);
        const { amountCents, reason } = parseAmountAndReason(refundArgs);
        const purchase = purchases.getBySessionId.get(sessionId);

        try {
            await attemptRefund(message, sessionId, purchase, amountCents, reason);
        } catch (e) {
            console.error('Refund error:', e.message);
            if (e.message.includes('has already been refunded')) {
                return message.reply('This payment has already been fully refunded.');
            }
            return message.reply(`Stripe refund failed: ${e.message}`);
        }
    } else {
        // !refund @user [amount] [reason]
        const mentioned = message.mentions.users.first();
        if (!mentioned) {
            return message.reply('Usage: `!refund @user [amount] [reason]`');
        }

        const recentPurchases = purchases.getRecentsByDiscordId.all(mentioned.id);
        if (!recentPurchases.length) {
            return message.reply(`No purchases found for <@${mentioned.id}>.`);
        }

        const refundArgs = args.filter((a) => !a.startsWith('<@'));
        const { amountCents, reason } = parseAmountAndReason(refundArgs);

        // Try each purchase starting from most recent, skip already-refunded
        for (const purchase of recentPurchases) {
            try {
                await attemptRefund(message, purchase.stripe_session_id, purchase, amountCents, reason);
                return;
            } catch (e) {
                if (e.message.includes('has already been refunded')) {
                    continue;
                }
                console.error('Refund error:', e.message);
                return message.reply(`Stripe refund failed: ${e.message}`);
            }
        }

        return message.reply(`All recent purchases for <@${mentioned.id}> have already been refunded.`);
    }
}

/**
 * Parse amount and reason from args.
 */
function parseAmountAndReason(refundArgs) {
    const filtered = refundArgs.filter((a) => !a.startsWith('<@'));
    const amountArg = filtered.find((a) => /^\d+(\.\d{1,2})?$/.test(a));
    const amountCents = amountArg ? Math.round(parseFloat(amountArg) * 100) : null;

    const amountIndex = amountArg ? filtered.indexOf(amountArg) : -1;
    const reason = amountIndex >= 0
        ? filtered.slice(amountIndex + 1).join(' ') || null
        : filtered.join(' ') || null;

    return { amountCents, reason };
}

/**
 * Attempt a refund for a specific session. Throws on Stripe errors
 * (including "already refunded") so callers can handle retry logic.
 */
async function attemptRefund(message, sessionId, purchase, amountCents, reason) {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['payment_intent'],
    });

    const paymentIntent = session.payment_intent;
    if (!paymentIntent || typeof paymentIntent === 'string') {
        throw new Error(`Could not retrieve payment intent for session ${sessionId}`);
    }

    const refundParams = { payment_intent: paymentIntent.id };
    if (amountCents) refundParams.amount = amountCents;
    if (reason) refundParams.metadata = { reason };

    const refund = await stripe.refunds.create(refundParams);

    const refundDollars = (refund.amount / 100).toFixed(2);
    const originalDollars = purchase ? (purchase.amount / 100).toFixed(2) : 'unknown';
    const productName = purchase?.product_name || 'Unknown';
    const isPartial = amountCents && purchase?.amount && amountCents < purchase.amount;

    // Cancel the ShippingEasy order if this is a full refund of an unshipped physical order.
    // Partial refunds (e.g. "$5 back for a dinged card") leave the order intact — the customer keeps the item.
    const shipping = await maybeCancelShippingEasyOrder({ purchase, isPartial });

    await message.channel.send(
        `Refund issued — **$${refundDollars}**${isPartial ? ' (partial)' : ''} for ${productName}. Stripe refund \`${refund.id}\`${shipping.canceled ? ' — ShippingEasy order canceled' : ''}`
    );

    // Log to #ops
    await sendEmbed('OPS', {
        title: `💸 Refund Issued${isPartial ? ' (Partial)' : ''}`,
        description: [
            `**Product:** ${productName}`,
            `**Original:** $${originalDollars}`,
            `**Refunded:** $${refundDollars}`,
            reason ? `**Reason:** ${reason}` : null,
            `**Session:** \`${sessionId}\``,
            `**Refund ID:** \`${refund.id}\``,
            shipping.label ? `**ShippingEasy:** ${shipping.label}` : null,
            `**By:** ${message.author.tag}`,
        ].filter(Boolean).join('\n'),
        color: 0xe74c3c,
    });

    // DM the buyer
    const discordUserId = purchase?.discord_user_id || message.mentions.users.first()?.id;
    if (discordUserId) {
        try {
            const member = await getMember(discordUserId);
            if (member) {
                const dm = await member.createDM();
                const dmEmbed = new EmbedBuilder()
                    .setTitle(`💸 Refund Processed${isPartial ? ' (Partial)' : ''}`)
                    .setDescription(
                        `**$${refundDollars}** has been refunded for **${productName}**.\n\n` +
                        buildBuyerShippingMessage({ shipping, isPartial, purchase }) +
                        `\n\nThe refund should appear on your statement within 5-10 business days.` +
                        (reason ? `\n\n**Reason:** ${reason}` : '') +
                        `\n\nFull policy: ${config.SHOP_URL}/how-it-works/refund-policy`
                    )
                    .setColor(0xceff00);
                await dm.send({ embeds: [dmEmbed] });
            }
        } catch (e) {
            console.error(`Failed to DM refund notification to ${discordUserId}:`, e.message);
        }
    }
}

/**
 * Decide whether to cancel the ShippingEasy order, do it, and report the
 * outcome for downstream messaging.
 *
 * Returns `{ canceled, label }`:
 *   - `canceled` (bool) — true only when we actually killed the SE order
 *   - `label`            — short status string for the #ops embed, or null
 *                          when there is nothing shipping-related to report
 *
 * Cancel only when ALL of:
 *   - full refund (partial implies the customer keeps the item)
 *   - we have a shippingeasy_order_id
 *   - the order has not already been marked shipped or canceled
 */
async function maybeCancelShippingEasyOrder({ purchase, isPartial }) {
    if (!purchase) return { canceled: false, label: null };
    if (!purchase.shippingeasy_order_id) return { canceled: false, label: null };

    if (isPartial) {
        return { canceled: false, label: 'Order left in place (partial refund — buyer keeps item)' };
    }
    if (purchase.shipped_at) {
        return { canceled: false, label: `Already shipped ${purchase.shipped_at} — not canceled` };
    }
    if (purchase.shippingeasy_canceled_at) {
        return { canceled: false, label: 'Already canceled (no-op)' };
    }

    const ok = await cancelShippingEasyOrder({
        orderId: purchase.shippingeasy_order_id,
        sessionId: purchase.stripe_session_id,
        email: purchase.customer_email,
    });

    if (ok) {
        purchases.markShippingEasyCanceled.run(purchase.stripe_session_id);
        return { canceled: true, label: `Order canceled (\`${purchase.shippingeasy_order_id}\`)` };
    }

    return { canceled: false, label: `⚠️ Cancel failed (\`${purchase.shippingeasy_order_id}\`) — needs manual cleanup` };
}

/**
 * Build the shipping-related portion of the buyer's refund DM.
 *
 * Three messages depending on what happened to the physical order:
 *   1. We canceled an unshipped order → tell them it won't ship
 *   2. The order already shipped before refund → tell them to keep/return it
 *   3. Partial refund of physical order → reassure them it still ships
 *   4. No physical order (battle, ad-hoc, digital) → no shipping copy
 */
function buildBuyerShippingMessage({ shipping, isPartial, purchase }) {
    if (shipping.canceled) {
        return 'Your order has been canceled and will **not** ship.';
    }
    if (purchase?.shipping_address && purchase?.shipped_at && !isPartial) {
        return 'Your package has already shipped. If you have any questions about returning the item, please reply here.';
    }
    if (isPartial && purchase?.shipping_address) {
        return 'Your order is still on track to ship — this is a partial refund, not a cancellation.';
    }
    return '';
}

export { handleRefund };
