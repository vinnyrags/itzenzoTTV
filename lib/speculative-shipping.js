/**
 * End-of-stream speculative-shipping settlement.
 *
 * Runs from `/offline` after the recap. Finds buyers who:
 *   - Have at least one speculative purchase since their last DM (pull
 *     box, individual booster pack, or pack-battle entry — anything with
 *     stripe metadata.source IN ('pull_box', 'speculative', 'pack_battle'))
 *   - Have NOT paid shipping for the current period
 *
 * For each linked-Discord buyer: DM them a Stripe shipping checkout link
 * with the intentional copy ("pay to receive, take no action to leave in
 * inventory, we hold for 4 weeks"). For unlinked buyers: surface in #ops
 * so the operator can email them or just let it ride.
 *
 * The DM is sent at most ONCE per fresh speculative purchase. If the
 * buyer ignored the previous DM and didn't make any new pull/pack
 * purchases, they don't get pinged again — the dedup is via
 * speculative_shipping_dms.sent_at vs purchases.created_at.
 *
 * Why this lives in lib/ and not commands/: it's a worker called BY a
 * command (handleOffline), not a command surface itself. Same pattern as
 * lib/queue-source, lib/wp-pull-box, etc.
 */

import Stripe from 'stripe';
import config from '../config.js';
import { purchases } from '../db.js';
import {
    isInternationalByEmail,
    getShippingRate,
    formatShippingRate,
} from '../shipping.js';
import { client, sendEmbed } from '../discord.js';

/**
 * Compute the period_start label for the buyer's current shipping
 * period — Monday for US (week-bucketed), first-of-month for intl.
 * Stored on each speculative_shipping_dms row so cross-period DMs
 * are tracked separately.
 */
function periodStartFor(email) {
    const now = new Date();
    if (isInternationalByEmail(email)) {
        return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    }
    // US: Monday of this week (UTC, ISO week — Mon=1)
    const day = now.getUTCDay(); // Sun=0, Mon=1, ...
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(now.getTime() - diff * 24 * 60 * 60 * 1000);
    return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Build the DM text — intentional tone, names the 4-week hold policy,
 * leaves no ambiguity about pay-vs-pass.
 */
function buildDmText({ name, rateLabel, periodLabel, checkoutUrl }) {
    return [
        `Hey ${name} — quick note from tonight's stream.`,
        '',
        `You bought items we open on stream (pulls / packs) tonight that we haven't shipped yet. Your cards are held in our inventory waiting on shipping coverage.`,
        '',
        `→ **To receive them:** pay ${rateLabel} for this ${periodLabel}'s shipping: ${checkoutUrl}`,
        `   Same payment also covers anything else you buy this period.`,
        '',
        `→ **To pass on them:** take no action. We hold un-shipped cards for **4 weeks** before returning them to our pulling pool.`,
    ].join('\n');
}

/**
 * Create a Stripe Checkout session for the buyer's shipping payment.
 * Mirrors the same pattern /shipping uses, just batched by /offline.
 */
async function createShippingCheckoutUrl(email) {
    const stripe = new Stripe(config.STRIPE_SECRET_KEY);
    const rate = getShippingRate(email);

    const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        expires_at: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 day window
        line_items: [{
            price_data: {
                currency: 'usd',
                product_data: { name: `Shipping (${formatShippingRate(rate)})` },
                unit_amount: rate * 100,
            },
            quantity: 1,
        }],
        customer_email: email,
        success_url: `${config.SHOP_URL}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: config.SHOP_URL,
        metadata: { source: 'shipping_settlement' },
    });

    return session.url;
}

/**
 * The /offline-time entry point. Returns a summary of what happened so
 * handleOffline can log it.
 *
 * @returns {Promise<{ dmed: string[], unlinked: string[], errors: string[] }>}
 */
export async function settleSpeculativeBuyers() {
    let candidates;
    try {
        candidates = purchases.getSpeculativeBuyersNeedingDm.all();
    } catch (e) {
        console.error('settleSpeculativeBuyers query failed:', e.message);
        return { dmed: [], unlinked: [], errors: [`query failed: ${e.message}`] };
    }

    const dmed = [];
    const unlinked = [];
    const errors = [];

    for (const row of candidates) {
        const email = row.email;
        const link = purchases.getDiscordIdByEmail.get(email);

        if (!link?.discord_user_id) {
            unlinked.push(email);
            continue;
        }

        try {
            const checkoutUrl = await createShippingCheckoutUrl(email);
            const user = await client.users.fetch(link.discord_user_id);
            const intl = isInternationalByEmail(email);
            const rate = getShippingRate(email);

            await user.send(buildDmText({
                name: user.username || user.tag || 'there',
                rateLabel: formatShippingRate(rate),
                periodLabel: intl ? 'month' : 'week',
                checkoutUrl,
            }));

            // Log the DM so we don't ping again unless they make a new
            // speculative purchase.
            purchases.insertSpeculativeDm.run(email, periodStartFor(email));
            dmed.push(email);
        } catch (e) {
            errors.push(`${email}: ${e.message}`);
            console.error(`Failed to DM ${email}:`, e.message);
        }
    }

    return { dmed, unlinked, errors };
}

/**
 * Post a single summary embed to #ops describing what the auto-DM
 * scan did this stream — who got DM'd, who's unlinked (manual
 * follow-up), any errors.
 */
export async function postOpsScanSummary({ dmed, unlinked, errors }) {
    if (dmed.length === 0 && unlinked.length === 0 && errors.length === 0) {
        return; // Nothing happened — no need to noise up #ops.
    }

    const fields = [];
    if (dmed.length > 0) {
        fields.push({
            name: `📨 DM'd (${dmed.length})`,
            value: dmed.slice(0, 20).join('\n') + (dmed.length > 20 ? `\n…+${dmed.length - 20} more` : ''),
            inline: false,
        });
    }
    if (unlinked.length > 0) {
        fields.push({
            name: `🔗 Unlinked — manual follow-up needed (${unlinked.length})`,
            value: unlinked.slice(0, 20).join('\n') + (unlinked.length > 20 ? `\n…+${unlinked.length - 20} more` : ''),
            inline: false,
        });
    }
    if (errors.length > 0) {
        fields.push({
            name: `⚠️ Errors (${errors.length})`,
            value: errors.slice(0, 10).join('\n'),
            inline: false,
        });
    }

    await sendEmbed('OPS', {
        title: '📦 Speculative-shipping DM scan',
        description: 'End-of-stream sweep for buyers with held items (pulls, packs, pack-battle entries) and no shipping payment for the current period.',
        fields,
        color: 0x9b59b6,
    });
}
