/**
 * /spin — pick a giveaway winner.
 *   /spin                       — random pick from current giveaway
 *   /spin pick user:<user>      — owner-only: rig the outcome
 */

import config from '../../config.js';
import { buildSyntheticMessage } from '../../lib/synthetic-message.js';
import { handleSpin } from '../spin.js';

export async function handleSpinSlash(interaction) {
    if (!interaction.member?.roles?.cache?.has(config.ROLES.AKIVILI)) {
        return interaction.reply({ content: 'Only Akivili can run /spin.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand(false);
    let args = [];
    let mentionedUser = null;
    let mentionedMember = null;

    if (sub === 'pick') {
        mentionedUser = interaction.options.getUser('user', true);
        try {
            mentionedMember = await interaction.guild.members.fetch(mentionedUser.id);
        } catch { /* may have left guild */ }
        args = ['pick'];
    }

    await interaction.deferReply({ ephemeral: true });
    const message = buildSyntheticMessage(interaction, { mentionedUser, mentionedMember });
    try {
        await handleSpin(message, args);
        if (!interaction.replied) {
            await interaction.followUp({ content: `✓ /spin ${sub || ''} ran.`, ephemeral: true });
        }
        return sub || 'spin';
    } catch (e) {
        await interaction.followUp({ content: `✗ /spin failed: ${e.message}`, ephemeral: true });
        throw e;
    }
}
