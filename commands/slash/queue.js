/**
 * /queue — native slash command.
 *
 * /queue open                  — open a fresh queue session
 * /queue close                 — close the active session
 * /queue history               — show recent sessions
 * /queue next                  — advance to next entry
 * /queue skip                  — skip the current entry
 *
 * Subcommands give Discord-native autocomplete. Internally still calls
 * handleQueue(syntheticMessage, [subcommand, ...]) so the existing logic
 * keeps working unchanged.
 */

import config from '../../config.js';
import { buildSyntheticMessage } from '../../lib/synthetic-message.js';
import { handleQueue } from '../queue.js';

export async function handleQueueSlash(interaction) {
    if (!interaction.member?.roles?.cache?.has(config.ROLES.AKIVILI)) {
        return interaction.reply({ content: 'Only Akivili can run /queue.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    const message = buildSyntheticMessage(interaction);
    try {
        await handleQueue(message, [sub]);
        if (!interaction.replied) {
            await interaction.followUp({ content: `✓ \`/queue ${sub}\` ran. Embed posted in #queue.`, ephemeral: true });
        }
        return `${sub}`;
    } catch (e) {
        await interaction.followUp({ content: `✗ \`/queue ${sub}\` failed: ${e.message}`, ephemeral: true });
        throw e;
    }
}
