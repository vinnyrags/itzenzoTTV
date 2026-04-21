/**
 * Pull Box Command — !pull "Name" 3.00 [max] / !pull close
 *
 * Owner-only. Creates a persistent listing in #card-shop that multiple
 * buyers can purchase from. Unlike !list (one buyer, marks sold), pull
 * boxes stay open until manually closed or stock is exhausted.
 *
 * Usage:
 *   !pull "Mystery Pull Box" 3.00       — open unlimited pull box
 *   !pull "Mystery Pull Box" 3.00 50    — open with max 50 pulls
 *   !pull close                          — close the active pull box
 *   !pull status                         — show active pull box info
 */

import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import config from '../config.js';
import { cardListings, pullEntries } from '../db.js';
import { client, getChannel, sendEmbed } from '../discord.js';
import { formatShippingRate } from '../shipping.js';

/**
 * Get the currently active pull box (status = 'pull').
 */
function getActivePull() {
    return cardListings.getByStatus.get('pull') || null;
}

/**
 * !pull — main handler
 */
async function handlePull(message, args) {
    if (!message.member.roles.cache.has(config.ROLES.AKIVILI)) {
        return message.reply('Only the server owner can manage pull boxes.');
    }

    const subcommand = args[0]?.toLowerCase();

    if (subcommand === 'close') {
        return handlePullClose(message);
    }

    if (subcommand === 'status') {
        return handlePullStatus(message);
    }

    return handlePullOpen(message);
}

/**
 * Open a new pull box.
 */
async function handlePullOpen(message) {
    const existing = getActivePull();
    if (existing) {
        return message.reply(`A pull box is already active: **${existing.card_name}**. Close it first with \`!pull close\`.`);
    }

    const fullText = message.content;
    const nameMatch = fullText.match(/"([^"]+)"/);
    if (!nameMatch) {
        return message.reply('Usage: `!pull "Pull Box Name" 3.00`');
    }
    const name = nameMatch[1];

    const afterQuote = fullText.slice(fullText.lastIndexOf('"') + 1).trim();
    const numbers = afterQuote.match(/[\d]+(?:\.[\d]{1,2})?/g);
    if (!numbers || numbers.length === 0) {
        return message.reply('Include a price: `!pull "Pull Box Name" 3.00 [max]`');
    }
    const priceCents = Math.round(parseFloat(numbers[0]) * 100);
    const maxQuantity = numbers[1] ? parseInt(numbers[1], 10) : null;

    if (priceCents <= 0) {
        return message.reply('Price must be greater than zero.');
    }

    // Create listing with status 'pull' and optional max quantity
    const result = cardListings.create.run(name, priceCents, null, 'pull');
    const listingId = Number(result.lastInsertRowid);

    if (maxQuantity && maxQuantity > 0) {
        cardListings.setMaxQuantity.run(maxQuantity, listingId);
    }

    const channel = getChannel('CARD_SHOP');
    if (!channel) {
        return message.reply('Card shop channel not found. Check config.');
    }

    const embed = buildPullEmbed(name, priceCents, 0, [], maxQuantity);
    const buyButton = new ButtonBuilder()
        .setCustomId(`pull-buy-${listingId}`)
        .setLabel('Buy Pack(s)')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🎰');

    const row = new ActionRowBuilder().addComponents(buyButton);
    const msg = await channel.send({ embeds: [embed], components: [row] });
    cardListings.setMessageId.run(msg.id, listingId);

    if (message.channel.id !== channel.id) {
        const capLabel = maxQuantity ? ` (${maxQuantity} max)` : '';
        await message.channel.send(`🎰 Pull box **${name}** ($${(priceCents / 100).toFixed(2)})${capLabel} is live in <#${config.CHANNELS.CARD_SHOP}>!`);
    }
}

/**
 * Close the active pull box.
 */
async function handlePullClose(message) {
    const pull = getActivePull();
    if (!pull) {
        return message.reply('No active pull box to close.');
    }

    cardListings.markSold.run(pull.id);

    // Update embed — remove button, show final count + entries
    const entries = pullEntries.getEntries.all(pull.id);
    try {
        const channel = getChannel('CARD_SHOP');
        if (channel && pull.message_id) {
            const msg = await channel.messages.fetch(pull.message_id);
            const entryLines = entries.map((e, i) => {
                const label = e.discord_user_id ? `<@${e.discord_user_id}>` : (e.customer_email || 'Unknown');
                return `${i + 1}. ${label}${e.quantity > 1 ? ` ×${e.quantity}` : ''}`;
            });
            const embed = new EmbedBuilder()
                .setTitle(`🎰 ${pull.card_name}`)
                .setDescription(
                    `~~$${(pull.price / 100).toFixed(2)}~~\n\n` +
                    `**CLOSED** — ${pull.purchase_count} pull${pull.purchase_count !== 1 ? 's' : ''} sold` +
                    (entryLines.length > 0 ? `\n\n${entryLines.join('\n')}` : '')
                )
                .setColor(0xe74c3c)
                .setFooter({ text: `Pull Box #${pull.id}` });
            await msg.edit({ embeds: [embed], components: [] });
        }
    } catch (e) {
        console.error('Failed to update pull box embed:', e.message);
    }

    const revenue = (pull.purchase_count * pull.price / 100).toFixed(2);
    await message.channel.send(`🎰 Pull box **${pull.card_name}** closed — ${pull.purchase_count} pulls ($${revenue} revenue).`);
}

