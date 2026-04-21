/**
 * Dropped Off Command — !dropped-off
 *
 * Notifies all buyers with unshipped orders that their packages are on the way.
 * Run this every Monday after dropping off packages at the post office.
 *
 * Flow:
 *   1. Query all purchases where shipped_at IS NULL and discord_user_id IS NOT NULL
 *   2. Group by user — one DM per person listing all their products
 *   3. Post a public "Orders Shipped" embed in #order-feed
 *   4. Post a detailed summary in #ops
 *   5. Stamp shipped_at on all processed rows
 *
 * Usage:
 *   !dropped-off
 */

import { EmbedBuilder } from 'discord.js';
import config from '../config.js';
import { purchases, discordLinks, queues, shipping, tracking } from '../db.js';
import { getMember, sendEmbed, sendToChannel } from '../discord.js';

async function handleDroppedOff(message, args = []) {
    // Only owner can run this
    if (!message.member.roles.cache.has(config.ROLES.AKIVILI)) {
        return message.reply('Only the server owner can run this command.');
    }

    const isIntlMode = args[0]?.toLowerCase() === 'intl';

    // Get all unshipped purchases with linked Discord users
    let unshipped = purchases.getUnshipped.all();

    // Exclude purchases in the active pre-order queue (not yet opened on stream)
    const activeQueue = queues.getActiveQueue.get();
    if (activeQueue) {
        const activeEntries = queues.getEntries.all(activeQueue.id);
        const activeSessionIds = new Set(activeEntries.map((e) => e.stripe_session_id).filter(Boolean));
        const before = unshipped.length;
        unshipped = unshipped.filter((row) => !activeSessionIds.has(row.stripe_session_id));
        const excluded = before - unshipped.length;
        if (excluded > 0) {
            console.log(`Dropped-off: excluded ${excluded} purchases in active queue #${activeQueue.id}`);
        }
    }

    // Determine if a buyer is international: country flag OR paid international shipping rate
    function isInternationalBuyer(discordUserId, email) {
        const country = discordLinks.getCountry.get(discordUserId);
        if (country?.country && country.country !== 'US') return true;
        // Check if they paid international shipping rate ($25 = 2500 cents)
        const shippingRecord = email
            ? shipping.getByEmailThisMonth.get(email)
            : null;
        return shippingRecord?.amount === config.SHIPPING.INTERNATIONAL;
    }

    // Filter by domestic or international
    if (isIntlMode) {
        unshipped = unshipped.filter((row) => isInternationalBuyer(row.discord_user_id, row.customer_email));
    } else {
        unshipped = unshipped.filter((row) => !isInternationalBuyer(row.discord_user_id, row.customer_email));
    }

    if (unshipped.length === 0) {
        return message.reply(`No unshipped ${isIntlMode ? 'international ' : ''}orders to notify.`);
    }

    // Group purchases by discord_user_id
    const byUser = new Map();
    for (const row of unshipped) {
        if (!byUser.has(row.discord_user_id)) {
            byUser.set(row.discord_user_id, []);
        }
        byUser.get(row.discord_user_id).push(row);
    }

    // Also count purchases without a linked Discord user (only for domestic mode)
    const skipped = isIntlMode ? [] : purchases.getUnshippedNoDiscord.all();

    let dmsSent = 0;
    let dmsFailed = 0;
    const failedUsers = [];

    // DM each unique buyer
    for (const [userId, userPurchases] of byUser) {
        // Build product list — aggregate quantities for duplicate product names
        const productCounts = new Map();
        for (const p of userPurchases) {
            const name = p.product_name || 'Unknown Product';
            productCounts.set(name, (productCounts.get(name) || 0) + 1);
        }

        const productList = [...productCounts.entries()]
            .map(([name, qty]) => qty > 1 ? `• ${name} (×${qty})` : `• ${name}`)
            .join('\n');

        // Look up tracking info for this buyer
        const link = purchases.getEmailByDiscordId.get(userId);
        const trackingRecord = link ? tracking.getRecentByEmail.get(link.customer_email) : null;

        let trackingSection;
        if (trackingRecord) {
            trackingSection = `\n📬 **Tracking:** ${trackingRecord.tracking_number}`;
            if (trackingRecord.tracking_url) {
                trackingSection += `\n🔗 [Track your package](${trackingRecord.tracking_url})`;
            }
            if (trackingRecord.carrier) {
                trackingSection += ` (${trackingRecord.carrier})`;
            }
            trackingSection += '\n📅 Expect delivery in 5-7 business days';
        } else {
            trackingSection = '\n📅 Expect delivery in 5-7 business days\nNeed tracking? Just reply here and I\'ll get it to you.';
        }

        const embed = new EmbedBuilder()
            .setTitle('📦 Your Order Is On Its Way!')
            .setDescription(
                `Hey! Your order from itzenzo.tv has been shipped:\n\n${productList}\n${trackingSection}`
            )
            .setColor(0xceff00)
            .setFooter({ text: `Shipped ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' })}` });

        try {
            const member = await getMember(userId);
            if (member) {
                const dm = await member.createDM();
                await dm.send({ embeds: [embed] });
                dmsSent++;
            } else {
                dmsFailed++;
                failedUsers.push(userId);
            }
        } catch {
            dmsFailed++;
            failedUsers.push(userId);
        }
    }

    // Mark these purchases as shipped
    for (const row of unshipped) {
        purchases.markShipped.run();
    }

    // Post public notification in #order-feed
    const orderFeedTitle = isIntlMode ? '🌍 International Orders Shipped!' : '📬 Orders Shipped!';
    const orderFeedDesc = isIntlMode
        ? `International orders for this month have been shipped!\n\n` +
          `📦 **${unshipped.length} order${unshipped.length !== 1 ? 's' : ''} shipped to ${byUser.size} buyer${byUser.size !== 1 ? 's' : ''}** — Monthly batch\n\n` +
          'If you placed an international order, check your DMs for details.\n\n' +
          'Want to ship sooner next time? DM me anytime and I can get your order out early.'
        : `All orders from this week have been dropped off and are on their way!\n\n` +
          `📦 **${unshipped.length + skipped.length} order${unshipped.length + skipped.length !== 1 ? 's' : ''} shipped to ${byUser.size + skipped.length} buyer${byUser.size + skipped.length !== 1 ? 's' : ''}**\n\n` +
          '📅 Expect delivery in 5-7 business days\n' +
          'Check your DMs for tracking info.';

    await sendEmbed('ORDER_FEED', {
        title: orderFeedTitle,
        description: orderFeedDesc,
        color: 0x3498db,
        footer: new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' }),
    });

    // Post detailed summary in #ops
    const opsLines = [
        `• ${unshipped.length} orders across ${byUser.size} Discord-linked buyers`,
        `• ${dmsSent} DMs sent successfully`,
    ];

    if (dmsFailed > 0) {
        opsLines.push(`• ⚠️ ${dmsFailed} DMs failed: ${failedUsers.map((id) => `<@${id}>`).join(', ')}`);
    }

    if (skipped.length > 0) {
        opsLines.push(`• ${skipped.length} orders skipped (no linked Discord account)`);
    }

    await sendEmbed('OPS', {
        title: '📬 Dropped Off Summary',
        description: opsLines.join('\n'),
        color: 0xceff00,
    });

    // Confirm in the command channel
    const totalOrders = unshipped.length + skipped.length;
    await message.channel.send({ embeds: [new EmbedBuilder()
        .setTitle('📬 Dropped Off Complete')
        .setDescription(`**${dmsSent}** buyer${dmsSent !== 1 ? 's' : ''} notified, **${totalOrders}** order${totalOrders !== 1 ? 's' : ''} marked as shipped.`)
        .setColor(0xceff00)] });
}

export { handleDroppedOff };
