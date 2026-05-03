/**
 * Slash command factory — declarative wrapper around legacy handlers.
 *
 * Reduces the per-command boilerplate (akivili check, deferReply, synthetic
 * message, error handling) to a single spec object. Use for any handler
 * whose mapping to slash is "take some interaction options, build args[],
 * call handleX(message, args)".
 *
 * Spec shape:
 *   {
 *     name: 'tracking',                 — slash command name
 *     handler: handleTracking,          — the legacy (message, args) handler
 *     akiviliOnly: true,                — runtime role check (default: true)
 *     allowMods: false,                 — if true, NANOOK can also use
 *     argsBuilder: (interaction) => [], — produces args array from options
 *     userOption: 'user',               — option name for a User mention; if
 *                                         set, populates message.mentions
 *     channelLabel: '#queue',           — included in success message
 *   }
 *
 * Returns an async (interaction) => Promise<string> to register in
 * SLASH_HANDLERS. Wrap with withAudit() at registration time.
 */

import config from '../../config.js';
import { buildSyntheticMessage } from '../../lib/synthetic-message.js';

export function defineSlashCommand(spec) {
    const {
        name,
        handler,
        akiviliOnly = true,
        allowMods = false,
        argsBuilder = () => [],
        userOption = null,
        channelLabel = null,
    } = spec;

    return async function handleSlash(interaction) {
        // Permission check — defense in depth (Discord native perms also enforce)
        const member = interaction.member;
        const isAkivili = member?.roles?.cache?.has(config.ROLES.AKIVILI);
        const isMod = member?.roles?.cache?.has(config.ROLES.NANOOK);

        if (akiviliOnly && !isAkivili && !(allowMods && isMod)) {
            return interaction.reply({
                content: `Only ${allowMods ? 'mods or Akivili' : 'Akivili'} can run /${name}.`,
                ephemeral: true,
            });
        }

        // Resolve args
        const args = argsBuilder(interaction) || [];

        // Resolve mentioned user, if any (powers message.mentions.users.first())
        let mentionedUser = null;
        let mentionedMember = null;
        if (userOption) {
            mentionedUser = interaction.options.getUser(userOption);
            if (mentionedUser && interaction.guild) {
                try {
                    mentionedMember = await interaction.guild.members.fetch(mentionedUser.id);
                } catch { /* user may have left guild */ }
            }
        }

        await interaction.deferReply({ ephemeral: true });
        const message = buildSyntheticMessage(interaction, { mentionedUser, mentionedMember });

        try {
            await handler(message, args);
            if (!interaction.replied) {
                const tail = channelLabel ? ` ${channelLabel}` : '';
                await interaction.followUp({
                    content: `✓ /${name} ran.${tail}`,
                    ephemeral: true,
                });
            }
            return name;
        } catch (e) {
            try {
                await interaction.followUp({
                    content: `✗ /${name} failed: ${e.message}`,
                    ephemeral: true,
                });
            } catch { /* nothing */ }
            throw e;
        }
    };
}
