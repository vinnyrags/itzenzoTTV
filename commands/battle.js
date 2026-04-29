/**
 * Pack Battle System
 *
 * Commands:
 *   !battle start <product-slug> [max-entries] — Start a new pack battle
 *   !battle close — Close entries, show final roster
 *   !battle cancel — Cancel the active battle
 *   !battle winner @user — Declare winner, assign Aha role
 *   !battle status — Show current battle status
 *
 * Viewers join by reacting to the battle message.
 * Payment is verified via Stripe webhook.
 */

import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import Stripe from 'stripe';
import config from '../config.js';
import { db, battles, purchases } from '../db.js';
import { client, getChannel, sendToChannel, sendEmbed, getMember, addRole, getGuild } from '../discord.js';
import {
    broadcastBattleEntry,
    broadcastBattleFull,
    broadcastBattleWinner,
} from '../lib/activity-broadcaster.js';
import { hasShippingCoveredByDiscordId, getShippingRate, formatShippingRate } from '../shipping.js';
import * as currentPackBattle from '../lib/wp-current-battle.js';

/**
 * Update the original battle message in #pack-battles.
 * Removes the Buy Pack button and shows the current state.
 */
async function updateBattleMessage(battle, entries, paidEntries, status) {
    try {
        const channel = getChannel('PACK_BATTLES');
        const messageId = battle.channel_message_id || battles.getBattleById.get(battle.id)?.channel_message_id;
        if (!channel || !messageId) return;

        const msg = await channel.messages.fetch(messageId);
        const embed = buildBattleEmbed({ ...battle, status }, entries, paidEntries);

        if (status === 'closed') {
            embed.setFooter({ text: `Battle #${battle.battle_number || '?'} • ${paidEntries.length} entries • Opening packs now!` });
        }

        // Keep buttons for open battles, remove for closed/complete/cancelled
        const editPayload = { embeds: [embed] };
        if (status !== 'open') {
            editPayload.components = [];
        }
        await msg.edit(editPayload);
    } catch (e) {
        console.error('Failed to update battle message:', e.message);
    }
}

/**
 * Build the battle status embed.
 * Every entry is a paid entry — purchase is the only way to join.
 */
function buildBattleEmbed(battle, entries, paidEntries) {
    const statusText = battle.status === 'open'
        ? '🟢 OPEN — Buy your pack to enter!'
        : battle.status === 'closed'
            ? '🔴 CLOSED — No more entries'
            : battle.status === 'complete'
                ? '🏆 COMPLETE'
                : '❌ CANCELLED';

    const embed = new EmbedBuilder()
        .setTitle(`⚔️ Pack Battle — ${battle.product_name}`)
        .setDescription(statusText)
        .setColor(battle.status === 'open' ? 0xceff00 : battle.status === 'complete' ? 0xffd700 : 0xe74c3c)
        .addFields(
            { name: 'Entries', value: `${paidEntries.length}/${battle.max_entries}`, inline: true },
        );

    if (paidEntries.length > 0) {
        const roster = paidEntries.map((e, i) => `${i + 1}. <@${e.discord_user_id}>`).join('\n');
        embed.addFields({ name: 'Roster', value: roster });
    }

    if (battle.winner_id) {
        embed.addFields({ name: '🏆 Winner', value: `<@${battle.winner_id}>` });
    }

    return embed;
}

/**
 * Handle !battle commands.
 */
async function handleBattle(message, args) {
    const subcommand = args[0]?.toLowerCase();

    // Only mods/owner can manage battles (anyone can check status)
    const isAdmin = message.member.roles.cache.has(config.ROLES.NANOOK)
        || message.member.roles.cache.has(config.ROLES.AKIVILI);

    if (!isAdmin && subcommand !== 'status') {
        return message.reply('Only moderators can manage pack battles.');
    }

    switch (subcommand) {
        case 'start':
            return startBattle(message, args.slice(1));
        case 'close':
            return closeBattle(message);
        case 'cancel':
            return cancelBattle(message);
        case 'winner':
            return declareBattleWinner(message, args.slice(1));
        case 'join':
            return ownerJoinBattle(message);
        case 'status':
            return battleStatus(message);
        case 'test-homepage':
            return testHomepageWidget(message);
        default:
            return message.reply(
                'Usage: `!battle start/close/cancel/join/status/test-homepage`, `!battle winner @user`'
            );
    }
}

/**
 * Look up a Stripe price ID by searching for a product by name.
 */
