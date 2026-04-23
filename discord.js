/**
 * Discord client setup and helpers.
 */

import { Client, GatewayIntentBits, EmbedBuilder, Partials } from 'discord.js';
import config from './config.js';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
    ],
    // Required to receive reactionAdd events on messages cached before the
    // bot started (or after a restart). The persistent #minecraft embed
    // outlives the bot process, so without partials those reactions silently drop.
    partials: [Partials.Message, Partials.Reaction, Partials.User],
});

// Channel overrides for test mode — redirects output to #test-suite
const channelOverrides = new Map();

function setChannelOverride(key, channelId) {
    channelOverrides.set(key, channelId);
}

function clearChannelOverrides() {
    channelOverrides.clear();
}

function isChannelOverridden(key) {
    return channelOverrides.has(key);
}

/**
 * Get a text channel by its config key. Respects test overrides.
 */
function getChannel(key) {
    return client.channels.cache.get(channelOverrides.get(key) || config.CHANNELS[key]);
}

/**
 * Get the guild.
 */
function getGuild() {
    return client.guilds.cache.get(config.GUILD_ID);
}

/**
 * Send a message to a channel by config key.
 */
async function sendToChannel(key, content) {
    const channel = getChannel(key);
    if (!channel) {
        console.error(`Channel not found: ${key}`);
        return null;
    }
    return channel.send(content);
}

/**
 * Send an embed to a channel by config key.
 */
async function sendEmbed(key, { title, description, color = 0xceff00, fields = [], footer = null }) {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color);

    if (fields.length) embed.addFields(fields);
    if (footer) embed.setFooter({ text: footer });

    return sendToChannel(key, { embeds: [embed] });
}

/**
 * Get a guild member by Discord user ID.
 */
async function getMember(userId) {
    const guild = getGuild();
    if (!guild) return null;
    try {
        return await guild.members.fetch(userId);
    } catch {
        return null;
    }
}

/**
 * Check if a member has a role.
 */
function hasRole(member, roleId) {
    return member.roles.cache.has(roleId);
}

/**
 * Add a role to a member.
 */
async function addRole(member, roleId) {
    if (!hasRole(member, roleId)) {
        await member.roles.add(roleId);
        return true;
    }
    return false;
}

/**
 * Search for a guild member by exact Discord username.
 * Returns the member if found, null otherwise.
 */
async function findMemberByUsername(username) {
    const guild = getGuild();
    if (!guild || !username) return null;
    try {
        const results = await guild.members.fetch({ query: username, limit: 5 });
        return results.find((m) => m.user.username.toLowerCase() === username.toLowerCase()) || null;
    } catch {
        return null;
    }
}

export {
    client,
    getChannel,
    setChannelOverride,
    clearChannelOverrides,
    isChannelOverridden,
    getGuild,
    sendToChannel,
    sendEmbed,
    getMember,
    findMemberByUsername,
    hasRole,
    addRole,
};
