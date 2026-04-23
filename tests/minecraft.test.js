/**
 * Tests for the Minecraft react-for-DM module — emoji map, invite lookup,
 * the reaction handler's guards, and the Java whitelist button + modal flow.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
    default: {
        CHANNELS: { MINECRAFT: 'mc_channel_id', OPS: 'ops_channel_id' },
        ROLES: { AKIVILI: 'akivili_role_id' },
        MINECRAFT_INVITES: {
            java: 'Java Hardcore Survival is whitelist-only. Click below to submit your username.',
            bedrock_horror: 'Realm code: HORROR-1234',
            bedrock_creative: null, // intentionally unconfigured
        },
    },
}));

const dmSend = vi.fn().mockResolvedValue(null);
const createDM = vi.fn().mockResolvedValue({ send: dmSend });
const getMember = vi.fn().mockResolvedValue({ createDM });
const opsSend = vi.fn().mockResolvedValue(null);
const getChannel = vi.fn((key) => {
    if (key === 'OPS') return { send: opsSend };
    return null;
});

vi.mock('../discord.js', () => ({
    getChannel: (...args) => getChannel(...args),
    getMember: (...args) => getMember(...args),
}));

const minecraftDb = {
    getConfig: { get: vi.fn() },
    setMessageId: { run: vi.fn() },
};

vi.mock('../db.js', () => ({
    minecraft: minecraftDb,
}));

const {
    REALM_BY_EMOJI,
    REACTION_EMOJIS,
    JAVA_WHITELIST_BUTTON_ID,
    JAVA_WHITELIST_MODAL_ID,
    JAVA_USERNAME_INPUT_ID,
    getInviteForRealm,
    handleMinecraftReaction,
    handleJavaWhitelistButton,
    handleJavaWhitelistSubmit,
    buildMinecraftEmbed,
    buildJavaWhitelistButtonRow,
} = await import('../commands/minecraft.js');

const STORED_MESSAGE_ID = 'msg_abc_123';

beforeEach(() => {
    vi.clearAllMocks();
    minecraftDb.getConfig.get.mockReturnValue({ id: 1, channel_message_id: STORED_MESSAGE_ID });
});

// =========================================================================
// Realm map
// =========================================================================

describe('REALM_BY_EMOJI', () => {
    it('exposes exactly three realms', () => {
        expect(REACTION_EMOJIS).toHaveLength(3);
    });

    it('covers Java, Bedrock Horror, Bedrock Creative', () => {
        const keys = REACTION_EMOJIS.map((e) => REALM_BY_EMOJI[e].key);
        expect(keys).toEqual(['java', 'bedrock_horror', 'bedrock_creative']);
    });

    it('uses 🪓 for Java', () => {
        expect(REALM_BY_EMOJI['🪓'].key).toBe('java');
    });

    it('uses 👻 for Bedrock Horror', () => {
        expect(REALM_BY_EMOJI['👻'].key).toBe('bedrock_horror');
    });

    it('uses 🎨 for Bedrock Creative', () => {
        expect(REALM_BY_EMOJI['🎨'].key).toBe('bedrock_creative');
    });

    it('flags Java as whitelist-required', () => {
        expect(REALM_BY_EMOJI['🪓'].note).toMatch(/whitelist/i);
    });
});

// =========================================================================
// Invite lookup
// =========================================================================

describe('getInviteForRealm', () => {
    it('returns the configured Java intro', () => {
        expect(getInviteForRealm('java')).toMatch(/whitelist/i);
    });

    it('returns the configured Bedrock Horror code', () => {
        expect(getInviteForRealm('bedrock_horror')).toBe('Realm code: HORROR-1234');
    });

    it('returns null for unconfigured realms', () => {
        expect(getInviteForRealm('bedrock_creative')).toBeNull();
    });

    it('returns null for unknown realm keys', () => {
        expect(getInviteForRealm('not_a_realm')).toBeNull();
    });
});

// =========================================================================
// Embed + button builders
// =========================================================================

describe('buildMinecraftEmbed', () => {
    it('lists all three reactions in the description', () => {
        const embed = buildMinecraftEmbed();
        const data = embed.toJSON();
        for (const emoji of REACTION_EMOJIS) {
            expect(data.description).toContain(emoji);
        }
    });

    it('mentions DM privacy fallback', () => {
        const embed = buildMinecraftEmbed();
        const data = embed.toJSON();
        expect(data.description).toMatch(/dms? closed/i);
    });
});

describe('buildJavaWhitelistButtonRow', () => {
    it('renders one primary button with the whitelist custom ID', () => {
        const row = buildJavaWhitelistButtonRow();
        const json = row.toJSON();
        expect(json.components).toHaveLength(1);
        expect(json.components[0].custom_id).toBe(JAVA_WHITELIST_BUTTON_ID);
        expect(json.components[0].style).toBe(1); // ButtonStyle.Primary
    });
});

// =========================================================================
// handleMinecraftReaction guards + DM payloads
// =========================================================================

describe('handleMinecraftReaction', () => {
    function makeReaction(emojiName, messageId = STORED_MESSAGE_ID) {
        return {
            emoji: { name: emojiName },
            message: { id: messageId },
            users: { remove: vi.fn().mockResolvedValue(null) },
        };
    }

    function makeUser(overrides = {}) {
        return { id: 'user_123', bot: false, tag: 'tester#0', ...overrides };
    }

    it('ignores bot users (no DM, no reaction removal)', async () => {
        const reaction = makeReaction('🪓');
        const user = makeUser({ bot: true });
        await handleMinecraftReaction(reaction, user);

        expect(dmSend).not.toHaveBeenCalled();
        expect(reaction.users.remove).not.toHaveBeenCalled();
    });

    it('ignores reactions on a different message', async () => {
        const reaction = makeReaction('🪓', 'some_other_message');
        await handleMinecraftReaction(reaction, makeUser());

        expect(dmSend).not.toHaveBeenCalled();
        expect(reaction.users.remove).not.toHaveBeenCalled();
    });

    it('ignores unknown emojis', async () => {
        const reaction = makeReaction('🍕');
        await handleMinecraftReaction(reaction, makeUser());

        expect(dmSend).not.toHaveBeenCalled();
        expect(reaction.users.remove).not.toHaveBeenCalled();
    });

    it('ignores reactions when no message ID is stored', async () => {
        minecraftDb.getConfig.get.mockReturnValue({ id: 1, channel_message_id: null });
        const reaction = makeReaction('🪓');
        await handleMinecraftReaction(reaction, makeUser());

        expect(dmSend).not.toHaveBeenCalled();
    });

    it('DMs the Java intro + whitelist button when 🪓 is reacted', async () => {
        const reaction = makeReaction('🪓');
        await handleMinecraftReaction(reaction, makeUser());

        expect(dmSend).toHaveBeenCalledTimes(1);
        const payload = dmSend.mock.calls[0][0];

        // Intro embed
        expect(payload.embeds).toHaveLength(1);
        expect(payload.embeds[0].toJSON().description).toMatch(/whitelist/i);

        // Button component
        expect(payload.components).toHaveLength(1);
        const buttons = payload.components[0].toJSON().components;
        expect(buttons[0].custom_id).toBe(JAVA_WHITELIST_BUTTON_ID);

        expect(reaction.users.remove).toHaveBeenCalledWith('user_123');
    });

    it('DMs the Bedrock Horror code (no button) when 👻 is reacted', async () => {
        const reaction = makeReaction('👻');
        await handleMinecraftReaction(reaction, makeUser());

        const payload = dmSend.mock.calls[0][0];
        expect(payload.embeds[0].toJSON().description).toBe('Realm code: HORROR-1234');
        expect(payload.components).toBeUndefined();
        expect(reaction.users.remove).toHaveBeenCalled();
    });

    it('removes the reaction but skips DM when invite is unconfigured', async () => {
        const reaction = makeReaction('🎨');
        await handleMinecraftReaction(reaction, makeUser());

        expect(dmSend).not.toHaveBeenCalled();
        expect(reaction.users.remove).toHaveBeenCalledWith('user_123');
    });

    it('does not throw when getMember returns null (user left server)', async () => {
        getMember.mockResolvedValueOnce(null);
        const reaction = makeReaction('🪓');
        await expect(handleMinecraftReaction(reaction, makeUser())).resolves.toBeUndefined();
        expect(dmSend).not.toHaveBeenCalled();
        expect(reaction.users.remove).toHaveBeenCalled();
    });

    it('does not throw when DM send fails (user has DMs closed)', async () => {
        dmSend.mockRejectedValueOnce(new Error('Cannot send messages to this user'));
        const reaction = makeReaction('🪓');
        await expect(handleMinecraftReaction(reaction, makeUser())).resolves.toBeUndefined();
        expect(reaction.users.remove).toHaveBeenCalled();
    });
});

// =========================================================================
// Java whitelist button
// =========================================================================

describe('handleJavaWhitelistButton', () => {
    it('opens a modal with a username text input', async () => {
        const showModal = vi.fn().mockResolvedValue(null);
        const interaction = { showModal };

        await handleJavaWhitelistButton(interaction);

        expect(showModal).toHaveBeenCalledTimes(1);
        const modal = showModal.mock.calls[0][0];
        const json = modal.toJSON();
        expect(json.custom_id).toBe(JAVA_WHITELIST_MODAL_ID);

        const textInput = json.components[0].components[0];
        expect(textInput.custom_id).toBe(JAVA_USERNAME_INPUT_ID);
        expect(textInput.min_length).toBe(3);
        expect(textInput.max_length).toBe(16);
        expect(textInput.required).toBe(true);
    });
});

// =========================================================================
// Java whitelist modal submit
// =========================================================================

describe('handleJavaWhitelistSubmit', () => {
    function makeInteraction(username, userOverrides = {}) {
        return {
            user: { id: 'user_abc', tag: 'buyer#0', ...userOverrides },
            fields: {
                getTextInputValue: vi.fn().mockReturnValue(username),
            },
            reply: vi.fn().mockResolvedValue(null),
        };
    }

    it('posts the request to #ops with AKIVILI mention on a valid username', async () => {
        const interaction = makeInteraction('itzenzoTTV');
        await handleJavaWhitelistSubmit(interaction);

        expect(opsSend).toHaveBeenCalledTimes(1);
        const args = opsSend.mock.calls[0][0];
        expect(args.content).toBe('<@&akivili_role_id>');
        const embedJson = args.embeds[0].toJSON();
        expect(embedJson.description).toContain('<@user_abc>');
        expect(embedJson.description).toContain('buyer#0');
        expect(embedJson.description).toContain('`itzenzoTTV`');

        expect(interaction.reply).toHaveBeenCalledTimes(1);
        const reply = interaction.reply.mock.calls[0][0];
        expect(reply.ephemeral).toBe(true);
        expect(reply.content).toContain('`itzenzoTTV`');
    });

    it('strips a leading @ from the username before validation', async () => {
        const interaction = makeInteraction('@itzenzoTTV');
        await handleJavaWhitelistSubmit(interaction);

        expect(opsSend).toHaveBeenCalled();
        const embedJson = opsSend.mock.calls[0][0].embeds[0].toJSON();
        expect(embedJson.description).toContain('`itzenzoTTV`');
    });

    it('rejects invalid characters with an ephemeral reply (no ops post)', async () => {
        const interaction = makeInteraction('bad username!');
        await handleJavaWhitelistSubmit(interaction);

        expect(opsSend).not.toHaveBeenCalled();
        expect(interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.stringMatching(/doesn't look like a valid/i),
                ephemeral: true,
            }),
        );
    });

    it('rejects usernames shorter than 3 characters', async () => {
        const interaction = makeInteraction('ab');
        await handleJavaWhitelistSubmit(interaction);

        expect(opsSend).not.toHaveBeenCalled();
        expect(interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({ ephemeral: true }),
        );
    });

    it('rejects usernames longer than 16 characters', async () => {
        const interaction = makeInteraction('a'.repeat(17));
        await handleJavaWhitelistSubmit(interaction);

        expect(opsSend).not.toHaveBeenCalled();
    });

    it('still replies to the user even if #ops is missing', async () => {
        // Temporarily make getChannel('OPS') return null
        getChannel.mockImplementationOnce((key) => null);
        const interaction = makeInteraction('validName');
        await handleJavaWhitelistSubmit(interaction);

        expect(opsSend).not.toHaveBeenCalled();
        expect(interaction.reply).toHaveBeenCalledTimes(1);
        const reply = interaction.reply.mock.calls[0][0];
        expect(reply.ephemeral).toBe(true);
    });

    it('still replies to the user even if the ops post fails', async () => {
        opsSend.mockRejectedValueOnce(new Error('channel gone'));
        const interaction = makeInteraction('validName');
        await handleJavaWhitelistSubmit(interaction);

        expect(interaction.reply).toHaveBeenCalledTimes(1);
    });
});