/**
 * Show active pull box status.
 */
async function handlePullStatus(message) {
    const pull = getActivePull();
    if (!pull) {
        return message.reply('No active pull box.');
    }

    const revenue = (pull.purchase_count * pull.price / 100).toFixed(2);
    const capacityInfo = pull.max_quantity
        ? ` / ${pull.max_quantity} max (${Math.max(0, pull.max_quantity - pull.purchase_count)} remaining)`
        : '';
    await message.reply(
        `🎰 **${pull.card_name}** — $${(pull.price / 100).toFixed(2)}/pull\n` +
        `Pulls sold: **${pull.purchase_count}**${capacityInfo} ($${revenue} revenue)`
    );
}

/**
 * Build the pull box embed.
 */
function buildPullEmbed(name, priceCents, purchaseCount, entries = [], maxQuantity = null) {
    const priceLabel = `$${(priceCents / 100).toFixed(2)}`;
    const shippingNote = `*Shipping: ${formatShippingRate(config.SHIPPING.DOMESTIC)} US / ${formatShippingRate(config.SHIPPING.INTERNATIONAL)} International (waived if already covered this week/month)*`;
    const isFull = maxQuantity && purchaseCount >= maxQuantity;

    const lines = [];

    if (isFull) {
        lines.push(`~~${priceLabel}~~ — **SOLD OUT**`);
    } else {
        lines.push(`**${priceLabel}** per pull — click Buy Pack(s) to check out`);
    }

    if (maxQuantity) {
        const remaining = Math.max(0, maxQuantity - purchaseCount);
        lines.push(`📦 **${purchaseCount}/${maxQuantity}** pulls sold${remaining > 0 ? ` — ${remaining} remaining` : ''}`);
    } else if (purchaseCount > 0) {
        lines.push(`🎯 **${purchaseCount}** pull${purchaseCount !== 1 ? 's' : ''} sold`);
    }

    if (entries.length > 0) {
        const entryLines = entries.map((e, i) => {
            const label = e.discord_user_id ? `<@${e.discord_user_id}>` : (e.customer_email || 'Unknown');
            return `${i + 1}. ${label}${e.quantity > 1 ? ` ×${e.quantity}` : ''}`;
        });
        lines.push('', entryLines.join('\n'));
    }

    lines.push('', shippingNote);

    return new EmbedBuilder()
        .setTitle(`🎰 ${name}`)
        .setDescription(lines.join('\n'))
        .setColor(isFull ? 0xe74c3c : 0x9b59b6)
        .setFooter({ text: maxQuantity ? `Pull box — ${maxQuantity} max` : 'Pull box — open for multiple buyers' });
}

/**
 * Called by the Stripe webhook when a pull box purchase completes.
 * Increments the counter and updates the embed.
 */
async function recordPullPurchase(listingId, discordUserId = null, customerEmail = null, quantity = 1) {
    // Atomic capacity check — only increments if under the cap
    const result = cardListings.incrementPurchaseCountCapped.run(quantity, listingId, quantity);

    if (result.changes === 0) {
        // Box is full — payment went through Stripe but we can't fulfill
        console.error(`Pull box #${listingId} is full — purchase by ${discordUserId || customerEmail} needs refund`);
        await sendEmbed('OPS', {
            title: '⚠️ Pull Box Oversold',
            description: `Pull box #${listingId} is full but a payment was processed.\n\n` +
                `**Buyer:** ${discordUserId ? `<@${discordUserId}>` : (customerEmail || 'Unknown')}\n` +
                `**Quantity:** ${quantity}\n\n` +
                `Refund needed — use \`!refund\` to process.`,
            color: 0xff0000,
        }).catch(() => {});
        return;
    }

    // Record individual entry
    pullEntries.addEntry.run(listingId, discordUserId, customerEmail, quantity);

    const listing = cardListings.getById.get(listingId);
    if (!listing || !listing.message_id) return;

    // Check if box is now full
    const isFull = listing.max_quantity && listing.purchase_count >= listing.max_quantity;

    // Update embed with entries list
    try {
        const channel = getChannel('CARD_SHOP');
        if (!channel) return;

        const entries = pullEntries.getEntries.all(listingId);
        const msg = await channel.messages.fetch(listing.message_id);
        const embed = buildPullEmbed(listing.card_name, listing.price, listing.purchase_count, entries, listing.max_quantity);

        if (isFull) {
            // Remove buy button when sold out
            await msg.edit({ embeds: [embed], components: [] });
        } else {
            await msg.edit({ embeds: [embed] });
        }
    } catch (e) {
        console.error('Failed to update pull box embed:', e.message);
    }
}

export { handlePull, getActivePull, recordPullPurchase };
