/**
 * /hype — community-goal celebration announcement.
 */

import config from '../../config.js';
import { buildSyntheticMessage } from '../../lib/synthetic-message.js';
import { handleHype } from '../hype.js';

export async function handleHypeSlash(interaction) {
    if (!interaction.member?.roles?.cache?.has(config.ROLES.AKIVILI)) {
        return interaction.reply({ content: 'Only Akivili can run /hype.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    const message = buildSyntheticMessage(interaction);
    try {
        await handleHype(message, []);
        if (!interaction.replied) {
            await interaction.followUp({ content: '✓ /hype ran.', ephemeral: true });
        }
        return 'hype';
    } catch (e) {
        await interaction.followUp({ content: `✗ /hype failed: ${e.message}`, ephemeral: true });
        throw e;
    }
}
