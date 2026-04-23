/**
 * Minecraft Channel — react-for-DM invite hub.
 *
 * On startup, initMinecraftChannel() wipes #minecraft, posts a single
 * persistent embed, and adds three reactions (one per realm). When a user
 * reacts, handleMinecraftReaction() DMs them the realm payload.
 *
 * Two payload flavors:
 *  - Bedrock realms (horror, creative) — one-shot DM with the invite URL.
 *  - Java hardcore — DM includes a button. Clicking it opens a modal that
 *    collects the user's Minecraft Java username; on submit, the bot posts
 *    a whitelist request to #ops (with @Akivili mention) for manual
 *    allowlisting, and confirms to the user via ephemeral reply.
 *
 * Realm invite text comes from env vars (MINECRAFT_*_INVITE) so codes
 * never land in the repo. Channel ID comes from DISCORD_MINECRAFT_CHANNEL_ID.
 */

import {
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
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

// Custom IDs for the Java whitelist button + modal. Also referenced by
// the interaction dispatcher in commands/interactions.js.
const JAVA_WHITELIST_BUTTON_ID = 'minecraft-java-whitelist';
const JAVA_WHITELIST_MODAL_ID = 'minecraft-java-whitelist-modal';
const JAVA_USERNAME_INPUT_ID = 'java-username';

// Minecraft Java usernames: 3-16 chars, a-zA-Z0-9_ (Mojang legacy rule).
const MINECRAFT_JAVA_USERNAME_REGEX = /^[a-zA-Z0-9_]{3,16}$/;

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

function buildJavaWhitelistButtonRow() {
    const button = new ButtonBuilder()
        .setCustomId(JAVA_WHITELIST_BUTTON_ID)
        .setLabel('Submit my Minecraft Java username')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🪓');
    return new ActionRowBuilder().addComponents(button);
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
 * different emoji, or from a bot. DMs the user the realm payload
 * (invite text; Java additionally includes a whitelist-request button),
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

    const removeReaction = async () => {
        try { await reaction.users.remove(user.id); } catch { /* ok */ }
    };

    const invite = getInviteForRealm(realm.key);
    if (!invite) {
        console.warn(`Minecraft invite for "${realm.key}" is not configured — set the corresponding env var`);
        await removeReaction();
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(`${reaction.emoji.name}  ${realm.label}`)
        .setDescription(invite)
        .setColor(0xceff00)
        .setFooter({ text: 'itzenzo.tv — see you on the realm.' });

    const payload = realm.key === 'java'
        ? { embeds: [embed], components: [buildJavaWhitelistButtonRow()] }
        : { embeds: [embed] };

    try {
        const member = await getMember(user.id);
        if (member) {
            const dm = await member.createDM();
            await dm.send(payload);
        }
    } catch (e) {
        console.warn(`Failed to DM ${user.tag || user.id} for ${realm.key}:`, e.message);
    }

    await removeReaction();
}

/**
 * Button click on the Java whitelist button (sent via DM by
 * handleMinecraftReaction). Opens a modal asking for the user's
 * Minecraft Java username.
 *
 * Dispatched from commands/interactions.js via customId.
 */
async function handleJavaWhitelistButton(interaction) {
    const modal = new ModalBuilder()
        .setCustomId(JAVA_WHITELIST_MODAL_ID)
        .setTitle('Java Hardcore whitelist');

    const input = new TextInputBuilder()
        .setCustomId(JAVA_USERNAME_INPUT_ID)
        .setLabel('Your Minecraft Java username')
        .setStyle(TextInputStyle.Short)
        .setMinLength(3)
        .setMaxLength(16)
        .setRequired(true)
        .setPlaceholder('e.g. itzenzoTTV');

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
}

/**
 * Modal submit handler for the Java whitelist flow. Validates the
 * submitted username, posts a request to #ops (with @Akivili mention)
 * for manual whitelisting, and confirms to the user via ephemeral reply.
 *
 * Dispatched from commands/interactions.js via customId.
 */
async function handleJavaWhitelistSubmit(interaction) {
    const raw = interaction.fields.getTextInputValue(JAVA_USERNAME_INPUT_ID)?.trim() || '';
    const username = raw.replace(/^@/, '');

    if (!MINECRAFT_JAVA_USERNAME_REGEX.test(username)) {
        return interaction.reply({
            content:
                "That doesn't look like a valid Minecraft Java username. They're 3–16 characters — letters, numbers, and underscores only (e.g. `itzenzoTTV`). Click the button and try again.",
            ephemeral: true,
        });
    }

    const ops = getChannel('OPS');
    if (ops) {
        const requestEmbed = new EmbedBuilder()
            .setTitle('🪓 Java Hardcore whitelist request')
            .setDescription(
                `Requester: <@${interaction.user.id}> (${interaction.user.tag})\n` +
                `Minecraft Java username: \`${username}\`\n\n` +
                'Add them to the realm whitelist on the Realms screen, then reach out to confirm.'
            )
            .setColor(0xceff00)
            .setFooter({ text: 'itzenzo.tv — Minecraft react-for-invite' });

        const mention = config.ROLES?.AKIVILI ? `<@&${config.ROLES.AKIVILI}>` : '';
        try {
            await ops.send({ content: mention, embeds: [requestEmbed] });
        } catch (e) {
            console.error('Failed to post Java whitelist request to #ops:', e.message);
        }
    } else {
        console.warn('Java whitelist request received but #ops channel is unavailable.');
    }

    return interaction.reply({
        content:
            `Got it — your Minecraft Java username \`${username}\` has been sent over. ` +
            `Vincent will add you to the realm whitelist and reach out to confirm, usually within 24 hours. One life. No respawns.`,
        ephemeral: true,
    });
}

export {
    initMinecraftChannel,
    handleMinecraftReaction,
    handleJavaWhitelistButton,
    handleJavaWhitelistSubmit,
    REALM_BY_EMOJI,
    REACTION_EMOJIS,
    JAVA_WHITELIST_BUTTON_ID,
    JAVA_WHITELIST_MODAL_ID,
    JAVA_USERNAME_INPUT_ID,
    MINECRAFT_JAVA_USERNAME_REGEX,
    getInviteForRealm,
    buildMinecraftEmbed,
    buildJavaWhitelistButtonRow,
};
