/**
 * Livestream Master Commands
 *
 * !live    — Go live: open queue, start livestream session, post shop link
 * !offline — End stream: close queue, archive, open next queue, post recap
 *
 * Shipping is handled proactively at checkout via email capture — no
 * deferred shipping or DMs needed. These commands manage session tracking,
 * queue lifecycle, and analytics.
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import config from '../config.js';
import { livestream, analytics, goals } from '../db.js';
import * as queueSource from '../lib/queue-source.js';
import { sendEmbed, sendToChannel, getGuild } from '../discord.js';
import { postQueueChannelEmbed, updateQueueChannelEmbed } from './queue.js';
import { settleSpeculativeBuyers, postOpsScanSummary } from '../lib/speculative-shipping.js';

// =========================================================================
// !live
// =========================================================================

async function handleLive(message) {
    const isAdmin = message.member.roles.cache.has(config.ROLES.NANOOK)
        || message.member.roles.cache.has(config.ROLES.AKIVILI);

    if (!isAdmin) {
        return message.reply('Only moderators can use this command.');
    }

    // Check if already live
    const active = livestream.getActiveSession.get();
    if (active) {
        return message.reply('Already live! Use `!offline` to end the current session first.');
    }

    // Start 4-hour reminder
    startReminder();

    // Auto-open queue if none exists (first stream or manual close)
    let activeQueue = await queueSource.getActiveQueue();
    if (!activeQueue) {
        const queueResult = await queueSource.createQueue();
        activeQueue = queueResult.session ?? (await queueSource.getActiveQueue());
        await postQueueChannelEmbed(activeQueue);
        await message.channel.send({ embeds: [new EmbedBuilder()
            .setDescription(`📋 No queue was open — auto-opened queue #${activeQueue.id}`)
            .setColor(0x3498db)] });
    }

    // Post pre-order summary if queue has entries (but keep it open)
    if (activeQueue) {
        const entries = await queueSource.getEntries(activeQueue.id);
        const uniqueBuyers = await queueSource.getUniqueBuyers(activeQueue.id);

        if (entries.length > 0) {
            await sendEmbed('ANNOUNCEMENTS', {
                title: `📋 ${entries.length} Pre-Orders Tonight!`,
                description: `${uniqueBuyers.length} buyer(s) already in the queue. Let's go!`,
                color: 0xceff00,
            });
        }
    }

    // Start livestream session
    const result = livestream.startSession.run();
    const sessionId = result.lastInsertRowid;

    const shopLink = config.SHOP_URL;

    // Post going-live announcement
    const embed = new EmbedBuilder()
        .setTitle('🔴 We\'re Live!')
        .setDescription(
            `Card night is starting! Come hang.\n\n` +
            `Watch on: [Twitch](https://twitch.tv/itzenzoTTV) · [TikTok](https://tiktok.com/@itzenzoTTV) · [Instagram](https://instagram.com/itzenzo.TTV) · [YouTube](https://youtube.com/@itzenzoTTV)`
        )
        .setColor(0xceff00);

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('🛒 Shop Now')
            .setStyle(ButtonStyle.Link)
            .setURL(shopLink),
    );

    await sendToChannel('ANNOUNCEMENTS', { embeds: [embed], components: [buttons] });

    // Confirm in current channel
    const confirmEmbed = new EmbedBuilder()
        .setTitle('🔴 Live Session Started')
        .setDescription(
            `**Session #${sessionId}**\n\n` +
            `• Queue${activeQueue ? ` #${activeQueue.id}` : ''} stays open — orders continue adding\n` +
            `• Shipping is handled at checkout — no post-stream DMs needed`
        )
        .addFields({ name: 'Shop Link', value: shopLink })
        .setColor(0x9146ff);

    await message.channel.send({ embeds: [confirmEmbed] });
}

// =========================================================================
// !offline
// =========================================================================

async function handleOffline(message) {
    const isAdmin = message.member.roles.cache.has(config.ROLES.NANOOK)
        || message.member.roles.cache.has(config.ROLES.AKIVILI);

    if (!isAdmin) {
        return message.reply('Only moderators can use this command.');
    }

    const session = livestream.getActiveSession.get();
    if (!session) {
        return message.reply('No active livestream session. Use `!live` to start one.');
    }

    // End the session
    livestream.endSession.run(session.id);

    // Cancel the reminder
    cancelReminder();

    // Find the most recently completed queue for the recap
    const recentQueues = await queueSource.getRecentQueues(1);
    const closedQueueId = recentQueues.length ? recentQueues[0].id : null;

    // Ensure a queue is open for next stream's pre-orders
    let activeQueue = await queueSource.getActiveQueue();
    if (!activeQueue) {
        const queueResult = await queueSource.createQueue();
        activeQueue = queueResult.session ?? (await queueSource.getQueueById(queueResult.lastInsertRowid));
        await postQueueChannelEmbed(activeQueue);
    }

    // Post stream-ended recap
    await sendEmbed('ANNOUNCEMENTS', {
        title: '📴 Stream\'s Over!',
        description: 'Thanks for hanging out! Clips and highlights coming soon.\n\nPre-order queue is open for next stream.',
        color: 0x95a5a6,
    });

    // Post analytics recap to #analytics
    await postStreamRecap(session, closedQueueId);

    // Speculative-shipping settlement: scan for buyers with held items
    // (pulls/packs/pack-battle entries) and no shipping payment for the
    // current period; DM linked-Discord ones a Stripe shipping checkout
    // link, list unlinked ones in #ops for manual follow-up. Dedup is
    // built into the query — only buyers with a fresh speculative
    // purchase since their last DM are eligible.
    let scanSummary = null;
    try {
        scanSummary = await settleSpeculativeBuyers();
        await postOpsScanSummary(scanSummary);
    } catch (e) {
        console.error('Speculative-shipping settlement failed:', e.message);
    }

    // Confirm in current channel
    const offlineEmbed = new EmbedBuilder()
        .setTitle('📴 Live Session Ended')
        .setDescription(`**Session #${session.id}**`)
        .addFields(
            { name: 'Queue', value: `#${activeQueue.id} open for pre-orders`, inline: false },
        )
        .setColor(0x95a5a6)
        .setFooter({ text: 'Stream recap posted to #analytics' });

    if (scanSummary) {
        offlineEmbed.addFields({
            name: 'Held-shipping DM scan',
            value: `📨 ${scanSummary.dmed.length} DM'd · 🔗 ${scanSummary.unlinked.length} unlinked${scanSummary.errors.length ? ` · ⚠️ ${scanSummary.errors.length} errors` : ''}`,
            inline: false,
        });
    }

    await message.channel.send({ embeds: [offlineEmbed] });
}

// =========================================================================
// Post-stream analytics recap — posted to #analytics after !offline
// =========================================================================

function formatDollars(cents) {
    return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function postStreamRecap(session, closedQueueId) {
    // ↓ marked async so the queue lookups can await queueSource (WP REST when flag flipped)
    const startTime = session.created_at;
    const endTime = new Date().toISOString();

    // Session stats
    const stats = analytics.getRangeStats.get(startTime, endTime);
    const topProducts = analytics.getTopProducts.all(startTime, endTime);
    const newBuyers = analytics.getNewBuyerCount.get(startTime, endTime, startTime);
    const battleCount = analytics.getBattleCount.get(startTime, endTime);
    const shippingStats = analytics.getShippingStats.get(startTime, endTime);
    const cardSaleCount = analytics.getCardSaleCount.get(startTime, endTime);

    // Queue stats
    let queueEntryCount = 0;
    let queueBuyerCount = 0;
    if (closedQueueId) {
        const entries = await queueSource.getEntries(closedQueueId);
        const uniqueBuyers = await queueSource.getUniqueBuyers(closedQueueId);
        queueEntryCount = entries.length;
        queueBuyerCount = uniqueBuyers.length;
    }

    // Community goal delta
    const goal = goals.get.get();
    const productRevenue = stats.total_revenue - shippingStats.total_shipping;
    const avgOrderValue = stats.order_count > 0 ? Math.round(stats.total_revenue / stats.order_count) : 0;

    // Stream duration
    const durationMs = new Date(endTime) - new Date(startTime);
    const hours = Math.floor(durationMs / 3600000);
    const minutes = Math.floor((durationMs % 3600000) / 60000);
    const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    // Build embed
    const returningBuyers = stats.unique_buyers - newBuyers.count;
    const lines = [
        `**Product Revenue:** ${formatDollars(productRevenue)}`,
        `**Shipping Collected:** ${formatDollars(shippingStats.total_shipping)} (${shippingStats.shipping_count} payments)`,
        `**Total Revenue:** ${formatDollars(stats.total_revenue)}`,
        '',
        `**Orders:** ${stats.order_count} (avg ${formatDollars(avgOrderValue)})`,
        `**Buyers:** ${stats.unique_buyers} (${newBuyers.count} new, ${returningBuyers} returning)`,
    ];

    if (battleCount.count > 0) {
        lines.push(`**Battles:** ${battleCount.count}`);
    }

    if (cardSaleCount.count > 0) {
        lines.push(`**Card Sales:** ${cardSaleCount.count}`);
    }

    if (queueEntryCount > 0) {
        lines.push(`**Queue:** ${queueEntryCount} items from ${queueBuyerCount} buyers`);
    }

    lines.push(`**Duration:** ${duration}`);

    const embed = new EmbedBuilder()
        .setTitle(`📊 Stream Recap — Session #${session.id}`)
        .setDescription(lines.join('\n'))
        .setColor(0xceff00);

    // Top products
    if (topProducts.length > 0) {
        const productLines = topProducts.map((p, i) =>
            `${i + 1}. **${p.product_name}** — ${p.count} sold (${formatDollars(p.revenue)})`
        );
        embed.addFields({ name: 'Top Products', value: productLines.join('\n') });
    }

    // Community goal state
    const cyclePercent = Math.min(Math.round((goal.cycle_revenue / 250000) * 100), 100);
    const goalLine = `Cycle #${goal.cycle} — ${cyclePercent}% (${formatDollars(goal.cycle_revenue)} / $2,500.00)`;
    embed.addFields({ name: 'Community Goal', value: `${goalLine}\n+${formatDollars(productRevenue)} this stream` });

    embed.setFooter({ text: `${session.created_at} → ${new Date().toLocaleTimeString('en-US')}` });

    try {
        await sendToChannel('ANALYTICS', { embeds: [embed] });
    } catch (e) {
        console.error('Failed to post stream recap:', e.message);
    }
}

// =========================================================================
// Reminder timer — DMs you after 4 hours if !offline hasn't been run
// =========================================================================

let reminderTimer = null;
const REMINDER_MS = 4 * 60 * 60 * 1000; // 4 hours

function startReminder() {
    cancelReminder();
    reminderTimer = setTimeout(async () => {
        const session = livestream.getActiveSession.get();
        if (!session) return;

        try {
            const guild = getGuild();
            if (!guild) return;
            const owner = await guild.members.fetch(guild.ownerId);
            if (owner) {
                const dm = await owner.createDM();
                await dm.send(
                    `⏰ **Reminder:** Your livestream session (#${session.id}) has been active for 4+ hours. ` +
                    `Don't forget to run \`!offline\` when you're done.`
                );
                console.log('Sent 4-hour livestream reminder to owner');
            }
        } catch (e) {
            console.error('Failed to send livestream reminder:', e.message);
        }
    }, REMINDER_MS);
}

function cancelReminder() {
    if (reminderTimer) {
        clearTimeout(reminderTimer);
        reminderTimer = null;
    }
}

/**
 * Check if there's an active livestream session.
 */
function isLive() {
    return !!livestream.getActiveSession.get();
}

export { handleLive, handleOffline, isLive };
