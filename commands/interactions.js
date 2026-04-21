/**
 * Discord Button & Modal Interaction Handlers
 *
 * Routes button clicks and modal submissions from Discord components
 * to the appropriate checkout flow. Each handler:
 *   1. Identifies the buyer (Discord ID → email lookup)
 *   2. Checks their shipping status
 *   3. Creates a personalized Stripe checkout session
 *   4. Replies with an ephemeral checkout URL
 *
 * Button customId prefixes:
 *   card-buy-{listingId}  — card shop purchase
 *   hype-buy-{priceId}    — hype product purchase
 *   battle-buy-{battleId} — battle buy-in
 *
 * Modal customId:
 *   email-link-{context}  — email entry for unlinked buyers
 */

import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import Stripe from 'stripe';
import config from '../config.js';
import { purchases, cardListings, listSessions, battles, giveaways } from '../db.js';
import { startExpiryTimer, clearListingTtl, updateListingEmbed, updateListSessionEmbed } from './card-shop.js';
import { handleGiveawayEntry } from './giveaway.js';
import {
    hasShippingCoveredByDiscordId,
    hasShippingCovered,
    getShippingLabel,
    isInternational,
    formatShippingRate,
} from '../shipping.js';

const baseUrl = config.SHOP_URL.replace(/\/shop$/, '');

/**
 * Route button interactions by customId prefix.
 */
async function handleButtonInteraction(interaction) {
    const customId = interaction.customId;

    if (customId.startsWith('card-buy-')) {
        const listingId = customId.replace('card-buy-', '');
        return handleCardBuy(interaction, Number(listingId));
    }

    if (customId.startsWith('hype-buy-')) {
        const priceId = customId.replace('hype-buy-', '');
        return handleHypeBuy(interaction, priceId);
    }

    if (customId.startsWith('pull-buy-')) {
        const listingId = customId.replace('pull-buy-', '');
        return handlePullBuy(interaction, Number(listingId));
    }

    if (customId.startsWith('battle-buy-')) {
        const battleId = customId.replace('battle-buy-', '');
        return handleBattleBuy(interaction, Number(battleId));
    }

    if (customId.startsWith('sell-buy-')) {
        const listingId = customId.replace('sell-buy-', '');
        return handleSellBuy(interaction, Number(listingId));
    }

    if (customId === 'welcome-link') {
        return handleWelcomeLink(interaction);
    }

    if (customId.startsWith('giveaway-enter-')) {
        const giveawayId = Number(customId.replace('giveaway-enter-', ''));
        return handleGiveawayButton(interaction, giveawayId);
    }
}

/**
 * Handle modal submissions — email linking and giveaway TikTok entry.
 */
async function handleModalSubmit(interaction) {
    // Giveaway TikTok username modal
    if (interaction.customId.startsWith('giveaway-tiktok-')) {
        const giveawayId = Number(interaction.customId.replace('giveaway-tiktok-', ''));
        const tiktokUsername = interaction.fields.getTextInputValue('tiktok_input')?.trim().replace(/^@/, '');

        if (!tiktokUsername) {
            return interaction.reply({ content: 'Please enter your TikTok username.', ephemeral: true });
        }

        return handleGiveawayEntry(interaction, giveawayId, tiktokUsername);
    }

    // Email linking modal (welcome channel)
    if (!interaction.customId.startsWith('email-link-')) return;

    return handleEmailLinkSubmit(interaction);
}

/**
 * Handle email modal submission for account linking.
 */
