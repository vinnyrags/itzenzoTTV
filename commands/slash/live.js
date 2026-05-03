/**
 * /live — go live (announce stream start, set state).
 * /offline — go offline (close stream state).
 */

import config from '../../config.js';
import { buildSyntheticMessage } from '../../lib/synthetic-message.js';
import { handleLive, handleOffline } from '../live.js';

async function runWithAkivili(interaction, label, fn) {
    if (!interaction.member?.roles?.cache?.has(config.ROLES.AKIVILI)) {
        return interaction.reply({ content: `Only Akivili can run /${label}.`, ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const message = buildSyntheticMessage(interaction);
    try {
        await fn(message);
        if (!interaction.replied) {
            await interaction.followUp({ content: `✓ /${label} ran.`, ephemeral: true });
        }
        return label;
    } catch (e) {
        await interaction.followUp({ content: `✗ /${label} failed: ${e.message}`, ephemeral: true });
        throw e;
    }
}

export const handleLiveSlash = (interaction) => runWithAkivili(interaction, 'live', handleLive);
export const handleOfflineSlash = (interaction) => runWithAkivili(interaction, 'offline', handleOffline);