async function findStripePriceId(productName) {
    const stripe = new Stripe(config.STRIPE_SECRET_KEY);
    const products = await stripe.products.search({
        query: `active:"true" AND name~"${productName.replace(/"/g, '\\"')}"`,
        limit: 1,
    });

    if (!products.data.length) return null;

    const product = products.data[0];
    // Use the default price, or fetch the first active price
    if (product.default_price) {
        return typeof product.default_price === 'string'
            ? product.default_price
            : product.default_price.id;
    }

    const prices = await stripe.prices.list({
        product: product.id,
        active: true,
        limit: 1,
    });

    return prices.data.length ? prices.data[0].id : null;
}

async function startBattle(message, args) {
    const active = battles.getActiveBattle.get();
    if (active) {
        return message.reply('There\'s already an active battle. Close or cancel it first.');
    }

    if (!args.length) {
        return message.reply('Usage: `!battle start <product-name> [max-entries]`\n\nExample: `!battle start Prismatic Evolutions 10`');
    }

    const maxEntries = parseInt(args[args.length - 1], 10);
    const hasMaxArg = !isNaN(maxEntries) && maxEntries > 0;
    const productName = hasMaxArg ? args.slice(0, -1).join(' ') : args.join(' ');
    const productSlug = productName.toLowerCase().replace(/\s+/g, '-');
    const max = hasMaxArg ? Math.min(maxEntries, 50) : 20;

    if (!productName) {
        return message.reply('Usage: `!battle start <product-name> [max-entries]`');
    }

    // Look up the Stripe price ID from the product name
    await message.channel.send(`🔍 Looking up **${productName}** in Stripe...`);
    const priceId = await findStripePriceId(productName);

    if (!priceId) {
        return message.reply(`Could not find a product matching **${productName}** in Stripe. Check the product name and try again.`);
    }

    const result = battles.createBattle.run(productSlug, productName, priceId, max, null);
    const battleId = result.lastInsertRowid;

    const embed = new EmbedBuilder()
        .setTitle(`⚔️ Pack Battle — ${productName}`)
        .setDescription(`🟢 OPEN — Buy your pack to enter!\n\n*No shipping at buy-in — only the winner pays shipping.*`)
        .setColor(0xceff00)
        .addFields(
            { name: 'Entries', value: `0/${max}`, inline: true },
        )
        .setFooter({ text: 'Purchase = entry. No other action needed.' });

    const buyButton = new ButtonBuilder()
        .setCustomId(`battle-buy-${battleId}`)
        .setLabel('Buy Pack')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🛒');

    const row = new ActionRowBuilder().addComponents(buyButton);
    const battleChannel = getChannel('PACK_BATTLES');
    const msg = await battleChannel.send({ embeds: [embed], components: [row] });
    battles.setBattleMessage.run(msg.id, battleId);

    currentPackBattle.setOpen({ id: battleId, stripe_price_id: priceId, max_entries: max });

    if (message.channel.id !== config.CHANNELS.PACK_BATTLES) {
        await message.channel.send(`⚔️ Pack battle started in <#${config.CHANNELS.PACK_BATTLES}> — **${productName}** (${max} max entries)`);
    }

    // Announce in #announcements (no buy button — that's only in #pack-battles)
    await sendToChannel('ANNOUNCEMENTS', {
        embeds: [new EmbedBuilder()
            .setTitle('⚔️ Pack Battle Starting!')
            .setDescription(`**${productName}** — Head to <#${config.CHANNELS.PACK_BATTLES}> to enter!\n\nMax entries: ${max}`)
            .setColor(0xceff00)],
    });
}

async function closeBattle(message) {
    const battle = battles.getActiveBattle.get();
    if (!battle) {
        return message.reply('No active battle to close.');
    }

    const entries = battles.getEntries.all(battle.id);
    const paidEntries = battles.getPaidEntries.all(battle.id);

    if (paidEntries.length === 0) {
        battles.deleteBattle.run(battle.id);
        // Update original message if it exists
        await updateBattleMessage(battle, [], [], 'cancelled');
        currentPackBattle.clear();
        await message.channel.send(`❌ Pack battle **${battle.product_name}** closed with no entries — not counted.`);
        return;
    }

    // Assign sequential battle number only for battles with entries
    const { next } = battles.getNextBattleNumber.get();
    battles.setBattleNumber.run(next, battle.id);
    battles.closeBattle.run(battle.id);

    const numberedBattle = { ...battle, battle_number: next, status: 'closed' };

    // Update the original message in #pack-battles (remove button, show closed state)
    await updateBattleMessage(numberedBattle, entries, paidEntries, 'closed');
    currentPackBattle.setInProgress(numberedBattle, paidEntries.length);

    await message.channel.send(`⚔️ Pack battle #${next} **${battle.product_name}** is closed — ${paidEntries.length} entries. Opening packs now!`);
}