async function handleEmailLinkSubmit(interaction) {
    if (!interaction.customId.startsWith('email-link-')) return;

    const email = interaction.fields.getTextInputValue('email_input')?.trim();
    if (!email || !email.includes('@')) {
        return interaction.reply({ content: 'Please enter a valid email address.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    // Welcome channel Link Account — validate email in Stripe before linking
    try {
        const stripe = new Stripe(config.STRIPE_SECRET_KEY);
        const customers = await stripe.customers.list({ email, limit: 1 });
        if (!customers.data.length) {
            return interaction.editReply({ content: 'No purchases found for that email. Make sure you are using the same email you used at checkout.' });
        }
    } catch (e) {
        console.error('Stripe customer lookup error:', e.message);
        return interaction.editReply({ content: 'Could not verify email right now. Try again later.' });
    }

    purchases.linkDiscord.run(interaction.user.id, email);
    return interaction.editReply({ content: 'Your account has been linked! Your name will now appear in the queue, order feed, and duck race roster.' });
}

/**
 * Show email prompt modal for unlinked buyers.
 */
function showEmailModal(interaction, contextPrefix) {
    const modal = new ModalBuilder()
        .setCustomId(`email-link-${contextPrefix}`)
        .setTitle('Enter Your Email');

    const emailInput = new TextInputBuilder()
        .setCustomId('email_input')
        .setLabel('Email address (used for shipping status)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('you@example.com');

    const row = new ActionRowBuilder().addComponents(emailInput);
    modal.addComponents(row);

    return interaction.showModal(modal);
}

/**
 * Build a personalized checkout URL with optional ?user= param.
 */
function buildCheckoutUrl(path, discordUserId) {
    const url = `${baseUrl}/bot/${path}`;
    return discordUserId ? `${url}?user=${discordUserId}` : url;
}

/**
 * Card shop button handler.
 */
async function handleCardBuy(interaction, listingId) {
    const discordUserId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    const listing = cardListings.getById.get(listingId);
    if (!listing || listing.status === 'sold' || listing.status === 'expired') {
        return interaction.editReply({ content: 'This card is no longer available.' });
    }

    // If already reserved by someone else, block
    if (listing.status === 'reserved' && listing.buyer_discord_id !== discordUserId) {
        return interaction.editReply({ content: 'This card is already being purchased by someone else.' });
    }

    // First click on an active listing — reserve it for this buyer
    if (listing.status === 'active') {
        const result = cardListings.reserveForBuyer.run(discordUserId, listingId);
        if (result.changes === 0) {
            // Race condition — someone else reserved it between our check and update
            return interaction.editReply({ content: 'This card is already being purchased by someone else.' });
        }
        const reserved = cardListings.getById.get(listingId);
        await updateListingEmbed(reserved);
        clearListingTtl(listingId); // Pause TTL — reservation expiry takes over
        startExpiryTimer(listingId);
    }

    const covered = hasShippingCoveredByDiscordId(discordUserId);
    const checkoutUrl = buildCheckoutUrl(`card-shop/checkout/${listingId}`, discordUserId);

    const shippingNote = covered
        ? '✅ Shipping already covered this period!'
        : `📦 Includes ${formatShippingRate(getShippingLabel(discordUserId).rate)} shipping`;

    await interaction.editReply({
        content: `🃏 **${listing.card_name}** — $${(listing.price / 100).toFixed(2)}\n${shippingNote}\n\n🛒 **[Complete Purchase](${checkoutUrl})**\n\n⏰ Reserved for you — 30 minutes to complete.`,
    });
}

/**
 * Reserved card (sell) button handler — same flow as card-buy.
 */
async function handleSellBuy(interaction, listingId) {
    const discordUserId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    const listing = cardListings.getById.get(listingId);
    if (!listing || listing.status !== 'reserved') {
        return interaction.editReply({ content: 'This reservation is no longer available.' });
    }

    const covered = hasShippingCoveredByDiscordId(discordUserId);
    const checkoutUrl = buildCheckoutUrl(`card-shop/checkout/${listingId}`, discordUserId);

    const shippingNote = covered
        ? '✅ Shipping already covered this period!'
        : `📦 Includes ${formatShippingRate(getShippingLabel(discordUserId).rate)} shipping`;

    await interaction.editReply({
        content: `🃏 **${listing.card_name}** — $${(listing.price / 100).toFixed(2)}\n${shippingNote}\n\n🛒 **[Complete Purchase](${checkoutUrl})**`,
    });
}

/**
 * Hype product button handler.
 */
async function handleHypeBuy(interaction, priceId) {
    const discordUserId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    const covered = hasShippingCoveredByDiscordId(discordUserId);
    const checkoutUrl = buildCheckoutUrl(`product/checkout/${priceId}`, discordUserId);

    const shippingNote = covered
        ? '✅ Shipping already covered this period!'
        : `📦 Includes ${formatShippingRate(getShippingLabel(discordUserId).rate)} shipping`;

    await interaction.editReply({
        content: `🔥 Ready to check out!\n${shippingNote}\n\n🛒 **[Complete Purchase](${checkoutUrl})**`,
    });
}

/**
 * Battle buy-in button handler.
 */
async function handleBattleBuy(interaction, battleId) {
    const discordUserId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    const battle = battles.getBattleById.get(battleId);
    if (!battle || battle.status !== 'open') {
        return interaction.editReply({ content: 'This battle is no longer open.' });
    }

    // Check if user already entered this battle
    const entries = battles.getEntries.all(battle.id);
    if (entries.some((e) => e.discord_user_id === discordUserId)) {
        return interaction.editReply({ content: `You're already in this battle! One entry per person. Good luck! 🍀` });
    }

    const checkoutUrl = buildCheckoutUrl(`battle/checkout/${battleId}`, discordUserId);

    await interaction.editReply({
        content: `⚔️ **${battle.product_name}** Pack Battle\n📦 Shipping is only charged if you win\n\n🛒 **[Buy Your Pack](${checkoutUrl})**`,
    });
}

/**
 * Welcome channel Link Account button handler.
 */
async function handleWelcomeLink(interaction) {
    const discordUserId = interaction.user.id;

    // Check if already linked
    const link = purchases.getEmailByDiscordId.get(discordUserId);
    if (link) {
        return interaction.reply({
            content: `Your account is already linked to **${link.customer_email}**.`,
            ephemeral: true,
        });
    }

    return showEmailModal(interaction, 'welcome');
}

/**
 * Giveaway entry button handler.
 * Standard giveaways: enter immediately.
 * Social giveaways: show TikTok username modal first.
 */
async function handleGiveawayButton(interaction, giveawayId) {
    const giveaway = giveaways.getById.get(giveawayId);
    if (!giveaway || giveaway.status !== 'open') {
        return interaction.reply({ content: 'This giveaway is no longer open.', ephemeral: true });
    }

    // Social giveaway — show TikTok username modal
    if (giveaway.is_social) {
        const modal = new ModalBuilder()
            .setCustomId(`giveaway-tiktok-${giveawayId}`)
            .setTitle('Enter Giveaway');

        const tiktokInput = new TextInputBuilder()
            .setCustomId('tiktok_input')
            .setLabel('Your TikTok username')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('itzenzottv');

        const row = new ActionRowBuilder().addComponents(tiktokInput);
        modal.addComponents(row);

        return interaction.showModal(modal);
    }

    // Standard giveaway — enter directly
    return handleGiveawayEntry(interaction, giveawayId);
}

/**
 * Pull box button handler — same as card buy but allows 'pull' status.
 */
async function handlePullBuy(interaction, listingId) {
    const discordUserId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    const listing = cardListings.getById.get(listingId);
    if (!listing || listing.status !== 'pull') {
        return interaction.editReply({ content: 'This pull box is no longer available.' });
    }

    // Check capacity
    if (listing.max_quantity && listing.purchase_count >= listing.max_quantity) {
        return interaction.editReply({ content: '🚫 This pull box is sold out!' });
    }

    const covered = hasShippingCoveredByDiscordId(discordUserId);
    const checkoutUrl = buildCheckoutUrl(`card-shop/checkout/${listingId}`, discordUserId);

    const shippingNote = covered
        ? '✅ Shipping already covered this period!'
        : `📦 Includes ${formatShippingRate(getShippingLabel(discordUserId).rate)} shipping`;

    await interaction.editReply({
        content: `🎰 **${listing.card_name}** — $${(listing.price / 100).toFixed(2)}\n${shippingNote}\n\n🛒 **[Buy Pack(s)](${checkoutUrl})**`,
    });
}

/**
 * Route select menu interactions by customId prefix.
 */
async function handleSelectMenuInteraction(interaction) {
    const customId = interaction.customId;

    if (customId.startsWith('list-buy-')) {
        const sessionId = Number(customId.replace('list-buy-', ''));
        const listingId = Number(interaction.values[0]);
        return handleListBuy(interaction, sessionId, listingId);
    }
}

/**
 * List session select menu handler — reserve a card and provide checkout.
 */
async function handleListBuy(interaction, sessionId, listingId) {
    const discordUserId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    const listing = cardListings.getById.get(listingId);
    if (!listing || listing.status !== 'active' || listing.list_session_id !== sessionId) {
        return interaction.editReply({ content: 'This card is no longer available.' });
    }

    // Reserve for buyer (atomic — only one user can win the race)
    const result = cardListings.reserveForBuyer.run(discordUserId, listingId);
    if (result.changes === 0) {
        return interaction.editReply({ content: 'This card is already being purchased by someone else.' });
    }

    // Update the summary embed (removes this item from select menu, shows reserved)
    const session = listSessions.getById.get(sessionId);
    if (session) {
        await updateListSessionEmbed(session);
    }

    // Start 30-min expiry timer
    startExpiryTimer(listingId);

    // Send checkout link
    const covered = hasShippingCoveredByDiscordId(discordUserId);
    const checkoutUrl = buildCheckoutUrl(`card-shop/checkout/${listingId}`, discordUserId);

    const shippingNote = covered
        ? '✅ Shipping already covered this period!'
        : `📦 Includes ${formatShippingRate(getShippingLabel(discordUserId).rate)} shipping`;

    await interaction.editReply({
        content: `🃏 **${listing.card_name}** — $${(listing.price / 100).toFixed(2)}\n${shippingNote}\n\n🛒 **[Complete Purchase](${checkoutUrl})**\n\n⏰ Reserved for you — 30 minutes to complete.`,
    });
}

export { handleButtonInteraction, handleModalSubmit, handleSelectMenuInteraction };
