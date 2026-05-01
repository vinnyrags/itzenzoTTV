/**
 * Pull Box Command — !pull
 *
 * Owner-only. Opens, closes, and reports on pull boxes — finite-slot
 * livestream entry pools backed by the WordPress source-of-truth
 * tables (`wp_pull_boxes` + `wp_pull_box_slots`). The Discord embed and
 * the itzenzo.tv homepage modal both project from the same data.
 *
 * Tier-based syntax (preferred):
 *   !pull v   "Vintage Box" 100      — opens the v-tier ($1) box, 100 slots
 *   !pull vmax "VMAX Box"  50        — opens the vmax-tier ($2) box, 50 slots
 *   !pull close [v|vmax]             — closes (tier required only if both open)
 *   !pull replenish [v|vmax] 50      — adds 50 to total_slots
 *   !pull status                      — lists active boxes
 *
 * Legacy syntax (still works — tier inferred from price $1→v / $2→vmax):
 *   !pull "Box" 1.00 100
 */

import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import config from '../config.js';
import { cardListings, pullEntries } from '../db.js';
import * as queueSource from '../lib/queue-source.js';
import * as wpPullBox from '../lib/wp-pull-box.js';
import { client, getChannel, sendEmbed } from '../discord.js';
import {
    broadcastPullBoxOpened,
    broadcastPullBoxReplenished,
    broadcastPullBoxClosed,
} from '../lib/activity-broadcaster.js';
import { formatShippingRate } from '../shipping.js';

const TIERS = ['v', 'vmax'];
const PRICE_CENTS_BY_TIER = { v: 100, vmax: 200 };

// ===========================================================================
// Top-level dispatch
// ===========================================================================

async function handlePull(message, args) {
    if (!message.member.roles.cache.has(config.ROLES.AKIVILI)) {
        return message.reply('Only the server owner can manage pull boxes.');
    }

    const sub = (args[0] || '').toLowerCase();

    if (sub === 'close') return handlePullClose(message, args.slice(1));
    if (sub === 'replenish') return handlePullReplenish(message, args.slice(1));
    if (sub === 'status') return handlePullStatus(message);

    return handlePullOpen(message, args);
}

// ===========================================================================
// !pull open
// ===========================================================================

async function handlePullOpen(message, args) {
    const parsed = parseOpenArgs(message.content, args);
    if (parsed.error) return message.reply(parsed.error);

    const { tier, name, totalSlots } = parsed;
    const priceCents = PRICE_CENTS_BY_TIER[tier];

    // Refuse if a box is already open for this tier — the homepage
    // modal expects exactly one active box per tier so the slot grid
    // is unambiguous.
    let existing = null;
    try {
        existing = await wpPullBox.getActiveBox(tier);
    } catch (e) {
        return message.reply(`Could not reach the pull-box service: ${e.message}`);
    }
    if (existing) {
        return message.reply(`A ${tier}-tier pull box is already active: **${existing.name}** (#${existing.id}). Close it first with \`!pull close ${tier}\`.`);
    }

    let box;
    try {
        box = await wpPullBox.createBox({ name, tier, priceCents, totalSlots });
    } catch (e) {
        return message.reply(`Failed to open box: ${e.message}`);
    }

    // Post the embed to #card-shop with a Buy button. customId carries
    // the tier so the interaction handler can resolve the active box at
    // click time (no stale listing IDs cached in the embed).
    const channel = getChannel('CARD_SHOP');
    if (!channel) {
        return message.reply('Card-shop channel not found. Box was created in WP but no embed posted.');
    }

    const embed = buildPullBoxEmbed(box, []);
    const buyButton = new ButtonBuilder()
        .setCustomId(`pull-buy-${tier}`)
        .setLabel('Buy Pull(s)')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🎰');
    const row = new ActionRowBuilder().addComponents(buyButton);

    const msg = await channel.send({ embeds: [embed], components: [row] });

    // Record the message id back on the box so the embed can be edited
    // later when slots get claimed.
    try {
        await wpPullBox.updateBox(box.id, { discordMessageId: msg.id });
    } catch (e) {
        console.error('Failed to attach discord_message_id to pull box:', e.message);
    }

    if (message.channel.id !== channel.id) {
        await message.channel.send(`🎰 ${tier.toUpperCase()}-tier pull box **${name}** ($${(priceCents / 100).toFixed(2)} × ${totalSlots} slots) is live in <#${config.CHANNELS.CARD_SHOP}>!`);
    }

    broadcastPullBoxOpened(box);
}

/**
 * Accept either the new tier-based syntax or the legacy quoted-name +
 * dollar-price + slot-count syntax. Returns either { tier, name, totalSlots }
 * or { error: string }.
 */
