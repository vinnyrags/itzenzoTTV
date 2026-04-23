/**
 * Minecraft Channel — react-for-DM invite hub.
 *
 * On startup, initMinecraftChannel() wipes #minecraft, posts a single
 * persistent embed, and adds three reactions (one per realm). When a user
 * reacts, handleMinecraftReaction() DMs them the corresponding invite text
 * and removes their reaction so they can re-react later.
 *
 * Realm invite text comes from env vars (MINECRAFT_*_INVITE) so codes never
 * land in the repo. Channel ID comes from DISCORD_MINECRAFT_CHANNEL_ID.
 */

import { EmbedBuilder } from 'discord.js';
import config from '../config.js';
import { getChannel, getMember } from '../discord.js';

// Emoji → realm key map. Single source of truth — used by both the embed
// builder (to print the legend) and the reaction handler (to look up invites).
const REALM_BY_EMOJI = {
    '🪓': { key: 'java', label: 'Java Hardcore Survival', note: 'whitelist required' },
    '👻': { key: 'bedrock_horror', label: 'Bedrock Horror Survival', note: '' },
    '🎨': { key: 'bedrock_creative', label: 'Bedrock Creative', note: '' },
};

const REACTION_EMOJIS = Object.keys(REALM_BY_EMOJI);

function buildMinecraftEmbed() {
    const lines = REACTION_EMOJIS.map((emoji) => {
        const realm = REALM_BY_EMOJI[emoji];
        const suffix = realm.note ? ` (${realm.note})` : '';
        return `${emoji} — **${realm.label}**${suffix}`;
    });

    return new EmbedBuilder()
        .setTitle('🟢 Join our Minecraft realms')
        .setDescription(
            'React with the corresponding emoji to receive the realm invite via DM.\n\n' +
            lines.join('\n') +
            '\n\n*DMs closed? Right-click the server → Privacy Settings → enable DMs from server members, then react again.*'
        )
        .setColor(0xceff00)
        .setFooter({ text: 'itzenzo.tv — Three realms. Many games.' });
}

/**
 * Look up the invite text for a realm key. Returns null if the env var
 * is missing — callers should treat that as "not configured" and skip.
 */
function getInviteForRealm(realmKey) {
    return config.MINECRAFT_INVITES?.[realmKey] || null;
}

/**
 * Wipe non-bot messages from the channel. Same pattern as
 * commands/test.js:clearTestChannel — bulkDelete first, fall back to
 * per-message delete for anything older than 14 days.
 */
async function clearChannelMessages(channel, botUserId) {
    try {
        let fetched;
        do {
            fetched = await channel.messages.fetch({ limit: 100 });
            const nonBot = fetched.filter((m) => m.author.id !== botUserId);
            if (nonBot.size === 0) break;

            try {
                await channel.bulkDelete(nonBot, true);
            } catch {
                // bulkDelete fails for messages older than 14 days
            }

            const tooOld = nonBot.filter(
                (m) => Date.now() - m.createdTimestamp >= 14 * 24 * 60 * 60 * 1000,
            );
            for (const m of tooOld.values()) {
                try { await m.delete(); } catch { /* ok */ }
            }
        } while (fetched.size >= 2);
    } catch (e) {
        console.error('Failed to clear minecraft channel:', e.message);
    }
}

/**
 * Ensure the persistent embed exists in #minecraft on bot startup.
 * - Edits in place if the message ID is still valid
 * - Otherwise wipes the channel and posts fresh, then re-adds reactions
 *
 * Safe to call multiple times (idempotent).
 */
async function initMinecraftChannel() {
    try {
        const { minecraft } = await import('../db.js');
        const channel = getChannel('MINECRAFT');
        if (!channel) {
            console.log('Minecraft channel not configured — skipping initMinecraftChannel');
            return;
        }

        const embed = buildMinecraftEmbed();
        const row = minecraft.getConfig.get();

        // Try to edit the existing message in place
        if (row?.channel_message_id) {
            try {
                const msg = await channel.messages.fetch(row.channel_message_id);
                await msg.edit({ embeds: [embed] });

                // Make sure all three reactions are present (Discord may have
                // dropped them, or we may have added a new realm)
                for (const emoji of REACTION_EMOJIS) {
                    const existing = msg.reactions.cache.get(emoji);
                    if (!existing?.me) {
                        try { await msg.react(emoji); } catch { /* ok */ }
                    }
                }
                console.log('Minecraft embed updated');
                return;
            } catch {
                // Message was deleted — fall through to repost
            }
        }

        // Fresh post: wipe non-bot chatter, post embed, add reactions, save ID
        await clearChannelMessages(channel, channel.client.user.id);

        const msg = await channel.send({ embeds: [embed] });
        for (const emoji of REACTION_EMOJIS) {
            try { await msg.react(emoji); } catch { /* ok */ }
        }
        minecraft.setMessageId.run(msg.id);
        console.log('Minecraft embed posted');
    } catch (e) {
        console.error('Failed to initialize minecraft embed:', e.message);
    }
}

/**
 * Handle a reaction on the persistent #minecraft embed.
 * Wired into the global messageReactionAdd handler in index.js.
 *
 * Returns silently if the reaction is on a different message, on a
 * different emoji, or from a bot. DMs the user the realm invite,
 * then removes their reaction so they can re-react later.
 */
async function handleMinecraftReaction(reaction, user) {
    if (user.bot) return;

    const realm = REALM_BY_EMOJI[reaction.emoji.name];
    if (!realm) return;

    const { minecraft } = await import('../db.js');
    const row = minecraft.getConfig.get();
    if (!row?.channel_message_id) return;
    if (reaction.message.id !== row.channel_message_id) return;

    const invite = getInviteForRealm(realm.key);
    if (!invite) {
        console.warn(`Minecraft invite for "${realm.key}" is not configured — set the corresponding env var`);
        // Still remove the reaction so the user knows it was processed
        try { await reaction.users.remove(user.id); } catch { /* ok */ }
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(`${reaction.emoji.name}  ${realm.label}`)
        .setDescription(invite)
        .setColor(0xceff00)
        .setFooter({ text: 'itzenzo.tv — see you on the realm.' });

    try {
        const member = await getMember(user.id);
        if (member) {
            const dm = await member.createDM();
            await dm.send({ embeds: [embed] });
        }
    } catch (e) {
        console.warn(`Failed to DM ${user.tag || user.id} for ${realm.key}:`, e.message);
    }

    // Remove the user's reaction so re-reacting later works
    try { await reaction.users.remove(user.id); } catch { /* ok */ }
}

export {
    initMinecraftChannel,
    handleMinecraftReaction,
    REALM_BY_EMOJI,
    REACTION_EMOJIS,
    getInviteForRealm,
    buildMinecraftEmbed,
};
