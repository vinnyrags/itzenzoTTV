/**
 * /reset — native slash command with detailed confirmation.
 *
 * Pattern:
 *   1. /reset → ephemeral embed listing EXACTLY what gets wiped, with
 *      [Confirm Reset] and [Cancel] buttons
 *   2. Confirm → wipes data, runs !sync, updates the same ephemeral embed
 *      with results
 *   3. Cancel → updates the embed to show the abort
 *
 * The detailed list lives here so the operator never has to remember
 * what reset actually touches. If the wiped scope changes, update both
 * the embed text AND the underlying handleReset() — they should agree.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import config from '../../config.js';
import { db } from '../../db.js';
import { handleSync } from '../sync.js';
import { initCommunityGoals } from '../../community-goals.js';
import * as queueSource from '../../lib/queue-source.js';
import { buildSyntheticMessage } from '../../lib/synthetic-message.js';

// Tables wiped — must agree with the underlying handleReset() in commands/reset.js
const TABLES_TO_CLEAR = [
    'queue_entries',
    'queues',
    'battle_entries',
    'battles',
    'duck_race_entries',
    'giveaway_entries',
    'giveaways',
    'pull_entries',
    'card_listings',
    'livestream_buyers',
    'livestream_sessions',
    'purchases',
    'purchase_counts',
    'discord_links',
    'shipping_payments',
    'active_coupons',
];

// Human-readable list shown in the confirmation embed. Grouped by domain
// so the operator can scan and recognize what's being touched.
const WIPE_GROUPS = [
    { domain: 'Queue (canonical, WordPress)', items: ['Active session + all upcoming/active/completed entries'] },
    { domain: 'Pack battles', items: ['All battles + entries'] },
    { domain: 'Duck races', items: ['All races + entries'] },
    { domain: 'Giveaways', items: ['All giveaways + entries'] },
    { domain: 'Pull boxes', items: ['All entries (slot claims preserved on WP — no DB rows here)'] },
    { domain: 'Card shop', items: ['All listings (single + list-session) — TTLs cleared'] },
    { domain: 'Livestream', items: ['All session metadata + buyer rows'] },
    { domain: 'Purchases & identity', items: ['All purchases + counts', 'All Discord ↔ email links'] },
    { domain: 'Shipping & coupons', items: ['Shipping payment records (per-period coverage resets)', 'Active coupon claims'] },
    { domain: 'Community goals', items: ['Cycle resets to 1, lifetime/cycle revenue → $0'] },
    { domain: 'After wipe', items: ['Runs `!sync` to repopulate stock from Sheets → Stripe → WP'] },
];

const WIPE_LINES = WIPE_GROUPS
    .map(g => `**${g.domain}** — ${g.items.join('; ')}`)
    .join('\n');

function buildConfirmEmbed() {
    return new EmbedBuilder()
        .setTitle('⚠️ Confirm Stream Reset')
        .setDescription(
            `This wipes **all transactional state** so the next stream starts clean. Stock is restored automatically.\n\n` +
            `**What gets wiped:**\n${WIPE_LINES}\n\n` +
            `**What stays untouched:** Discord channels/roles/permissions, bot config, Stripe products themselves, WP catalog posts, ShippingEasy orders already filed, the #ops-log audit history.\n\n` +
            `Click **Confirm Reset** to proceed, **Cancel** to abort.`
        )
        .setColor(0xe74c3c)
        .setFooter({ text: 'Times out after 60s' });
}

function buildButtons(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('reset:confirm')
            .setLabel('Confirm Reset')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('reset:cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
    );
}

export async function handleResetSlash(interaction) {
    if (!interaction.member?.roles?.cache?.has(config.ROLES.AKIVILI)) {
        return interaction.reply({ content: 'Only Akivili can run /reset.', ephemeral: true });
    }

    await interaction.reply({
        embeds: [buildConfirmEmbed()],
        components: [buildButtons()],
        ephemeral: true,
    });

    // Wait for a button press from THIS user on THIS message
    let buttonInteraction;
    try {
        buttonInteraction = await interaction.fetchReply().then(reply =>
            reply.awaitMessageComponent({
                filter: (i) => i.user.id === interaction.user.id,
                time: 60_000,
            })
        );
    } catch {
        // timeout
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setDescription('⏱ Reset confirmation timed out — no changes made.')
                .setColor(0x95a5a6)],
            components: [buildButtons(true)],
        });
        return 'timed out';
    }

    if (buttonInteraction.customId === 'reset:cancel') {
        await buttonInteraction.update({
            embeds: [new EmbedBuilder()
                .setDescription('❌ Reset cancelled — no changes made.')
                .setColor(0x95a5a6)],
            components: [buildButtons(true)],
        });
        return 'cancelled';
    }

    // Confirmed — start the wipe
    await buttonInteraction.update({
        embeds: [new EmbedBuilder()
            .setTitle('🗑 Resetting…')
            .setDescription('Wiping tables and restoring stock. This may take a minute.')
            .setColor(0xf39c12)],
        components: [buildButtons(true)],
    });

    const cleared = [];
    for (const table of TABLES_TO_CLEAR) {
        try {
            const result = db.prepare(`DELETE FROM ${table}`).run();
            if (result.changes > 0) cleared.push(`${table}: ${result.changes}`);
        } catch (e) {
            console.error(`[reset] failed to clear ${table}:`, e.message);
        }
    }

    db.prepare('UPDATE community_goals SET cycle = 1, cycle_revenue = 0, lifetime_revenue = 0 WHERE id = 1').run();
    try { db.prepare('DELETE FROM sqlite_sequence').run(); } catch { /* ok */ }

    let wpReset = null;
    try {
        wpReset = await queueSource.resetAll();
    } catch (e) {
        console.error('[reset] WP queue wipe failed:', e.message);
    }

    await initCommunityGoals();

    const wpLine = wpReset && !wpReset.sqliteHandledExternally
        ? `WP queue wiped: ${wpReset.sessionsDeleted} session(s), ${wpReset.entriesDeleted} entries.`
        : '';
    const clearedLine = cleared.length ? cleared.join(', ') : 'All tables already empty';

    await interaction.editReply({
        embeds: [new EmbedBuilder()
            .setTitle('✓ Reset complete — running !sync')
            .setDescription(`${clearedLine}${wpLine ? `\n${wpLine}` : ''}\nCommunity goals reset. Restock tracker refreshed.`)
            .setColor(0x2ecc71)],
        components: [buildButtons(true)],
    });

    // Run sync to restore stock — handleSync wants a message-shaped object
    const syntheticMessage = buildSyntheticMessage(buttonInteraction);
    try {
        await handleSync(syntheticMessage, []);
    } catch (e) {
        console.error('[reset] sync after wipe failed:', e.message);
        await interaction.followUp({
            content: `⚠ Reset wiped data successfully but \`!sync\` failed: ${e.message}. Run \`/op sync\` manually.`,
            ephemeral: true,
        });
    }

    return cleared.length ? `wiped ${cleared.length} tables` : 'no changes';
}
