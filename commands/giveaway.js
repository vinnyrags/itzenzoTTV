/**
 * Giveaway System
 *
 * !giveaway start "Prize Name" [duration] [social] [url]  — Start a giveaway
 * !giveaway status                                        — Show current giveaway
 * !giveaway close                                         — Close entries
 * Winners drawn exclusively via !spin giveaway or !spin giveaway pick @user
 * !giveaway cancel                                        — Cancel and notify
 * !giveaway test <count>                                  — Create test giveaway with fake entries (owner)
 * !giveaway test clean                                    — Remove test giveaways (owner)
 * !giveaway test off                                      — Disable test mode (owner)
 *
 * Standard giveaways: button click to enter (Xipe required).
 * Social giveaways: button click shows TikTok username modal, entry requires
 * social engagement (like + comment + tag 3 on the linked post).
 */

import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import config from '../config.js';
import { db, giveaways } from '../db.js';
import { sendToChannel, sendEmbed, getMember, addRole, getChannel } from '../discord.js';

const DISCORD_INVITE = 'https://discord.gg/EXqX685TTq';

// =========================================================================
// Test mode — routes giveaway/announcement channels to #ops
// =========================================================================

let testMode = false;

function giveawayChannel() {
    return testMode ? 'OPS' : 'GIVEAWAYS';
}

function announcementChannel() {
    return testMode ? 'OPS' : 'ANNOUNCEMENTS';
}

function isTestMode() {
    return testMode;
}

function setTestMode(on) {
    testMode = on;
}

/**
 * Format a JS Date as SQLite datetime string (YYYY-MM-DD HH:MM:SS).
 */
function toSqliteDatetime(date) {
    return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// =========================================================================
// Duration parsing
// =========================================================================

function parseDuration(str) {
    const match = str.match(/^(\d+)\s*(h|hr|hrs|hours?|d|days?|w|weeks?)$/i);
    if (!match) return null;
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('h')) return num * 60 * 60 * 1000;
    if (unit.startsWith('d')) return num * 24 * 60 * 60 * 1000;
    if (unit.startsWith('w')) return num * 7 * 24 * 60 * 60 * 1000;
    return null;
}

function formatTimeRemaining(endsAt) {
    const ms = new Date(endsAt).getTime() - Date.now();
    if (ms <= 0) return 'Ended';
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        return `${days}d ${remainingHours}h`;
    }
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// =========================================================================
// Auto-close timer
// =========================================================================

let closeTimer = null;

function scheduleClose(giveaway) {
    cancelCloseTimer();
    if (!giveaway.ends_at) return;

    const ms = new Date(giveaway.ends_at).getTime() - Date.now();
    if (ms <= 0) {
        closeGiveaway(giveaway.id);
        return;
    }

    closeTimer = setTimeout(() => closeGiveaway(giveaway.id), ms);
}

function cancelCloseTimer() {
    if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
    }
}

async function closeGiveaway(giveawayId) {
    const giveaway = giveaways.getById.get(giveawayId);
    if (!giveaway || giveaway.status !== 'open') return;

    giveaways.close.run(giveawayId);
    const entryCount = giveaways.getEntryCount.get(giveawayId).count;

    // Update the original giveaway embed (removes button, shows CLOSED)
    await updateGiveawayEmbed(giveaway);

    // Update announcements
    await sendEmbed(announcementChannel(), {
        title: `\uD83D\uDD34 Giveaway Closed \u2014 ${giveaway.prize_name}`,
        description: `Entries are closed! **${entryCount}** entered. Winner will be drawn on stream.`,
        color: 0xe74c3c,
    });
}

// =========================================================================
// Embed builders
// =========================================================================

