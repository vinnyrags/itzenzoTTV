/**
 * Coupon Commands
 *
 * !coupon create <CODE> <discount>    — Create a Stripe coupon + promotion code
 * !coupon <CODE>                      — Activate a promo code (shows input on checkout)
 * !coupon off                         — Deactivate the current promo code
 * !coupon status                      — Show current active coupon
 */

import Stripe from 'stripe';
import { EmbedBuilder } from 'discord.js';
import config from '../config.js';
import { coupons } from '../db.js';
import { sendEmbed } from '../discord.js';

/**
 * Route !coupon subcommands.
 */
async function handleCoupon(message, args) {
    const isAdmin = message.member.roles.cache.has(config.ROLES.NANOOK)
        || message.member.roles.cache.has(config.ROLES.AKIVILI);

    if (!isAdmin) {
        return message.reply('Only moderators can use this command.');
    }

    const sub = args[0]?.toLowerCase();

    if (!sub) {
        return message.reply('Usage: `!coupon create <CODE> <discount>`, `!coupon <CODE>`, `!coupon off`, `!coupon status`');
    }

    switch (sub) {
        case 'create':
            return handleCreate(message, args.slice(1));
        case 'off':
            return handleOff(message);
        case 'status':
            return handleStatus(message);
        default:
            // Treat as activation: !coupon SPRING20
            return handleActivate(message, sub.toUpperCase());
    }
}

// =========================================================================
// !coupon create <CODE> <discount>
// =========================================================================

async function handleCreate(message, args) {
    // Parse: !coupon create SPRING20 20% [uses]
    if (args.length < 2) {
        return message.reply('Usage: `!coupon create <CODE> <discount> [uses]`\nExamples: `!coupon create SPRING20 20%` (single use) or `!coupon create FLASH50 50% unlimited`');
    }

    const code = args[0].toUpperCase();
    const discountRaw = args[1];
    const usesArg = args[2]?.toLowerCase();
    const maxRedemptions = usesArg === 'unlimited' ? null : (parseInt(usesArg, 10) || 1);

    // Determine discount type
    const isPercent = discountRaw.endsWith('%');
    let couponParams;
    let displayDiscount;

    if (isPercent) {
        const percent = parseFloat(discountRaw.replace('%', ''));
        if (isNaN(percent) || percent <= 0 || percent > 100) {
            return message.reply('Percentage must be between 1 and 100.');
        }
        couponParams = { percent_off: percent, duration: 'once' };
        displayDiscount = `${percent}% off`;
    } else {
        const dollars = parseFloat(discountRaw);
        if (isNaN(dollars) || dollars <= 0) {
            return message.reply('Amount must be a positive number (e.g., `5.00`).');
        }
        const cents = Math.round(dollars * 100);
        couponParams = { amount_off: cents, currency: 'usd', duration: 'once' };
        displayDiscount = `$${dollars.toFixed(2)} off`;
    }

    try {
        // Pin API version — newer versions removed the coupon param from promotionCodes.create
        const stripe = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });

        // Check if promo code already exists in Stripe
        const existing = await stripe.promotionCodes.list({ code, limit: 1 });

        if (existing.data.length > 0) {
            const promo = existing.data[0];
            const existingCoupon = promo.coupon;

            // Check if the existing discount matches what was requested
            const matchesPercent = isPercent
                && existingCoupon.percent_off === couponParams.percent_off;
            const matchesAmount = !isPercent
                && existingCoupon.amount_off === couponParams.amount_off
                && existingCoupon.currency === 'usd';

            if (matchesPercent || matchesAmount) {
                return message.channel.send(
                    `✅ **Coupon already exists** — \`${code}\` (${displayDiscount})\n\n` +
                    `**DM this to the buyer:**\n` +
                    `> Here's a ${displayDiscount} code for your next purchase: **${code}** — enter it at checkout in the promo code field.`
                );
            }

            // Exists but with a different discount
            const existingDisplay = existingCoupon.percent_off
                ? `${existingCoupon.percent_off}% off`
                : `$${(existingCoupon.amount_off / 100).toFixed(2)} off`;

            return message.reply(
                `A promo code \`${code}\` already exists with a different discount (${existingDisplay}). ` +
                `Use a different code name or activate the existing one with \`!coupon ${code}\`.`
            );
        }

        // Create the coupon in Stripe
        const coupon = await stripe.coupons.create(couponParams);

        // Create the customer-facing promotion code
        const promoParams = { coupon: coupon.id, code };
        if (maxRedemptions) {
            promoParams.max_redemptions = maxRedemptions;
        }
        const promoCode = await stripe.promotionCodes.create(promoParams);

        const usesLabel = maxRedemptions ? `${maxRedemptions} use${maxRedemptions !== 1 ? 's' : ''}` : 'unlimited';

        await message.channel.send(
            `✅ **Coupon created** — \`${code}\` (${displayDiscount}, ${usesLabel})\n\n` +
            `**DM this to the buyer:**\n` +
            `> Here's a ${displayDiscount} code for your next purchase: **${code}** — enter it at checkout in the promo code field.`
        );
    } catch (e) {
        console.error('Coupon create error:', e.message);
        return message.reply(`Failed to create coupon: ${e.message}`);
    }
}

