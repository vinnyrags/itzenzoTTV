/**
 * /duckrace — duck race lifecycle.
 *   /duckrace                       — show current race state
 *   /duckrace start                 — start the race
 *   /duckrace winner user:<user>    — declare winner
 *   /duckrace pick user:<user>      — owner-only: rig the outcome
 */

import config from '../../config.js';
import { buildSyntheticMessage } from '../../lib/synthetic-message.js';
import { handleDuckRace } from '../queue.js';

export async function handleDuckRaceSlash(interaction) {
    const isAdmin = interaction.member?.roles?.cache?.has(config.ROLES.NANOOK)
        || interaction.member?.roles?.cache?.has(config.ROLES.AKIVILI);
    if (!isAdmin) {
        return interaction.reply({ content: 'Only mods/Akivili can run /duckrace.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand(false) || 'show';
    let args = sub === 'show' ? [] : [sub];
    let mentionedUser = null;
    let mentionedMember = null;

    if (sub === 'winner' || sub === 'pick') {
        mentionedUser = interaction.options.getUser('user', true);
        try {
            mentionedMember = await interaction.guild.members.fetch(mentionedUser.id);
        } catch { /* may have left guild */ }
    }

    await interaction.deferReply({ ephemeral: true });
    const message = buildSyntheticMessage(interaction, { mentionedUser, mentionedMember });
    try {
        await handleDuckRace(message, args);
        if (!interaction.replied) {
            await interaction.followUp({ content: `✓ /duckrace ${sub} ran.`, ephemeral: true });
        }
        return sub;
    } catch (e) {
        await interaction.followUp({ content: `✗ /duckrace ${sub} failed: ${e.message}`, ephemeral: true });
        throw e;
    }
}