function buildGiveawayEmbed(giveaway) {
    const entryCount = giveaways.getEntryCount.get(giveaway.id).count;
    const entries = giveaways.getEntries.all(giveaway.id);
    const isOpen = giveaway.status === 'open';
    const isClosed = giveaway.status === 'closed';
    const isComplete = giveaway.status === 'complete';
    const isCancelled = giveaway.status === 'cancelled';
    const isSocial = !!giveaway.is_social;

    let statusText = '\uD83D\uDFE2 OPEN';
    let color = 0xceff00;
    if (isClosed) { statusText = '\uD83D\uDD34 CLOSED \u2014 Winner to be drawn on stream'; color = 0xe74c3c; }
    if (isComplete) { statusText = `\uD83C\uDFC6 COMPLETE \u2014 Winner: <@${giveaway.winner_id}>`; color = 0xffd700; }
    if (isCancelled) { statusText = '\u274C CANCELLED'; color = 0x95a5a6; }

    const lines = [statusText, ''];

    if (isOpen && isSocial) {
        const postLink = giveaway.social_link
            ? `[TikTok post](${giveaway.social_link})`
            : 'the TikTok post';
        lines.push(
            '**How to enter:**',
            `1. Like, comment, and tag 3 friends on ${postLink}`,
            '2. Click the **Enter Giveaway** button below',
            ''
        );
    } else if (isOpen) {
        lines.push('Click the **Enter Giveaway** button below to enter.', '');
    }

    if (isOpen && giveaway.ends_at) {
        lines.push(`\u23F0 **Ends:** ${formatTimeRemaining(giveaway.ends_at)}`);
    }
    lines.push(`\uD83C\uDF9F\uFE0F **Entries:** ${entryCount}`);

    if (isOpen) {
        lines.push('', '*Must be verified (Xipe role).*');
    }

    // Show entry roster — capped for scale
    if (entries.length > 0 && entries.length <= 20) {
        // Small giveaway: show full roster
        lines.push('');
        const roster = entries.map((e, i) => {
            const label = `<@${e.discord_user_id}>`;
            const tiktok = e.tiktok_username ? ` (@${e.tiktok_username})` : '';
            return `${i + 1}. ${label}${tiktok}`;
        }).join('\n');
        lines.push(roster);
    } else if (entries.length > 20) {
        // Large giveaway: count + last 5 entries
        lines.push('');
        const recent = entries.slice(-5).map((e) => {
            const label = `<@${e.discord_user_id}>`;
            const tiktok = e.tiktok_username ? ` (@${e.tiktok_username})` : '';
            return label + tiktok;
        });
        lines.push(`Latest entries: ${recent.join(', ')}`);
    }

    const embed = new EmbedBuilder()
        .setTitle(`\uD83C\uDF81 Giveaway \u2014 ${giveaway.prize_name}`)
        .setDescription(lines.join('\n'))
        .setColor(color)
        .setFooter({ text: `Giveaway #${giveaway.id}` });

    return embed;
}

function buildGiveawayButton(giveawayId) {
    const button = new ButtonBuilder()
        .setCustomId(`giveaway-enter-${giveawayId}`)
        .setLabel('Enter Giveaway')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('\uD83C\uDF81');

    return new ActionRowBuilder().addComponents(button);
}

async function updateGiveawayEmbed(giveaway) {
    if (!giveaway.channel_message_id) return;

    try {
        const channel = getChannel(giveawayChannel());
        if (!channel) return;
        const msg = await channel.messages.fetch(giveaway.channel_message_id);
        const updated = giveaways.getById.get(giveaway.id);
        const embed = buildGiveawayEmbed(updated);

        const editPayload = { embeds: [embed] };
        if (updated.status !== 'open') {
            editPayload.components = [];
        }
        await msg.edit(editPayload);
    } catch (e) {
        console.error('Failed to update giveaway embed:', e.message);
    }
}

// =========================================================================
// Command handler
// =========================================================================

async function handleGiveaway(message, args) {
    const subcommand = args[0]?.toLowerCase();

    if (subcommand === 'status') {
        return showStatus(message);
    }

    const isAdmin = message.member.roles.cache.has(config.ROLES.NANOOK)
        || message.member.roles.cache.has(config.ROLES.AKIVILI);
    const isOwner = message.member.roles.cache.has(config.ROLES.AKIVILI);

    if (!isAdmin) {
        return message.reply('Only moderators can manage giveaways.');
    }

    switch (subcommand) {
        case 'start':
            return startGiveaway(message, args.slice(1));
        case 'close':
            return closeGiveawayCommand(message);
        case 'cancel':
            return cancelGiveaway(message);
        case 'test':
            if (!isOwner) return message.reply('Owner only.');
            return handleTest(message, args.slice(1));
        default:
            return message.reply('Usage: `!giveaway start "Prize" [24h] [social] [url]`, `!giveaway close`, `!giveaway cancel` — use `!spin giveaway` to draw a winner');
    }
}

// =========================================================================
// Subcommands
// =========================================================================