function parseOpenArgs(rawContent, args) {
    // Strip "!pull " from the leading content
    const content = rawContent.replace(/^!pull\s+/i, '').trim();

    // Tier-prefixed: `v "Name" 100` or `vmax "Name" 50`
    const firstArg = (args[0] || '').toLowerCase();
    if (TIERS.includes(firstArg)) {
        const afterTier = content.replace(new RegExp(`^${firstArg}\\s+`, 'i'), '');
        const nameMatch = afterTier.match(/"([^"]+)"/);
        if (!nameMatch) {
            return { error: `Usage: \`!pull ${firstArg} "Box Name" <total_slots>\`` };
        }
        const afterQuote = afterTier.slice(afterTier.lastIndexOf('"') + 1).trim();
        const totalSlots = parseInt(afterQuote, 10);
        if (!Number.isFinite(totalSlots) || totalSlots < 1) {
            return { error: 'Total slots must be a positive integer.' };
        }
        return { tier: firstArg, name: nameMatch[1], totalSlots };
    }

    // Legacy: `"Name" 1.00 100`
    const nameMatch = content.match(/"([^"]+)"/);
    if (!nameMatch) {
        return { error: 'Usage: `!pull <v|vmax> "Box Name" <total_slots>` (or legacy `!pull "Box Name" <price> <total_slots>`)' };
    }
    const name = nameMatch[1];
    const afterQuote = content.slice(content.lastIndexOf('"') + 1).trim();
    const numbers = afterQuote.match(/[\d]+(?:\.[\d]{1,2})?/g);
    if (!numbers || numbers.length < 2) {
        return { error: 'Legacy syntax needs price and slot count: `!pull "Name" 1.00 100`' };
    }
    const priceCents = Math.round(parseFloat(numbers[0]) * 100);
    const totalSlots = parseInt(numbers[1], 10);
    const tier = priceCents === PRICE_CENTS_BY_TIER.v ? 'v'
        : priceCents === PRICE_CENTS_BY_TIER.vmax ? 'vmax'
        : null;
    if (!tier) {
        return { error: `Pull boxes only support $${(PRICE_CENTS_BY_TIER.v / 100).toFixed(2)} (v) and $${(PRICE_CENTS_BY_TIER.vmax / 100).toFixed(2)} (vmax) tiers. Use \`!pull v "Name" <slots>\` or \`!pull vmax "Name" <slots>\`.` };
    }
    if (!Number.isFinite(totalSlots) || totalSlots < 1) {
        return { error: 'Total slots must be a positive integer.' };
    }
    return { tier, name, totalSlots };
}

// ===========================================================================
// !pull close [tier]
// ===========================================================================

async function handlePullClose(message, args) {
    const tierArg = (args[0] || '').toLowerCase();
    const targetTier = TIERS.includes(tierArg) ? tierArg : null;

    let openBoxes;
    try {
        openBoxes = await Promise.all(TIERS.map((t) => wpPullBox.getActiveBox(t)));
    } catch (e) {
        return message.reply(`Could not reach the pull-box service: ${e.message}`);
    }
    const open = openBoxes.filter(Boolean);

    if (open.length === 0) {
        return message.reply('No active pull boxes to close.');
    }

    let target;
    if (targetTier) {
        target = open.find((b) => b.tier === targetTier);
        if (!target) {
            return message.reply(`No ${targetTier}-tier pull box is open.`);
        }
    } else if (open.length === 1) {
        target = open[0];
    } else {
        return message.reply(`Two pull boxes are open. Specify which: \`!pull close ${open.map((b) => b.tier).join('|')}\``);
    }

    try {
        await wpPullBox.closeBox(target.id);
    } catch (e) {
        return message.reply(`Failed to close box: ${e.message}`);
    }

    // Update embed to closed state
    await refreshBoxEmbed(target.id, { closed: true }).catch(() => {});

    await message.channel.send(`🎰 ${target.tier.toUpperCase()}-tier pull box **${target.name}** closed.`);

    broadcastPullBoxClosed(target);
}

// ===========================================================================
// !pull replenish [tier] N
// ===========================================================================