async function cancelBattle(message) {
    const battle = battles.getActiveBattle.get();
    if (!battle) {
        return message.reply('No active battle to cancel.');
    }

    const entries = battles.getEntries.all(battle.id);

    if (entries.length === 0) {
        await updateBattleMessage(battle, [], [], 'cancelled');
        battles.deleteBattle.run(battle.id);
        currentPackBattle.clear();
        await message.channel.send(`❌ Pack battle **${battle.product_name}** cancelled — not counted.`);
    } else {
        battles.cancelBattle.run(battle.id);
        const paidEntries = battles.getPaidEntries.all(battle.id);
        await updateBattleMessage(battle, entries, paidEntries, 'cancelled');
        currentPackBattle.clear();
        await message.channel.send(`❌ Pack battle **${battle.product_name}** has been cancelled.`);
        const entrants = entries.map((e) => `<@${e.discord_user_id}>`).join(', ');
        await message.channel.send(`Notifying entrants: ${entrants} — battle cancelled, refunds if applicable.`);
    }
}

async function declareBattleWinner(message, args) {
    // Find the most recent closed battle
    const battle = battles.getBattleById.get(
        (() => {
            const row = db.prepare(
                "SELECT id FROM battles WHERE status = 'closed' ORDER BY created_at DESC LIMIT 1"
            ).get();
            return row?.id;
        })()
    );

    if (!battle) {
        return message.reply('No closed battle found. Close the battle first with `!battle close`.');
    }

    const mentioned = message.mentions.users.first();
    if (!mentioned) {
        return message.reply('Usage: `!battle winner @user`');
    }

    battles.setBattleWinner.run(mentioned.id, battle.id);

    // Assign Aha role
    const member = await getMember(mentioned.id);
    if (member) {
        await addRole(member, config.ROLES.AHA);
    }

    const entries = battles.getEntries.all(battle.id);
    const paidEntries = battles.getPaidEntries.all(battle.id);

    // Update the original message in #pack-battles with winner
    await updateBattleMessage({ ...battle, winner_id: mentioned.id }, entries, paidEntries, 'complete');
    currentPackBattle.clear();

    const num = battle.battle_number || '?';

    // Cross-post to announcements
    await sendEmbed('ANNOUNCEMENTS', {
        title: `🏆 Pack Battle #${num} Winner!`,
        description: `<@${mentioned.id}> won the **${battle.product_name}** pack battle and takes home ALL the cards!`,
        color: 0xffd700,
    });

    broadcastBattleWinner(`<@${mentioned.id}>`, battle.product_name);

    // Check if winner needs shipping — battles don't charge shipping at buy-in
    const isOwner = mentioned.id === (getGuild()?.ownerId);
    const covered = hasShippingCoveredByDiscordId(mentioned.id);

    if (isOwner) {
        await message.channel.send(`🏆 <@${mentioned.id}> wins all the cards!`);
    } else if (covered) {
        await message.channel.send(`🏆 <@${mentioned.id}> wins all the cards! Shipping already covered this period.`);
    } else {
        // DM winner with shipping checkout link
        const rate = getShippingRate(mentioned.id);
        const shippingUrl = `${config.SITE_URL}/bot/shipping/checkout?amount=${rate}&reason=${encodeURIComponent(`Shipping — ${battle.product_name} battle`)}&user=${mentioned.id}`;

        try {
            const winner = await getMember(mentioned.id);
            if (winner) {
                const dm = await winner.createDM();
                const embed = new EmbedBuilder()
                    .setTitle('🏆 You Won the Pack Battle!')
                    .setDescription(
                        `Congrats on winning **${battle.product_name}**! All the cards are yours.\n\n` +
                        `To get them shipped, please pay shipping (${formatShippingRate(rate)}) using the link below:\n\n` +
                        `🛒 **[Pay Shipping](${shippingUrl})**`
                    )
                    .setColor(0xffd700);
                await dm.send({ embeds: [embed] });
            }
        } catch (e) {
            console.error(`Failed to DM battle winner ${mentioned.id}:`, e.message);
        }

        await message.channel.send(`🏆 <@${mentioned.id}> wins all the cards! Shipping DM sent (${formatShippingRate(rate)}).`);
    }
}