async function startGiveaway(message, args) {
    const existing = giveaways.getActive.get();
    if (existing) {
        return message.reply(`A giveaway is already active: **${existing.prize_name}** (#${existing.id}). Close or cancel it first.`);
    }

    // Parse: "Prize Name" [duration] [social] [url]
    const joined = args.join(' ');
    const quoteMatch = joined.match(/^["\u201C](.+?)["\u201D]\s*(.*)?$/);
    if (!quoteMatch) {
        return message.reply('Usage: `!giveaway start "Prize Name" [24h] [social] [tiktok-url]`\nPrize name must be in quotes.');
    }

    const prizeName = quoteMatch[1];
    const remaining = quoteMatch[2]?.trim() || '';
    const tokens = remaining.split(/\s+/).filter(Boolean);

    let endsAt = null;
    let isSocial = false;
    let socialLink = null;

    for (const token of tokens) {
        if (token.toLowerCase() === 'social') {
            isSocial = true;
        } else if (token.startsWith('http')) {
            socialLink = token;
        } else {
            const durationMs = parseDuration(token);
            if (durationMs) {
                endsAt = toSqliteDatetime(new Date(Date.now() + durationMs));
            }
        }
    }

    // Create in DB
    const result = giveaways.create.run(prizeName, endsAt, isSocial ? 1 : 0, socialLink);
    const giveawayId = result.lastInsertRowid;
    const giveaway = giveaways.getById.get(giveawayId);

    // Post embed to #giveaways with button
    const embed = buildGiveawayEmbed(giveaway);
    const row = buildGiveawayButton(giveawayId);
    const giveawayMsg = await sendToChannel(giveawayChannel(), { embeds: [embed], components: [row] });

    if (giveawayMsg) {
        giveaways.setMessageId.run(giveawayMsg.id, giveawayId);
    }

    // Cross-post teaser to #announcements
    const targetGiveawayChannel = config.CHANNELS[giveawayChannel()];
    const durationText = endsAt ? ` Ends in **${formatTimeRemaining(endsAt)}**.` : '';
    const socialText = isSocial ? ' Complete the social engagement and ' : ' ';
    await sendEmbed(announcementChannel(), {
        title: `\uD83C\uDF81 Giveaway \u2014 ${prizeName}`,
        description: `We're giving away **${prizeName}**!${durationText}\n\n${socialText}Head to <#${targetGiveawayChannel}> and click **Enter Giveaway** to enter. Must be verified.`,
        color: 0xceff00,
    });

    // Post social copy to #ops
    const socialCopy = [
        `\uD83D\uDCCB **Social Copy for Giveaway #${giveawayId}:**`,
        '```',
        `\uD83C\uDF81 GIVEAWAY \u2014 ${prizeName}!`,
        '',
        isSocial
            ? 'How to enter:\n1. Like this post\n2. Comment + tag 3 friends\n3. Join our Discord and click Enter Giveaway'
            : 'Want a chance to win? Join our Discord and click Enter Giveaway!',
        '',
        `\uD83D\uDC49 ${DISCORD_INVITE}`,
        `${durationText ? `\n\u23F0 ${durationText}` : ''}`,
        '```',
    ].join('\n');
    await sendToChannel('OPS', socialCopy);

    // Schedule auto-close if duration set
    if (endsAt) {
        scheduleClose(giveaway);
    }

    const typeLabel = isSocial ? 'Social giveaway' : 'Giveaway';
    await message.channel.send(
        `\uD83C\uDF81 **${typeLabel} #${giveawayId} started: ${prizeName}**\n` +
        `\u2022 Posted to <#${targetGiveawayChannel}> with Enter Giveaway button\n` +
        `\u2022 Teaser posted to ${testMode ? '#ops' : '#announcements'}\n` +
        `\u2022 Social copy posted to #ops` +
        (endsAt ? `\n\u2022 Auto-closes in ${formatTimeRemaining(endsAt)}` : '') +
        (socialLink ? `\n\u2022 TikTok: ${socialLink}` : '') +
        (testMode ? '\n\u2022 **TEST MODE — all messages routing to #ops**' : '')
    );
}

async function showStatus(message) {
    const giveaway = giveaways.getActive.get();
    if (!giveaway) {
        return message.reply('No active giveaway.');
    }

    const embed = buildGiveawayEmbed(giveaway);
    await message.channel.send({ embeds: [embed] });
}

async function closeGiveawayCommand(message) {
    const giveaway = giveaways.getActive.get();
    if (!giveaway) {
        return message.reply('No active giveaway to close.');
    }

    cancelCloseTimer();
    await closeGiveaway(giveaway.id);

    const entryCount = giveaways.getEntryCount.get(giveaway.id).count;
    await message.channel.send(`\uD83D\uDD34 **Giveaway #${giveaway.id} closed.** ${entryCount} entries. Use \`!spin giveaway\` to draw a winner.`);
}