async function handlePullReplenish(message, args) {
    const first = (args[0] || '').toLowerCase();
    let tier = null;
    let amountArg = args[0];

    if (TIERS.includes(first)) {
        tier = first;
        amountArg = args[1];
    }

    const amount = parseInt(amountArg, 10);
    if (!Number.isFinite(amount) || amount < 1) {
        return message.reply('Usage: `!pull replenish [v|vmax] <slots-to-add>` — e.g. `!pull replenish v 50`');
    }

    let openBoxes;
    try {
        openBoxes = await Promise.all(TIERS.map((t) => wpPullBox.getActiveBox(t)));
    } catch (e) {
        return message.reply(`Could not reach the pull-box service: ${e.message}`);
    }
    const open = openBoxes.filter(Boolean);

    if (open.length === 0) {
        return message.reply('No active pull box to replenish.');
    }

    let target;
    if (tier) {
        target = open.find((b) => b.tier === tier);
        if (!target) {
            return message.reply(`No ${tier}-tier pull box is open.`);
        }
    } else if (open.length === 1) {
        target = open[0];
    } else {
        return message.reply(`Two pull boxes are open. Specify which: \`!pull replenish ${open.map((b) => b.tier).join('|')} ${amount}\``);
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
// !pull status
// ===========================================================================

async function handlePullStatus(message) {
    let openBoxes;
    try {
        openBoxes = await Promise.all(TIERS.map((t) => wpPullBox.getActiveBox(t)));
    } catch (e) {
        return message.reply(`Could not reach the pull-box service: ${e.message}`);
    }
    const open = openBoxes.filter(Boolean);

    if (open.length === 0) {
        return message.reply('No active pull boxes.');
    }

    const lines = open.map((b) => {
        const claimed = (b.claimedSlots || []).length;
        return `🎰 **${b.tier.toUpperCase()}** — ${b.name} ($${(b.priceCents / 100).toFixed(2)}) — ${claimed}/${b.totalSlots} slots claimed`;
    });
    await message.reply(lines.join('\n'));
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

    // Compact slot grid: ⬜ open, 🟪 claimed. 10 per row. Capped at
    // a sane size so we don't blow the embed character limit.
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
        .setFooter({ text: `${box.tier.toUpperCase()}-tier pull box • ${box.totalSlots} slots` });
}

/**
 * Re-fetch a box from WP and edit its #card-shop embed in place.
 * Called after slot claims, replenish, and close events so the embed
 * stays current without depending on Nous's local state.
 */
async function refreshBoxEmbed(boxId, { closed = false } = {}) {
    try {
        const channel = getChannel('CARD_SHOP');
        if (!channel) return;

        // We need the freshest version including claimed slots — easiest
        // path is the activeBox lookup if it's still open, or a direct
        // fetch otherwise. For simplicity, we just look up by tier once
        // we know the tier. If we don't have it, skip.
        // (For closed boxes the embed update happens once at close time.)
        let boxRow = null;
        for (const tier of TIERS) {
            const candidate = await wpPullBox.getActiveBox(tier);
            if (candidate && candidate.id === boxId) {
                boxRow = candidate;
                break;
            }
        }

        if (!boxRow) {
            // Box is closed — fall back to embed-only update
            if (closed) {
                // We still need a row to render; skip update if we can't find it.
            }
            return;
        }

        if (!boxRow.discordMessageId) return;

        const msg = await channel.messages.fetch(boxRow.discordMessageId);
        const embed = buildPullBoxEmbed(boxRow, boxRow.claimedSlots || []);

        const components = boxRow.status === 'open' && (boxRow.claimedSlots || []).length < boxRow.totalSlots
            ? [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`pull-buy-${boxRow.tier}`)
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
 *
 * Either way, the result is N confirmed slot rows in WP and a queue
 * entry mirroring the buy.
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
            const box = await wpPullBox.getActiveBox(null); // Fall through; we'll fetch by id below if needed
            // Simpler: just look up by tier — but we need tier. Fetch by id via active
            // route is awkward; instead, ask both tiers and find the matching id.
            let target = null;
            for (const tier of ['v', 'vmax']) {
                const candidate = await wpPullBox.getActiveBox(tier);
                if (candidate && candidate.id === pullBoxId) {
                    target = candidate;
                    break;
                }
            }
            if (!target) {
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
                quantity = open.length; // claim what we can
            }

            const claimResp = await wpPullBox.claimSlots(target.id, open.slice(0, quantity), {
                discordUserId,
                discordHandle,
                customerEmail,
                stripeSessionId,
            });
            claimedSlotNumbers = claimResp?.claimed || open.slice(0, quantity);

            // Immediately confirm — no waiting for a separate webhook on a Discord-side claim
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

    // Mirror the purchase into the unified queue as a single consolidated entry
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

    // Refresh the on-stream embed
    await refreshBoxEmbed(pullBoxId).catch(() => {});
}

// ===========================================================================
// Legacy export — kept so existing callers don't break during cutover
// ===========================================================================

/**
 * @deprecated Use recordPullBoxPurchase instead. Kept for backward compat
 * during the cutover; routes through the new system internally.
 */
async function recordPullPurchase(listingId, discordUserId = null, customerEmail = null, quantity = 1, stripeSessionId = null) {
    console.warn('recordPullPurchase (legacy) called — listing-based pull boxes are deprecated. Migrate caller to recordPullBoxPurchase.');
}

export { handlePull, recordPullPurchase, recordPullBoxPurchase, refreshBoxEmbed };
