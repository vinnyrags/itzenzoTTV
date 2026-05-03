/**
 * /battle — pack-battle lifecycle.
 *   /battle start product:<string> max:<int>
 *   /battle close
 *   /battle cancel
 *   /battle status
 *   /battle winner user:<user>
 */

import config from '../../config.js';
import { buildSyntheticMessage } from '../../lib/synthetic-message.js';
import { handleBattle } from '../battle.js';

export async function handleBattleSlash(interaction) {
    if (!interaction.member?.roles?.cache?.has(config.ROLES.AKIVILI)) {
        return interaction.reply({ content: 'Only Akivili can run /battle.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    let args = [sub];
    let mentionedUser = null;
    let mentionedMember = null;

    if (sub === 'start') {
        const product = interaction.options.getString('product', true);
        const max = interaction.options.getInteger('max') ?? 20;
        // Underlying handler signature: parses tokens; max as last arg.
        args = ['start', ...product.split(/\s+/), String(max)];
    } else if (sub === 'winner') {
        mentionedUser = interaction.options.getUser('user', true);
        try {
            mentionedMember = await interaction.guild.members.fetch(mentionedUser.id);
        } catch { /* may have left guild */ }
        args = ['winner'];
    }

    await interaction.deferReply({ ephemeral: true });
    const message = buildSyntheticMessage(interaction, { mentionedUser, mentionedMember });
    try {
        await handleBattle(message, args);
        if (!interaction.replied) {
            await interaction.followUp({ content: `✓ /battle ${sub} ran.`, ephemeral: true });
        }
        return sub;
    } catch (e) {
        await interaction.followUp({ content: `✗ /battle ${sub} failed: ${e.message}`, ephemeral: true });
        throw e;
    }
}