async function drawWinner(message, args) {
    const active = giveaways.getActive.get();
    if (active) {
        return message.reply('Giveaway is still open. Run `!giveaway close` first.');
    }

    const giveaway = db.prepare(
        `SELECT * FROM giveaways WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 1`
    ).get();

    if (!giveaway) {
        return message.reply('No closed giveaway to draw from.');
    }

    const entries = giveaways.getEntries.all(giveaway.id);
    if (entries.length === 0) {
        return message.reply('No entries in this giveaway. Nothing to draw.');
    }

    const mode = args[0]?.toLowerCase();

    if (mode === 'duckrace') {
        // Cap at 50 for embed display
        const displayEntries = entries.slice(0, 50);
        const roster = displayEntries.map((e, i) => {
            const tiktok = e.tiktok_username ? ` (@${e.tiktok_username})` : '';
            return `${i + 1}. <@${e.discord_user_id}>${tiktok}`;
        }).join('\n');
        const overflow = entries.length > 50 ? `\n\n*...and ${entries.length - 50} more*` : '';
        const embed = new EmbedBuilder()
            .setTitle(`\uD83E\uDD86 Duck Race Roster \u2014 ${giveaway.prize_name}`)
            .setDescription(`${entries.length} entrants loaded from Giveaway #${giveaway.id}:\n\n${roster}${overflow}`)
            .setColor(0xceff00)
            .setFooter({ text: 'Use !spin giveaway to draw a winner.' });

        await message.channel.send({ embeds: [embed] });
        return;
    }

    // Random draw (instant, no animation)
    const winner = entries[Math.floor(Math.random() * entries.length)];

    giveaways.setWinner.run(winner.discord_user_id, giveaway.id);

    const member = await getMember(winner.discord_user_id);
    if (member) {
        await addRole(member, config.ROLES.AHA);
    }

    await updateGiveawayEmbed(giveaway);

    const tiktokNote = winner.tiktok_username ? ` (TikTok: @${winner.tiktok_username})` : '';

    await sendEmbed(giveawayChannel(), {
        title: `\uD83C\uDFC6 Giveaway Winner \u2014 ${giveaway.prize_name}`,
        description: `Congratulations <@${winner.discord_user_id}>!${tiktokNote} \uD83C\uDF89\n\nYou've won **${giveaway.prize_name}**!`,
        color: 0xffd700,
    });

    await sendEmbed(announcementChannel(), {
        title: `\uD83C\uDFC6 Giveaway Winner \u2014 ${giveaway.prize_name}`,
        description: `<@${winner.discord_user_id}> just won **${giveaway.prize_name}**! \uD83C\uDF89`,
        color: 0xffd700,
    });

    await message.channel.send(
        `\uD83C\uDFC6 **<@${winner.discord_user_id}>${tiktokNote} wins ${giveaway.prize_name}!**\n` +
        `\u2022 Aha role assigned\n` +
        `\u2022 Announced in ${testMode ? '#ops' : '#giveaways and #announcements'}`
    );
}

async function cancelGiveaway(message) {
    const giveaway = giveaways.getActive.get();
    if (!giveaway) {
        return message.reply('No active giveaway to cancel.');
    }

    cancelCloseTimer();
    giveaways.cancel.run(giveaway.id);

    await updateGiveawayEmbed(giveaway);

    await sendEmbed(giveawayChannel(), {
        title: `\u274C Giveaway Cancelled \u2014 ${giveaway.prize_name}`,
        description: 'This giveaway has been cancelled.',
        color: 0x95a5a6,
    });

    await message.channel.send(`\u274C **Giveaway #${giveaway.id} cancelled.**`);
}

// =========================================================================
// Test mode commands
// =========================================================================

