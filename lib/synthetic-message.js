/**
 * Wrap a Discord ChatInputCommandInteraction into a Message-shaped object so
 * legacy `handleX(message, args)` handlers run unchanged from the /op slash
 * dispatcher.
 *
 * The shape covers what almost every handler reaches for:
 *   - author { id, username, tag }
 *   - member.roles.cache.has(id)
 *   - channel.send / channel.id / channel.lastMessage
 *   - reply() (routes to ephemeral interaction follow-up)
 *   - guild
 *
 * Handlers that do interactive `awaitReactions` / `createMessageCollector`
 * patterns (today: !reset and the legacy !test) won't work cleanly here —
 * those should be ported to native slash commands with proper Discord
 * interaction primitives (modals, buttons). For now the dispatcher logs
 * a warning when those methods are called and returns a stub.
 */

export function buildSyntheticMessage(interaction, extras = {}) {
    const channel = interaction.channel;
    const mentionedUser = extras.mentionedUser || null;
    const mentionedMember = extras.mentionedMember || null;

    return {
        // mentions surface for handlers that read message.mentions.users.first()
        mentions: {
            users: {
                first: () => mentionedUser,
                size: mentionedUser ? 1 : 0,
            },
            members: {
                first: () => mentionedMember,
                size: mentionedMember ? 1 : 0,
            },
        },

        // Discord's Message exposes .delete() on the trigger message; under the
        // synthetic wrapper there's no original message to delete (slash command
        // commands aren't messages). Stub it so callers like duckrace pick that
        // do `try { await message.delete() } catch {}` still work.
        delete: () => Promise.resolve(),
        // Identity
        author: {
            id: interaction.user.id,
            username: interaction.user.username,
            tag: interaction.user.tag || interaction.user.username,
            bot: interaction.user.bot,
        },
        member: interaction.member, // GuildMember — has roles.cache, user, etc.
        guild: interaction.guild,

        // Channel surface
        channel: {
            id: channel?.id,
            type: channel?.type,
            // Most handlers use channel.send to post structured embeds.
            // Forwarding straight to the real channel is correct.
            send: (...args) => channel?.send(...args),
            get lastMessage() { return channel?.lastMessage; },

            // Interactive primitives — flag if a handler reaches for these
            awaitReactions: () => {
                console.warn('[synthetic-message] awaitReactions called — handler needs native-slash port');
                return Promise.resolve(new Map());
            },
            createMessageCollector: () => {
                console.warn('[synthetic-message] createMessageCollector called — handler needs native-slash port');
                return { on: () => {}, stop: () => {} };
            },
        },

        // Reply — route to ephemeral interaction reply / follow-up so the
        // operator sees confirmation/errors without cluttering the channel.
        reply: async (content) => {
            const payload = typeof content === 'string'
                ? { content, ephemeral: true }
                : { ...content, ephemeral: true };
            try {
                if (interaction.replied || interaction.deferred) {
                    return await interaction.followUp(payload);
                }
                return await interaction.reply(payload);
            } catch (e) {
                console.error('[synthetic-message] reply failed:', e.message);
            }
        },

        // discord.js Message exposes `react` on its own object — handlers
        // that want a reaction usually do it on a posted message, not on
        // the trigger. This stub keeps those code paths from crashing.
        react: () => Promise.resolve(),

        // Legacy fields some handlers touch but rarely use meaningfully
        content: `/op ${interaction.options.getString('command') || ''}`,
        id: interaction.id,
        createdTimestamp: interaction.createdTimestamp,
    };
}
