/**
 * International Shipping Commands
 *
 * !intl @user CA     — Set a user's country code
 * !intl @user US     — Revert to domestic
 * !intl @user        — Check a user's current status
 * !intl list         — List all international users
 * !intl-ship         — DM international buyers with unpaid shipping this month
 */

import { EmbedBuilder } from 'discord.js';
import config from '../config.js';
import { purchases, shipping, discordLinks } from '../db.js';
import { getMember, sendToChannel } from '../discord.js';
import { formatShippingRate } from '../shipping.js';

/**
 * !intl — manage international user flags.
 */
async function handleIntl(message, args) {
    const isAdmin = message.member.roles.cache.has(config.ROLES.NANOOK)
        || message.member.roles.cache.has(config.ROLES.AKIVILI);

    if (!isAdmin) {
        return message.reply('Only moderators can use this command.');
    }

    // !intl list
    if (args[0]?.toLowerCase() === 'list') {
        return listInternational(message);
    }

    // Need a mentioned user for everything else
    const mentioned = message.mentions.users.first();
    if (!mentioned) {
        return message.reply(
            'Usage:\n' +
            '`!intl @user CA` — set country\n' +
            '`!intl @user` — check status\n' +
            '`!intl list` — list all international users'
        );
    }

    const countryCode = args.find((a) => a !== `<@${mentioned.id}>` && a !== `<@!${mentioned.id}>`)?.toUpperCase();

    // !intl @user — check status
    if (!countryCode) {
        return checkStatus(message, mentioned);
    }

    // Validate country code
    if (!config.SHIPPING.COUNTRIES.includes(countryCode)) {
        return message.reply(
            `Invalid country code: \`${countryCode}\`. Supported: ${config.SHIPPING.COUNTRIES.join(', ')}`
        );
    }

    // Set country
    discordLinks.setCountry.run(countryCode, mentioned.id);

    const isIntl = countryCode !== 'US';
    const rateLabel = isIntl
        ? formatShippingRate(config.SHIPPING.INTERNATIONAL)
        : formatShippingRate(config.SHIPPING.DOMESTIC);
    const cadence = isIntl ? 'monthly' : 'weekly';

    await message.channel.send(
        `🌍 <@${mentioned.id}> set to **${countryCode}** — ${rateLabel} shipping (${cadence}).`
    );
}

/**
 * Check a user's international status.
 */
async function checkStatus(message, user) {
    const row = discordLinks.getCountry.get(user.id);
    const country = row?.country;

    if (!country || country === 'US') {
        return message.channel.send(`<@${user.id}> is **domestic (US)** — ${formatShippingRate(config.SHIPPING.DOMESTIC)} weekly shipping.`);
    }

    return message.channel.send(`<@${user.id}> is **international (${country})** — ${formatShippingRate(config.SHIPPING.INTERNATIONAL)} monthly shipping.`);
}

/**
 * List all international users.
 */
async function listInternational(message) {
    const users = discordLinks.getInternationalUsers.all();

    if (!users.length) {
        return message.channel.send('No international users flagged.');
    }

    const lines = users.map((u) =>
        `• <@${u.discord_user_id}> — ${u.country} (${u.customer_email})`
    );

    const embed = new EmbedBuilder()
        .setTitle('🌍 International Users')
        .setDescription(lines.join('\n'))
        .setColor(0x3498db)
        .setFooter({ text: `${users.length} international user${users.length !== 1 ? 's' : ''}` });

    await message.channel.send({ embeds: [embed] });
}

/**
 * !intl-ship — DM international buyers with unpaid shipping this month.
 */
async function handleIntlShip(message) {
    if (!message.member.roles.cache.has(config.ROLES.AKIVILI)) {
        return message.reply('Only the server owner can run this command.');
    }

    // Find international users
    const intlUsers = discordLinks.getInternationalUsers.all();

    if (!intlUsers.length) {
        return message.reply('No international users flagged.');
    }

    // Check which ones have orders this month but no shipping payment
    const needsShipping = [];

    for (const user of intlUsers) {
        const hasPaid = shipping.hasShippingThisMonth.get(user.customer_email);
        if (hasPaid) continue;

        // Check if they have any purchases this month
        const hasPurchases = purchases.getDiscordIdByEmail.get(user.customer_email);
        if (!hasPurchases) continue;

        needsShipping.push(user);
    }

    if (!needsShipping.length) {
        return message.channel.send('✅ All international buyers have paid shipping this month.');
    }

    // DM each buyer
    let sent = 0;
    const baseUrl = config.SHOP_URL.replace(/\/shop$/, '');

    for (const user of needsShipping) {
        const shippingUrl = `${baseUrl}/bot/shipping/checkout`
            + `?amount=${config.SHIPPING.INTERNATIONAL}`
            + `&user=${user.discord_user_id}`
            + `&reason=${encodeURIComponent('International Shipping — Monthly')}`;

        const embed = new EmbedBuilder()
            .setTitle('🌍 International Shipping Reminder')
            .setDescription(
                `You have outstanding international shipping for this month.\n\n` +
                `📦 **[Pay ${formatShippingRate(config.SHIPPING.INTERNATIONAL)} International Shipping](${shippingUrl})**\n\n` +
                `This covers all your purchases through the end of the month.\n\n` +
                `Want to ship sooner? Just DM me and I can get your order out early.`
            )
            .setColor(0x3498db)
            .setFooter({ text: `${formatShippingRate(config.SHIPPING.INTERNATIONAL)} flat rate — covers all items this month.` });

        try {
            const member = await getMember(user.discord_user_id);
            if (member) {
                const dm = await member.createDM();
                await dm.send({ embeds: [embed] });
                sent++;
            }
        } catch { /* DMs disabled */ }
    }

    await message.channel.send(
        `🌍 International shipping reminders sent to ${sent}/${needsShipping.length} buyer(s).`
    );
}

export { handleIntl, handleIntlShip };