async function handleTest(message, args) {
    const sub = args[0]?.toLowerCase();

    if (sub === 'clean') {
        const testGiveaways = db.prepare("SELECT id FROM giveaways WHERE prize_name LIKE 'TEST%'").all();
        for (const g of testGiveaways) {
            db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id = ?').run(g.id);
            db.prepare('DELETE FROM giveaways WHERE id = ?').run(g.id);
        }
        testMode = false;
        return message.channel.send(`\uD83E\uDDF9 Cleaned ${testGiveaways.length} test giveaways. Test mode off.`);
    }

    if (sub === 'off') {
        testMode = false;
        return message.channel.send('\uD83D\uDFE2 Test mode off. Giveaway messages will route to public channels.');
    }

    const count = parseInt(sub) || 100;

    // Enable test mode
    testMode = true;

    // Create a closed giveaway with fake entries
    const result = giveaways.create.run(`TEST GIVEAWAY (${count} entries)`, null, 1, 'https://tiktok.com/@test');
    const giveawayId = result.lastInsertRowid;
    giveaways.close.run(giveawayId);

    // Insert fake entries in a transaction for speed
    const insert = db.prepare(
        'INSERT OR IGNORE INTO giveaway_entries (giveaway_id, discord_user_id, tiktok_username) VALUES (?, ?, ?)'
    );
    const insertMany = db.transaction((entries) => {
        for (const e of entries) insert.run(...e);
    });

    // Inject the test account as a real entry that can be @mentioned and picked
    const TEST_ACCOUNT_ID = '1490206350943191052'; // @rhapttv
    const fakeEntries = [
        [giveawayId, TEST_ACCOUNT_ID, 'rhapttv'],
        ...Array.from({ length: count - 1 }, (_, i) => [
            giveawayId,
            `fake_${String(i).padStart(5, '0')}`,
            `tiktok_user_${i}`,
        ]),
    ];
    insertMany(fakeEntries);

    // Post the giveaway embed to #ops
    const giveaway = giveaways.getById.get(giveawayId);
    const embed = buildGiveawayEmbed(giveaway);
    const giveawayMsg = await sendToChannel('OPS', { embeds: [embed] });
    if (giveawayMsg) {
        giveaways.setMessageId.run(giveawayMsg.id, giveawayId);
    }

    await message.channel.send(
        `\uD83E\uDDEA **Test giveaway #${giveawayId} created** with ${count.toLocaleString()} entries.\n` +
        `\u2022 Test mode ON \u2014 all messages routing to #ops\n` +
        `\u2022 Embed posted to #ops\n` +
        `\u2022 <@${TEST_ACCOUNT_ID}> (rhapttv) injected as a real entry for pick testing\n` +
        `\u2022 Run \`!spin giveaway\` or \`!spin giveaway pick @rhapttv\` to test\n` +
        `\u2022 Run \`!giveaway test clean\` when done`
    );
}

// =========================================================================
// Button handler — called from interactions.js
// =========================================================================

async function handleGiveawayEntry(interaction, giveawayId, tiktokUsername = null) {
    const giveaway = giveaways.getById.get(giveawayId);
    if (!giveaway || giveaway.status !== 'open') {
        return interaction.reply({ content: 'This giveaway is no longer open.', ephemeral: true });
    }

    // Verify Xipe role
    const member = await getMember(interaction.user.id);
    if (!member || !member.roles.cache.has(config.ROLES.XIPE)) {
        return interaction.reply({ content: 'You need to be verified (Xipe role) to enter giveaways. Head to #verify first!', ephemeral: true });
    }

    // Atomic entry — INSERT OR IGNORE handles duplicates via UNIQUE constraint
    const result = giveaways.addEntry.run(giveaway.id, interaction.user.id, tiktokUsername || null);

    if (result.changes === 0) {
        // Already entered (UNIQUE constraint rejected the duplicate)
        const entry = giveaways.getEntryByUser.get(giveaway.id, interaction.user.id);
        const entryCount = giveaways.getEntryCount.get(giveaway.id).count;
        const tiktok = entry?.tiktok_username ? ` as @${entry.tiktok_username}` : '';
        return interaction.reply({
            content: `\u2705 You're already entered${tiktok}! You're one of ${entryCount.toLocaleString()} entries. Good luck! \uD83C\uDF40`,
            ephemeral: true,
        });
    }

    // Throttle embed updates — first 5, then every 10th
    const entryCount = giveaways.getEntryCount.get(giveaway.id).count;
    if (entryCount <= 5 || entryCount % 10 === 0) {
        await updateGiveawayEmbed(giveaway);
    }

    const confirmText = tiktokUsername
        ? `You're in! \uD83C\uDF81 Entry recorded as @${tiktokUsername}. Entry #${entryCount.toLocaleString()}. Good luck!`
        : `You're in! \uD83C\uDF81 Entry #${entryCount.toLocaleString()}. Good luck!`;

    return interaction.reply({ content: confirmText, ephemeral: true });
}

// =========================================================================
// Startup
// =========================================================================

function initGiveaways() {
    const expired = giveaways.getExpired.all();
    for (const g of expired) {
        closeGiveaway(g.id);
    }

    const active = giveaways.getActive.get();
    if (active?.ends_at) {
        scheduleClose(active);
    }
}

export {
    handleGiveaway,
    handleGiveawayEntry,
    initGiveaways,
    updateGiveawayEmbed,
    giveawayChannel,
    announcementChannel,
    isTestMode,
    setTestMode,
};
