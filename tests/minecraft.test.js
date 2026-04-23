/**
 * Tests for the Minecraft react-for-DM module — emoji map, invite lookup,
 * and the reaction handler's guards (bot user, wrong message, wrong emoji,
 * missing invite env var).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
    default: {
        CHANNELS: { MINECRAFT: 'mc_channel_id' },
        MINECRAFT_INVITES: {
            java: 'Server IP: java.example.com — DM Vincent your username for whitelist.',
            bedrock_horror: 'Realm code: HORROR-1234',
            bedrock_creative: null, // intentionally unconfigured
        },
    },
}));

const dmSend = vi.fn().mockResolvedValue(null);
const createDM = vi.fn().mockResolvedValue({ send: dmSend });
const getMember = vi.fn().mockResolvedValue({ createDM });
const getChannel = vi.fn();

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
    getInviteForRealm,
    handleMinecraftReaction,
    buildMinecraftEmbed,
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
    it('returns the configured Java invite', () => {
        expect(getInviteForRealm('java')).toMatch(/java\.example\.com/);
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
// Embed
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

// =========================================================================
// handleMinecraftReaction guards
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

    it('DMs the Java invite when 🪓 is reacted', async () => {
        const reaction = makeReaction('🪓');
        await handleMinecraftReaction(reaction, makeUser());

        expect(getMember).toHaveBeenCalledWith('user_123');
        expect(createDM).toHaveBeenCalled();
        expect(dmSend).toHaveBeenCalledTimes(1);
        const payload = dmSend.mock.calls[0][0];
        const embedJson = payload.embeds[0].toJSON();
        expect(embedJson.description).toMatch(/java\.example\.com/);
        expect(reaction.users.remove).toHaveBeenCalledWith('user_123');
    });

    it('DMs the Bedrock Horror code when 👻 is reacted', async () => {
        const reaction = makeReaction('👻');
        await handleMinecraftReaction(reaction, makeUser());

        const payload = dmSend.mock.calls[0][0];
        const embedJson = payload.embeds[0].toJSON();
        expect(embedJson.description).toBe('Realm code: HORROR-1234');
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
        // Reaction still removed so the embed stays clean
        expect(reaction.users.remove).toHaveBeenCalled();
    });

    it('does not throw when DM send fails (user has DMs closed)', async () => {
        dmSend.mockRejectedValueOnce(new Error('Cannot send messages to this user'));
        const reaction = makeReaction('🪓');
        await expect(handleMinecraftReaction(reaction, makeUser())).resolves.toBeUndefined();
        // Reaction still removed
        expect(reaction.users.remove).toHaveBeenCalled();
    });
});
