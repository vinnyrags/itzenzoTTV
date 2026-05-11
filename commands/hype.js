/**
 * Pre-Live Hype Command — !hype Product 1, Product 2, Product 3
 *
 * Posts a hype announcement in #announcements with product names, prices,
 * and direct checkout links. Run on stream days to drive pre-stream purchases.
 * Also drops raw checkout URLs in #ops for easy copy-paste to social platforms.
 *
 * Usage:
 *   !hype Prismatic Evolutions Booster Box, Crown Zenith ETB
 *   !hype Prismatic Evolutions Booster Box
 */

import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import Stripe from 'stripe';
import config from '../config.js';
import { sendToChannel } from '../discord.js';

/**
 * Look up a Stripe product by name. Returns { name, priceId, price } or null.
 */
async function findProduct(stripe, productName) {
    const products = await stripe.products.search({
        query: `active:"true" AND name~"${productName.replace(/"/g, '\\"')}"`,
        limit: 1,
    });

    if (!products.data.length) return null;

    const product = products.data[0];

    // Get the price ID
    let priceId = null;
    let unitAmount = null;

    if (product.default_price) {
        priceId = typeof product.default_price === 'string'
            ? product.default_price
            : product.default_price.id;
    }

    if (!priceId) {
        const prices = await stripe.prices.list({
            product: product.id,
            active: true,
            limit: 1,
        });
        if (prices.data.length) {
            priceId = prices.data[0].id;
            unitAmount = prices.data[0].unit_amount;
        }
    }

    if (!priceId) return null;

    // Fetch price amount if we don't have it yet
    if (unitAmount === null) {
        const price = await stripe.prices.retrieve(priceId);
        unitAmount = price.unit_amount;
    }

    // Check for sale price
    const salePriceId = product.metadata?.sale_price_id;
    let saleAmount = null;
    if (salePriceId) {
        try {
            const salePrice = await stripe.prices.retrieve(salePriceId);
            saleAmount = salePrice.unit_amount;
        } catch { /* sale price invalid — ignore */ }
    }

    return {
        name: product.name,
        priceId: salePriceId || priceId,
        price: unitAmount,
        salePrice: saleAmount,
        onSale: !!salePriceId,
    };
}

async function handleHype(message, args) {
    // Only owner/mods can hype
    const isAdmin = message.member.roles.cache.has(config.ROLES.NANOOK)
        || message.member.roles.cache.has(config.ROLES.AKIVILI);

    if (!isAdmin) {
        return message.reply('Only moderators can use this command.');
    }

    // Parse comma-separated product names from the full args
    const input = args.join(' ').trim();
    if (!input) {
        return message.reply('Usage: `!hype Product Name 1, Product Name 2`\n\nExample: `!hype Prismatic Evolutions Booster Box, Crown Zenith ETB`');
    }

    const productNames = input.split(',').map((s) => s.trim()).filter(Boolean);
    if (!productNames.length) {
        return message.reply('No product names found. Separate multiple products with commas.');
    }

    await message.channel.send(`🔍 Looking up ${productNames.length} product${productNames.length > 1 ? 's' : ''} in Stripe...`);

    const stripe = new Stripe(config.STRIPE_SECRET_KEY);
    const found = [];
    const notFound = [];

    for (const name of productNames) {
        const product = await findProduct(stripe, name);
        if (product) {
            found.push(product);
        } else {
            notFound.push(name);
        }
    }

    // Report any products not found
    if (notFound.length) {
        await message.channel.send(
            `⚠️ Could not find: ${notFound.map((n) => `**${n}**`).join(', ')}. Check spelling and try again.`
        );
    }

    if (!found.length) {
        return message.reply('No products found. Nothing to post.');
    }

    // Ask for confirmation before posting
    const preview = found.map((p) => {
        const priceStr = `$${(p.price / 100).toFixed(2)}`;
        const saleStr = p.onSale ? ` ~~${priceStr}~~ **$${(p.salePrice / 100).toFixed(2)}**` : ` **${priceStr}**`;
        return `• ${p.name} —${saleStr}`;
    }).join('\n');

    await message.channel.send(
        `**Preview — posting to #announcements:**\n${preview}\n\n✅ React to confirm, or type \`cancel\` to abort.`
    );

    // Wait for confirmation (reaction or cancel message)
    const confirmMsg = message.channel.lastMessage;

    try {
        await confirmMsg.react('✅');
    } catch { /* can't react */ }

    // Wait for either a ✅ reaction or a "cancel" message
    const confirmed = await Promise.race([
        confirmMsg.awaitReactions({
            filter: (r, u) => r.emoji.name === '✅' && u.id === message.author.id,
            max: 1,
            time: 60_000,
        }).then((collected) => collected.size > 0),
        new Promise((resolve) => {
            const collector = message.channel.createMessageCollector({
                filter: (m) => m.author.id === message.author.id && m.content.toLowerCase() === 'cancel',
                max: 1,
                time: 60_000,
            });
            collector.on('collect', () => resolve(false));
            collector.on('end', (_, reason) => { if (reason === 'time') resolve(false); });
        }),
    ]);

    if (!confirmed) {
        return message.channel.send('❌ Hype cancelled.');
    }

    // Build the hype embed with Discord buttons
    const baseUrl = config.SHOP_URL.replace(/\/shop$/, '');
    const productLines = found.map((p) => {
        const priceStr = `$${(p.price / 100).toFixed(2)}`;

        if (p.onSale) {
            return `🔥 **${p.name}** — ~~${priceStr}~~ **$${(p.salePrice / 100).toFixed(2)}**`;
        }
        return `🔥 **${p.name}** — **${priceStr}**`;
    });

    const embed = new EmbedBuilder()
        .setTitle('🎬 Card Night Tonight!')
        .setDescription(
            `Going live tonight at **8 PM EST** on TikTok and Instagram.\n\n` +
            `We're kicking things off with Pokemon, rolling into anime, with pack battles in between and closing out with the duck race.\n\n` +
            `Here's what I've got my eye on tonight:\n\n` +
            productLines.join('\n\n') +
            `\n\n🛒 **[Browse the full shop](${config.SHOP_URL})**`
        )
        .setColor(0xceff00)
        .setFooter({ text: 'Shipping: $10 US / $25 International — purchases go into the queue + duck race!' });

    // Build "Buy Now" buttons for each product
    const buttons = found.map((p) =>
        new ButtonBuilder()
            .setCustomId(`hype-buy-${p.priceId}`)
            .setLabel(`Buy ${p.name.length > 50 ? p.name.slice(0, 47) + '...' : p.name}`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🛒')
    );

    // Discord allows max 5 buttons per row
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    await sendToChannel('ANNOUNCEMENTS', { embeds: [embed], components: rows });

    // Post raw checkout URLs to #ops for social platforms (no buttons — direct links)
    const opsLines = [
        '🔗 **Checkout links for social:**',
        ...found.map((p) => {
            const checkoutUrl = `${baseUrl}/bot/product/checkout/${p.priceId}`;
            return `• **${p.name}** — <${checkoutUrl}>`;
        }),
        '',
        '*Paste these into IG Story link stickers, YouTube descriptions, or anywhere outside Discord.*',
    ];
    await sendToChannel('OPS', opsLines.join('\n'));

    await message.channel.send('🎬 Hype posted to #announcements! Checkout links dropped in #ops.');
}

export { handleHype };
