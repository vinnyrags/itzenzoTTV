/**
 * Pull Box Command — /pull
 *
 * Owner-only. The pull box is perpetual — it always exists, auto-created
 * from settings (`pb_price_id`, `pb_total_slots`) the first time the
 * homepage modal hits `/shop/v1/pull-boxes/active`. The operator never
 * has to "open" a box; they just manage two events:
 *
 *   /pull reset             — chase prize hit, close the current box and
 *                              open a fresh one with the configured slot count
 *   /pull replenish <N>     — add N slots to the active box without resetting
 *                              (for the rare "running low, no chase yet" case)
 *
 * Manual slot creation, naming, and per-stream lifecycle are gone — the
 * homepage Buy button + Discord persistent embed both stay live always.
 */

import { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import config from '../config.js';
import * as queueSource from '../lib/queue-source.js';
import * as wpPullBox from '../lib/wp-pull-box.js';
import { getChannel, sendEmbed } from '../discord.js';
import {
    broadcastPullBoxOpened,
    broadcastPullBoxReplenished,
    broadcastPullBoxClosed,
} from '../lib/activity-broadcaster.js';
import { formatShippingRate } from '../shipping.js';

// ===========================================================================
// Top-level dispatch
// ===========================================================================

async function handlePull(message, args) {
    if (!message.member.roles.cache.has(config.ROLES.AKIVILI)) {
        return message.reply('Only the server owner can manage pull boxes.');
    }

    const sub = (args[0] || '').toLowerCase();

    if (sub === 'reset') return handlePullReset(message);
    if (sub === 'replenish') return handlePullReplenish(message, args.slice(1));

    return message.reply('Usage: `/pull reset` (chase hit, start fresh batch) or `/pull replenish <slots>` (top up the active box).');
}

// ===========================================================================
// /pull reset — close current + open new
// ===========================================================================

async function handlePullReset(message) {
    let result;
    try {
        const res = await fetch(`${config.SITE_URL}/wp-json/shop/v1/pull-boxes/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': config.LIVESTREAM_SECRET },
        });
        const data = await res.json();
        if (!res.ok) {
            return message.reply(`Failed to reset: ${data.message || data.code || res.statusText}`);
        }
        result = data.box;
    } catch (e) {
        return message.reply(`Could not reach the pull-box service: ${e.message}`);
    }

    // Post a fresh embed for the new box
    const channel = getChannel('CARD_SHOP');
    if (channel && result) {
        const embed = buildPullBoxEmbed(result, []);
        const buyButton = new ButtonBuilder()
            .setCustomId('pull-buy')
            .setLabel('Buy Pull(s)')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🎰');
        const row = new ActionRowBuilder().addComponents(buyButton);

        const msg = await channel.send({ embeds: [embed], components: [row] });
        try {
            await wpPullBox.updateBox(result.id, { discordMessageId: msg.id });
        } catch (e) {
            console.error('Failed to attach discord_message_id to reset pull box:', e.message);
        }
    }

    if (message.channel.id !== (channel?.id || '')) {
        await message.channel.send(`🎰 Pull box reset — fresh box **#${result.id}** with ${result.totalSlots} slots is live in <#${config.CHANNELS.CARD_SHOP}>!`);
    }

    broadcastPullBoxOpened(result);
}

// ===========================================================================
// /pull replenish N
// ===========================================================================

async function handlePullReplenish(message, args) {
    const amount = parseInt(args[0], 10);
    if (!Number.isFinite(amount) || amount < 1) {
        return message.reply('Usage: `/pull replenish <slots-to-add>` — e.g. `/pull replenish 25`');
    }

    let target;
    try {
        target = await wpPullBox.getActiveBox();
    } catch (e) {
        return message.reply(`Could not reach the pull-box service: ${e.message}`);
    }

    if (!target) {
        return message.reply('No active pull box to replenish. Run `/pull reset` to start a fresh one.');
    }

    const newTotal = target.totalSlots + amount;
    try {
        await wpPullBox.replenishBox(target.id, newTotal);
    } catch (e) {
        return message.reply(`Failed to replenish: ${e.message}`);
    }

    await refreshBoxEmbed(target.id).catch(() => {});

    await message.channel.send(`📈 Added ${amount} slots to **${target.name}** (${target.totalSlots} → ${newTotal}).`);

    broadcastPullBoxReplenished(target, amount, newTotal);
}

// ===========================================================================
// Embed
// ===========================================================================

function buildPullBoxEmbed(box, claimedSlots) {
    const claimedNumbers = new Set(claimedSlots.map((c) => c.slotNumber));
    const remaining = box.totalSlots - claimedNumbers.size;
    const isFull = remaining <= 0;
    const isClosed = box.status === 'closed';

    const priceLabel = `$${(box.priceCents / 100).toFixed(2)}`;
    const lines = [];

    if (isClosed) {
        lines.push(`~~${priceLabel}~~ — **CLOSED**`);
    } else if (isFull) {
        lines.push(`~~${priceLabel}~~ — **SOLD OUT**`);
    } else {
        lines.push(`**${priceLabel}** per pull — click Buy Pull(s) to check out`);
    }

    lines.push(`📦 **${claimedNumbers.size}/${box.totalSlots}** slots claimed${remaining > 0 && !isClosed ? ` — ${remaining} remaining` : ''}`);

    if (box.totalSlots <= 200) {
        const rows = [];
        for (let i = 1; i <= box.totalSlots; i += 10) {
            const cells = [];
            for (let j = 0; j < 10 && (i + j) <= box.totalSlots; j++) {
                cells.push(claimedNumbers.has(i + j) ? '🟪' : '⬜');
            }
            rows.push(cells.join(''));
        }
        lines.push('', rows.join('\n'));
    }

    if (claimedSlots.length > 0) {
        const buyerLines = claimedSlots
            .slice()
            .sort((a, b) => a.slotNumber - b.slotNumber)
            .map((c) => `#${c.slotNumber} — ${c.displayLabel}`);
        lines.push('', buyerLines.join('\n'));
    }

    lines.push('', `*Shipping: ${formatShippingRate(config.SHIPPING.DOMESTIC)} US / ${formatShippingRate(config.SHIPPING.INTERNATIONAL)} International (waived if already covered this week/month)*`);

    return new EmbedBuilder()
        .setTitle(`🎰 ${box.name}`)
        .setDescription(lines.join('\n'))
        .setColor(isClosed ? 0x95a5a6 : isFull ? 0xe74c3c : 0x9b59b6)
        .setFooter({ text: `Pull box • ${box.totalSlots} slots` });
}

/**
 * Re-fetch the active box from WP and edit its #card-shop embed in
 * place. Called after slot claims and replenish so the embed stays
 * current without depending on Nous's local state.
 */
async function refreshBoxEmbed(boxId) {
    try {
        const channel = getChannel('CARD_SHOP');
        if (!channel) return;

        const boxRow = await wpPullBox.getActiveBox();
        if (!boxRow || boxRow.id !== boxId) {
            return;
        }

        if (!boxRow.discordMessageId) return;

        const msg = await channel.messages.fetch(boxRow.discordMessageId);
        const embed = buildPullBoxEmbed(boxRow, boxRow.claimedSlots || []);

        const components = boxRow.status === 'open' && (boxRow.claimedSlots || []).length < boxRow.totalSlots
            ? [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('pull-buy')
                        .setLabel('Buy Pull(s)')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🎰'),
                ),
            ]
            : [];

        await msg.edit({ embeds: [embed], components });
    } catch (e) {
        console.error('Failed to refresh pull box embed:', e.message);
    }
}

// ===========================================================================
// Stripe webhook entry point — claim slots after payment success
// ===========================================================================

/**
 * Called by the Stripe webhook handler when a `pull_box`-sourced
 * checkout completes. Two flows merge here:
 *
 *   1. Homepage flow: WP already pre-claimed slots at checkout-create
 *      time (rows in pending status). We confirm those rows by
 *      stripe_session_id.
 *   2. Discord flow: no pre-claim. We auto-pick the lowest-numbered
 *      open slots, claim atomically, then immediately confirm.
 */
async function recordPullBoxPurchase({
    stripeSessionId,
    pullBoxId,
    explicitSlots = null,
    quantity = 1,
    discordUserId = null,
    discordHandle = null,
    customerEmail = null,
}) {
    let claimedSlotNumbers = [];

    if (Array.isArray(explicitSlots) && explicitSlots.length > 0) {
        // Homepage path — pre-claim already happened. Just confirm.
        await fetch(`${config.SITE_URL}/wp-json/shop/v1/pull-boxes/${pullBoxId}/confirm-by-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': config.LIVESTREAM_SECRET },
            body: JSON.stringify({ stripe_session_id: stripeSessionId }),
        }).catch((e) => console.error('confirm-by-session failed:', e.message));
        claimedSlotNumbers = explicitSlots.slice();
    } else {
        // Discord path — auto-pick lowest open slots and claim them.
        try {
            const target = await wpPullBox.getActiveBox();
            if (!target || target.id !== pullBoxId) {
                console.error(`Pull box #${pullBoxId} no longer active — Discord buyer ${discordUserId || customerEmail} payment landed but no claim made`);
                await sendEmbed('OPS', {
                    title: '⚠️ Pull Box Closed Mid-Payment',
                    description: `Box #${pullBoxId} closed before this Discord buyer's webhook landed. Payment went through; manual claim or refund needed.`,
                    color: 0xff0000,
                });
                return;
            }

            const claimed = new Set((target.claimedSlots || []).map((c) => c.slotNumber));
            const open = [];
            for (let n = 1; n <= target.totalSlots && open.length < quantity; n++) {
                if (!claimed.has(n)) open.push(n);
            }

            if (open.length < quantity) {
                console.error(`Pull box #${pullBoxId} only had ${open.length} open slots but Discord buyer requested ${quantity}`);
                await sendEmbed('OPS', {
                    title: '⚠️ Pull Box Oversold',
                    description: `Box #${pullBoxId} oversold — only ${open.length} open slots but a Discord buyer paid for ${quantity}. Manual refund/claim needed.`,
                    color: 0xff0000,
                });
                quantity = open.length;
            }

            const claimResp = await wpPullBox.claimSlots(target.id, open.slice(0, quantity), {
                discordUserId,
                discordHandle,
                customerEmail,
                stripeSessionId,
            });
            claimedSlotNumbers = claimResp?.claimed || open.slice(0, quantity);

            await fetch(`${config.SITE_URL}/wp-json/shop/v1/pull-boxes/${target.id}/confirm-by-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': config.LIVESTREAM_SECRET },
                body: JSON.stringify({ stripe_session_id: stripeSessionId }),
            }).catch((e) => console.error('confirm-by-session failed:', e.message));
        } catch (e) {
            console.error('Discord auto-claim failed:', e.message);
            return;
        }
    }

    try {
        const activeQueue = await queueSource.getActiveQueue();
        if (activeQueue) {
            const result = await queueSource.addEntry({
                queueId: activeQueue.id,
                discordUserId,
                discordHandle,
                customerEmail,
                productName: `Pull Box (${claimedSlotNumbers.length} slot${claimedSlotNumbers.length === 1 ? '' : 's'})`,
                quantity: claimedSlotNumbers.length,
                stripeSessionId,
                type: 'pull_box',
                source: discordUserId ? 'discord' : 'shop',
                externalRef: `stripe:${stripeSessionId}:pull`,
                detailLabel: `Pull Box • slots ${claimedSlotNumbers.join(', ')}`,
                detailData: {
                    pullBoxId,
                    slots: claimedSlotNumbers,
                },
            });
            if (result?.closedSession) {
                await sendEmbed('OPS', {
                    title: '⚠️ Closed-Session Race — Pull Box',
                    description: [
                        `**Buyer:** ${discordUserId ? `<@${discordUserId}>` : (customerEmail || 'unknown')}`,
                        `**Pull box:** ${pullBoxId} (slots ${claimedSlotNumbers.join(', ')})`,
                        `**Stripe session:** \`${stripeSessionId}\``,
                        '',
                        'Pull-box buy was paid but the queue session was closed before the queue mirror could land. Slot rows are confirmed; manual queue insert if needed.',
                    ].join('\n'),
                    color: 0xe67e22,
                });
            }
        }
    } catch (e) {
        console.error('Failed to mirror pull-box buy to queue:', e.message);
    }

    await refreshBoxEmbed(pullBoxId).catch(() => {});
}

// ===========================================================================
// Legacy export — kept so existing callers don't break during cutover
// ===========================================================================

/**
 * @deprecated Use recordPullBoxPurchase instead.
 */
async function recordPullPurchase(_listingId, _discordUserId = null, _customerEmail = null, _quantity = 1, _stripeSessionId = null) {
    console.warn('recordPullPurchase (legacy) called — listing-based pull boxes are deprecated. Migrate caller to recordPullBoxPurchase.');
}

// Avoid unused-import warning — broadcastPullBoxClosed is wired up via the
// reset endpoint's WP-side hook (`shop_pull_box_closed` action) which posts
// to the activity feed bridge. Re-imported here for completeness so future
// callers can wire it back into a /pull command if needed.
void broadcastPullBoxClosed;

export { handlePull, recordPullPurchase, recordPullBoxPurchase, refreshBoxEmbed };