// =========================================================================
// !coupon <CODE> — activate
// =========================================================================

async function handleActivate(message, code) {
    // Check if already active
    const current = coupons.getActive.get();
    if (current) {
        return message.reply(
            `A coupon is already active: \`${current.promo_code}\`. ` +
            `Run \`!coupon off\` first to deactivate it.`
        );
    }

    // Verify the promo code exists and is active in Stripe
    try {
        const stripe = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
        const promoCodes = await stripe.promotionCodes.list({ code, limit: 1, expand: ['data.coupon'] });

        if (promoCodes.data.length === 0) {
            return message.reply(`No promotion code \`${code}\` found in Stripe. Create one first with \`!coupon create ${code} <discount>\`.`);
        }

        const promo = promoCodes.data[0];
        if (!promo.active) {
            return message.reply(`Promotion code \`${code}\` exists but is deactivated in Stripe.`);
        }

        // Build display discount
        const coupon = promo.coupon;
        const displayDiscount = coupon.percent_off
            ? `${coupon.percent_off}% off`
            : `$${(coupon.amount_off / 100).toFixed(2)} off`;

        // Store in DB — atomic INSERT rejects if another coupon is already active
        const result = coupons.activate.run(code, promo.id, coupon.id, displayDiscount);
        if (result.changes === 0) {
            return message.reply('A coupon was activated by someone else just now. Run `!coupon status` to check.');
        }

        // Announce
        await sendEmbed('ANNOUNCEMENTS', {
            title: '🏷️ Coupon Active!',
            description: `Use code **\`${code}\`** at checkout for **${displayDiscount}**!`,
            color: 0xceff00,
        });

        await message.channel.send(
            `🏷️ **Coupon activated**: \`${code}\` (${displayDiscount})\n` +
            `Checkout pages now show a promo code field. Run \`!coupon off\` to deactivate.`
        );
    } catch (e) {
        console.error('Coupon activate error:', e.message);
        return message.reply(`Failed to verify coupon in Stripe: ${e.message}`);
    }
}

// =========================================================================
// !coupon off
// =========================================================================

async function handleOff(message) {
    const current = coupons.getActive.get();

    if (!current) {
        return message.reply('No coupon is currently active.');
    }

    coupons.deactivate.run(current.id);

    await sendEmbed('ANNOUNCEMENTS', {
        title: '🏷️ Coupon Expired',
        description: `The **\`${current.promo_code}\`** code is no longer active.`,
        color: 0x95a5a6,
    });

    await message.channel.send(
        `🏷️ **Coupon deactivated**: \`${current.promo_code}\`\n` +
        `Promo code field removed from checkout.`
    );
}

// =========================================================================
// !coupon status
// =========================================================================

async function handleStatus(message) {
    const current = coupons.getActive.get();

    if (!current) {
        return message.channel.send('No coupon is currently active.');
    }

    const embed = new EmbedBuilder()
        .setTitle('🏷️ Active Coupon')
        .setDescription(
            `**Code:** \`${current.promo_code}\`\n` +
            `**Discount:** ${current.discount_display}\n` +
            `**Activated:** ${current.activated_at}`
        )
        .setColor(0xceff00);

    await message.channel.send({ embeds: [embed] });
}

/**
 * Check if a coupon is currently active (used by server.js checkout routes).
 */
function getActiveCoupon() {
    return coupons.getActive.get() || null;
}

export { handleCoupon, getActiveCoupon };