async function ownerJoinBattle(message) {
    // Only Akivili (server owner) can use this
    if (!message.member.roles.cache.has(config.ROLES.AKIVILI)) {
        return message.reply('Only the server owner can use `!battle join`.');
    }

    const battle = battles.getActiveBattle.get();
    if (!battle) {
        return message.reply('No active battle to join.');
    }

    // Check if already entered
    const existingEntries = battles.getEntries.all(battle.id);
    if (existingEntries.some((e) => e.discord_user_id === message.author.id)) {
        return message.reply('You\'re already in this battle.');
    }

    // Check if battle is full
    const entryCount = battles.getEntryCount.get(battle.id).count;
    if (entryCount >= battle.max_entries) {
        return message.reply('Battle is full.');
    }

    // Add entry as paid (no Stripe session)
    battles.addEntry.run(battle.id, message.author.id, battle.id, battle.id);
    battles.confirmPayment.run(`owner-${battle.id}`, battle.id, message.author.id);

    // Decrement stock in WordPress
    if (battle.stripe_price_id) {
        try {
            const url = `${config.SITE_URL}/wp-json/shop/v1/decrement-stock`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    price_id: battle.stripe_price_id,
                    quantity: 1,
                    secret: config.LIVESTREAM_SECRET,
                }),
            });
            const data = await response.json();
            if (response.ok) {
                console.log(`Stock decremented: ${data.product} (${data.old_stock} → ${data.new_stock})`);
            } else {
                console.error('Stock decrement failed:', data.message);
            }
        } catch (e) {
            console.error('Could not decrement stock:', e.message);
        }
    }

    // Update the battle embed in #pack-battles
    const entries = battles.getEntries.all(battle.id);
    const paidEntries = battles.getPaidEntries.all(battle.id);
    await updateBattleMessage(battle, entries, paidEntries, 'open');

    // Post entry notification in #pack-battles
    await sendToChannel('PACK_BATTLES', `⚔️ <@${message.author.id}> is in! (${paidEntries.length}/${battle.max_entries})`);

    if (message.channel.id !== config.CHANNELS.PACK_BATTLES) {
        await message.channel.send(`⚔️ Joined battle — ${paidEntries.length}/${battle.max_entries} entries (stock decremented)`);
    }

    broadcastBattleEntry(`<@${message.author.id}>`, paidEntries.length, battle.max_entries, battle.product_name);
    if (paidEntries.length >= battle.max_entries) {
        broadcastBattleFull(battle.product_name, battle.max_entries);
    }
}

/**
 * Cycle the homepage pack-battle widget through its three states without
 * touching the SQLite battles table or posting in #pack-battles. Useful for
 * verifying the WP endpoint, ACF write path, and itzenzo.tv render after a
 * deploy or schema change.
 */
async function testHomepageWidget(message) {
    const stub = {
        id: 999999,
        stripe_price_id: 'price_test_homepage',
        max_entries: 8,
    };

    await message.channel.send('🧪 Pushing homepage widget: **open** (8 max, 0 paid)…');
    const openRes = await currentPackBattle.setOpen(stub);
    await message.channel.send(openRes ? '✅ open OK' : '❌ open failed (see bot logs)');

    await new Promise((r) => setTimeout(r, 4000));

    await message.channel.send('🧪 Pushing homepage widget: **in_progress** (3 paid)…');
    const progRes = await currentPackBattle.setInProgress(stub, 3);
    await message.channel.send(progRes ? '✅ in_progress OK' : '❌ in_progress failed (see bot logs)');

    await new Promise((r) => setTimeout(r, 4000));

    await message.channel.send('🧪 Pushing homepage widget: **idle** (clear)…');
    const clearRes = await currentPackBattle.clear();
    await message.channel.send(clearRes ? '✅ idle OK' : '❌ idle failed (see bot logs)');
}

async function battleStatus(message) {
    const battle = battles.getActiveBattle.get();
    if (!battle) {
        return message.reply('No active battle right now.');
    }

    const entries = battles.getEntries.all(battle.id);
    const paidEntries = battles.getPaidEntries.all(battle.id);
    const embed = buildBattleEmbed(battle, entries, paidEntries);

    await message.channel.send({ embeds: [embed] });
}

export { handleBattle, updateBattleMessage };
