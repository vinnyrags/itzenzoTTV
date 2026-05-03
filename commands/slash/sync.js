/**
 * /sync — pull catalog from Sheets/Stripe → WordPress.
 * /sync mode:full      — full sync (default)
 * /sync mode:stripe    — Stripe only (faster, skips Sheets)
 */

import config from '../../config.js';
import { buildSyntheticMessage } from '../../lib/synthetic-message.js';
import { handleSync } from '../sync.js';

export async function handleSyncSlash(interaction) {
    if (!interaction.member?.roles?.cache?.has(config.ROLES.AKIVILI)) {
        return interaction.reply({ content: 'Only Akivili can run /sync.', ephemeral: true });
    }

    const mode = interaction.options.getString('mode') || 'full';
    const args = mode === 'stripe' ? ['stripe'] : [];

    await interaction.deferReply({ ephemeral: true });
    const message = buildSyntheticMessage(interaction);
    try {
        await handleSync(message, args);
        if (!interaction.replied) {
            await interaction.followUp({ content: `✓ /sync (${mode}) finished. Check the channel for the result embed.`, ephemeral: true });
        }
        return mode;
    } catch (e) {
        await interaction.followUp({ content: `✗ /sync failed: ${e.message}`, ephemeral: true });
        throw e;
    }
}
