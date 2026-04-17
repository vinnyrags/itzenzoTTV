/**
 * Queue & Duck Race System
 *
 * Commands:
 *   !queue              — Show current queue
 *   !queue open         — Open a new queue (mods)
 *   !queue close        — Close the queue (mods)
 *   !queue history      — Show recent queues with winners
 *   !duckrace           — Show duck race roster (unique buyers from queue)
 *   !duckrace start     — Run animated duck race in #queue (mods)
 *   !duckrace pick @u   — Pre-select winner, then run race (owner only)
 *   !duckrace winner @u — Manual winner declaration, skip animation (mods)
 *
 * Queue entries are auto-added when card products are purchased via Stripe.
 * Each buyer gets exactly one duck race entry regardless of how many items.
 *
 * A persistent embed in #queue updates in real time on every purchase,
 * queue open/close, and duck race winner declaration.
 */

import { EmbedBuilder } from 'discord.js';
import config from '../config.js';
import { queues } from '../db.js';
import { client, getChannel, sendEmbed, getMember, addRole } from '../discord.js';

// =========================================================================
// Queue commands
// =========================================================================

async function handleQueue(message, args) {
    const subcommand = args[0]?.toLowerCase();

    const isAdmin = message.member.roles.cache.has(config.ROLES.NANOOK)
        || message.member.roles.cache.has(config.ROLES.AKIVILI);

    switch (subcommand) {
        case 'open':
            if (!isAdmin) return message.reply('Only moderators can open queues.');
            return openQueue(message);
        case 'close':
            if (!isAdmin) return message.reply('Only moderators can close queues.');
            return closeQueue(message);
        case 'history':
            return queueHistory(message);
        default:
            return showQueue(message);
    }
}

async function openQueue(message) {
    const active = queues.getActiveQueue.get();
    if (active) {
        return message.reply(`There's already an open queue (Queue #${active.id}). Close it first with \`!queue close\`.`);
    }

    const result = queues.createQueue.run();
    const queueId = result.lastInsertRowid;
    const queue = queues.getQueueById.get(queueId);

    // Post real-time embed to #queue channel
    await postQueueChannelEmbed(queue);

    const embed = new EmbedBuilder()
        .setTitle('📋 Queue Open!')
        .setDescription('Pre-orders are now being accepted. Every card product purchase is automatically added to the queue.\n\nEvery unique buyer gets one entry into tonight\'s duck race.')
        .setColor(0xceff00)
        .setFooter({ text: `Queue #${queueId}` });

    await message.channel.send({ embeds: [embed] });
}

async function closeQueue(message) {
    const active = queues.getActiveQueue.get();
    if (!active) {
        return message.reply('No open queue to close.');
    }

    queues.closeQueue.run(active.id);

    const entries = queues.getEntries.all(active.id);
    const uniqueBuyers = queues.getUniqueBuyers.all(active.id);
    const embed = buildQueueEmbed(active, entries, uniqueBuyers, 'closed');

    // Update #queue channel embed to closed state
    await updateQueueChannelEmbed(active.id);

    // Post in current channel
    await message.channel.send({ embeds: [embed] });
    await message.channel.send(`Queue #${active.id} closed. Run \`!duckrace\` to see the race roster.`);
}

async function showQueue(message) {
    const active = queues.getActiveQueue.get();
    if (!active) {
        return message.reply('No open queue right now. A mod can start one with `!queue open`.');
    }

    const entries = queues.getEntries.all(active.id);
    const uniqueBuyers = queues.getUniqueBuyers.all(active.id);
    const embed = buildQueueEmbed(active, entries, uniqueBuyers, 'open');

    await message.channel.send({ embeds: [embed] });
}

async function queueHistory(message) {
    const recent = queues.getRecentQueues.all(5);

    if (!recent.length) {
        return message.reply('No queue history yet.');
    }

    const lines = recent.map((q) => {
        const entries = queues.getEntries.all(q.id);
        const buyers = queues.getUniqueBuyers.all(q.id);
        const winner = q.duck_race_winner_id ? `<@${q.duck_race_winner_id}>` : 'No winner';
        return `**Queue #${q.id}** — ${entries.length} items, ${buyers.length} buyers • Duck race: ${winner} • ${q.created_at.slice(0, 10)}`;
    });

    const embed = new EmbedBuilder()
        .setTitle('📋 Recent Queues')
        .setDescription(lines.join('\n'))
        .setColor(0x3498db);

    await message.channel.send({ embeds: [embed] });
}

// =========================================================================
// Duck race commands
// =========================================================================

async function handleDuckRace(message, args) {
    const subcommand = args[0]?.toLowerCase();

    const isAdmin = message.member.roles.cache.has(config.ROLES.NANOOK)
        || message.member.roles.cache.has(config.ROLES.AKIVILI);
    const isOwner = message.member.roles.cache.has(config.ROLES.AKIVILI);

    if (subcommand === 'winner') {
        if (!isAdmin) return message.reply('Only moderators can declare duck race winners.');
        return declareDuckRaceWinner(message, args.slice(1));
    }

    if (subcommand === 'start') {
        if (!isAdmin) return message.reply('Only moderators can start the duck race.');
        return startDuckRace(message);
    }

    if (subcommand === 'pick') {
        if (!isOwner) return message.reply('Only the owner can use this command.');
        return pickDuckRace(message, args.slice(1));
    }

    return showDuckRace(message);
}

/**
 * Find the current raceable queue — active or most recent closed without a winner.
 */
function findRaceableQueue() {
    const active = queues.getActiveQueue.get();
    if (active) return active;
    const recent = queues.getRecentQueues.all(1);
    return recent.length && !recent[0].duck_race_winner_id ? recent[0] : null;
}

async function showDuckRace(message) {
    const queue = findRaceableQueue();
    if (!queue) {
        return message.reply('No active queue with a duck race roster.');
    }

    const uniqueBuyers = queues.getUniqueBuyers.all(queue.id);
    if (!uniqueBuyers.length) {
        return message.reply('No entries in the duck race yet — queue has no purchases.');
    }

    const roster = uniqueBuyers.map((b, i) => {
        const label = /^\d+$/.test(b.buyer) ? `<@${b.buyer}>` : b.buyer;
        return `${i + 1}. ${label}`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setTitle(`🦆 Duck Race — Queue #${queue.id}`)
        .setDescription(`**${uniqueBuyers.length} entries** (1 per buyer)\n\n${roster}`)
        .setColor(0xffd700)
        .setFooter({ text: 'Each buyer gets exactly one entry regardless of items purchased' });

    await message.channel.send({ embeds: [embed] });
}

// -------------------------------------------------------------------------
// Animated duck race
// -------------------------------------------------------------------------

async function startDuckRace(message) {
    return runAnimatedRace(message, null);
}

async function pickDuckRace(message, args) {
    const mentioned = message.mentions.users.first();
    if (!mentioned) {
        return message.reply('Usage: `!duckrace pick @user`');
    }

    // Delete the command message so the pick stays secret
    try { await message.delete(); } catch { /* may lack perms */ }

    return runAnimatedRace(message, mentioned.id);
}

async function runAnimatedRace(message, pickedWinnerId) {
    const queue = findRaceableQueue();
    if (!queue) {
        return message.reply('No queue found to run a duck race for.');
    }

    // Atomically claim the queue for racing — prevents double-start
    const claimed = queues.claimForRace.run(queue.id);
    if (claimed.changes === 0) {
        return message.reply('A duck race is already in progress!');
    }

    const uniqueBuyers = queues.getUniqueBuyers.all(queue.id);
    if (uniqueBuyers.length < 2) {
        // Release the claim — revert to closed
        queues.closeQueue.run(queue.id);
        return message.reply('Need at least 2 ducks for a race!');
    }

    // Validate picked winner is in roster
    if (pickedWinnerId) {
        const inRoster = uniqueBuyers.some((b) => b.buyer === pickedWinnerId);
        if (!inRoster) {
            queues.closeQueue.run(queue.id);
            return message.channel.send(`<@${pickedWinnerId}> is not in the duck race roster.`);
        }
        await message.channel.send(`🦆 Duck race picked. Starting race in <#${config.CHANNELS.QUEUE}>...`);
    }

    // Determine winner
    const winnerId = pickedWinnerId
        || uniqueBuyers[Math.floor(Math.random() * uniqueBuyers.length)].buyer;

    try {
        // Generate race frames
        const frames = generateRaceFrames(uniqueBuyers, winnerId, 5);

        // Post initial "starting" embed to #queue
        const queueChannel = getChannel('QUEUE');
        if (!queueChannel) {
            queues.closeQueue.run(queue.id);
            return message.reply('Cannot find #queue channel.');
        }

        const startEmbed = new EmbedBuilder()
            .setTitle(`🦆 Duck Race — Queue #${queue.id}`)
            .setDescription('**Race starting...**\n\nDucks are lining up!')
            .setColor(0xceff00);

        const raceMsg = await queueChannel.send({ embeds: [startEmbed] });

        // Animate frames with delays
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        for (let i = 0; i < frames.length; i++) {
            await delay(2500);
            const isLast = i === frames.length - 1;
            const embed = buildRaceEmbed(queue.id, frames[i], isLast, uniqueBuyers.length);
            await raceMsg.edit({ embeds: [embed] });
        }

        // Finalize — assign role, announcements, open next queue
        await finalizeDuckRace(queue.id, winnerId, uniqueBuyers.length, message);
    } catch (e) {
        // On error, revert queue status so it can be retried
        queues.closeQueue.run(queue.id);
        throw e;
    }
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateRaceFrames(ducks, winnerId, frameCount) {
    const trackLength = 20;
    const positions = ducks.map((d) => ({ id: d.buyer, progress: 0 }));
    const frames = [];

    for (let frame = 0; frame < frameCount; frame++) {
        const isLast = frame === frameCount - 1;

        for (const duck of positions) {
            if (isLast) {
                // Final frame: winner reaches the end, others fall short
                duck.progress = duck.id === winnerId
                    ? trackLength
                    : Math.min(trackLength - randomInt(1, 4), duck.progress + randomInt(2, 5));
            } else {
                // Intermediate: random advancement — anyone can lead
                duck.progress = Math.min(trackLength - 2, duck.progress + randomInt(2, 5));
            }
        }

        // Sort by progress descending for display
        const sorted = [...positions].sort((a, b) => b.progress - a.progress);
        frames.push(sorted.map((d) => ({ ...d })));
    }

    return frames;
}

function buildRaceEmbed(queueId, frame, isFinished, totalDucks) {
    const maxDisplay = 10;
    const displayFrame = frame.slice(0, maxDisplay);
    const overflow = totalDucks > maxDisplay ? totalDucks - maxDisplay : 0;

    const lines = displayFrame.map((duck, i) => {
        const label = /^\d+$/.test(duck.id) ? `<@${duck.id}>` : duck.id;
        const filled = '\u2593'.repeat(duck.progress);
        const empty = '\u2591'.repeat(20 - duck.progress);
        const prefix = isFinished && i === 0 ? '\uD83C\uDFC6' : '\uD83E\uDD86';
        let suffix = '';
        if (isFinished) {
            if (i === 0) suffix = ' \uD83E\uDD47';
            else if (i === 1) suffix = ' 2nd';
            else if (i === 2) suffix = ' 3rd';
            else suffix = ` ${i + 1}th`;
        }
        return `${prefix} ${label}\n\u2003${filled}${empty}${suffix}`;
    });

    if (overflow > 0) {
        lines.push(`\n*...and ${overflow} more ducks*`);
    }

    const winnerLabel = isFinished
        ? (/^\d+$/.test(frame[0].id) ? `<@${frame[0].id}>` : frame[0].id)
        : null;

    return new EmbedBuilder()
        .setTitle(`\uD83E\uDD86 Duck Race \u2014 Queue #${queueId}${isFinished ? ' \u2014 FINISHED!' : ''}`)
        .setDescription(lines.join('\n\n'))
        .setColor(isFinished ? 0xffd700 : 0xceff00)
        .setFooter({ text: isFinished ? `Winner: ${winnerLabel}` : 'Race in progress...' });
}

// -------------------------------------------------------------------------
// Shared finalization (used by animated race AND manual !duckrace winner)
// -------------------------------------------------------------------------

async function finalizeDuckRace(queueId, winnerId, entryCount, message) {
    queues.setDuckRaceWinner.run(winnerId, queueId);

    // Assign Aha role
    const member = await getMember(winnerId);
    if (member) {
        await addRole(member, config.ROLES.AHA);
    }

    // Update #queue channel embed with winner
    await updateQueueChannelEmbed(queueId);

    const entries = queues.getEntries.all(queueId);
    const winnerLabel = /^\d+$/.test(winnerId) ? `<@${winnerId}>` : winnerId;

    // Post winner in current channel (or #queue if command was deleted)
    const embed = new EmbedBuilder()
        .setTitle('\uD83E\uDD86 Duck Race Winner!')
        .setDescription(`${winnerLabel} wins the duck race for Queue #${queueId}!\n\n${entryCount} entries from ${entries.length} items purchased.`)
        .setColor(0xffd700);

    await message.channel.send({ embeds: [embed] });

    // Cross-post to announcements
    await sendEmbed('ANNOUNCEMENTS', {
        title: '\uD83E\uDD86 Duck Race Winner!',
        description: `${winnerLabel} wins tonight's duck race! Congrats!`,
        color: 0xffd700,
    });

    // Open next queue for pre-orders
    const newQueueResult = queues.createQueue.run();
    const newQueue = queues.getQueueById.get(newQueueResult.lastInsertRowid);
    await postQueueChannelEmbed(newQueue);

    await message.channel.send(`\uD83D\uDCCB Queue #${queueId} closed. Queue #${newQueue.id} opened for next stream.`);
}

// -------------------------------------------------------------------------
// Manual winner declaration (fallback, skips animation)
// -------------------------------------------------------------------------

async function declareDuckRaceWinner(message, args) {
    const mentioned = message.mentions.users.first();
    if (!mentioned) {
        return message.reply('Usage: `!duckrace winner @user`');
    }

    const queue = findRaceableQueue();
    if (!queue) {
        return message.reply('No queue found to assign a duck race winner to.');
    }

    // Verify winner is actually in the roster
    const uniqueBuyers = queues.getUniqueBuyers.all(queue.id);
    const isInRoster = uniqueBuyers.some((b) => b.buyer === mentioned.id);
    if (!isInRoster) {
        return message.reply(`<@${mentioned.id}> is not in the duck race roster for Queue #${queue.id}.`);
    }

    // Close the queue first if still open
    if (queue.status === 'open') {
        queues.closeQueue.run(queue.id);
    }

    await finalizeDuckRace(queue.id, mentioned.id, uniqueBuyers.length, message);
}

// =========================================================================
// Real-time #queue channel embed
// =========================================================================

/**
 * Post a new queue embed to #queue and store the message ID.
 */
async function postQueueChannelEmbed(queue) {
    try {
        const channel = getChannel('QUEUE');
        if (!channel) return;

        const entries = queues.getEntries.all(queue.id);
        const uniqueBuyers = queues.getUniqueBuyers.all(queue.id);
        const status = queue.duck_race_winner_id ? 'complete' : queue.status;
        const embed = buildQueueEmbed(queue, entries, uniqueBuyers, status);

        const msg = await channel.send({ embeds: [embed] });
        queues.setChannelMessage.run(msg.id, queue.id);
    } catch (e) {
        console.error('Failed to post queue channel embed:', e.message);
    }
}

/**
 * Update the existing #queue channel embed. Falls back to posting
 * a new message if the original was deleted.
 */
async function updateQueueChannelEmbed(queueId) {
    try {
        const queue = queues.getQueueById.get(queueId);
        if (!queue) return;

        const channel = getChannel('QUEUE');
        if (!channel) return;

        const entries = queues.getEntries.all(queue.id);
        const uniqueBuyers = queues.getUniqueBuyers.all(queue.id);
        const status = queue.duck_race_winner_id ? 'complete' : queue.status;
        const embed = buildQueueEmbed(queue, entries, uniqueBuyers, status);

        if (queue.channel_message_id) {
            try {
                const msg = await channel.messages.fetch(queue.channel_message_id);
                await msg.edit({ embeds: [embed] });
                return;
            } catch {
                // Message deleted — fall through to post a new one
            }
        }

        const msg = await channel.send({ embeds: [embed] });
        queues.setChannelMessage.run(msg.id, queue.id);
    } catch (e) {
        console.error('Failed to update queue channel embed:', e.message);
    }
}

// =========================================================================
// Helpers
// =========================================================================

function buildQueueDescription(entries, uniqueBuyers) {
    if (!entries.length) return 'No entries yet.';

    const lines = entries.map((entry, i) => {
        const key = entry.discord_user_id || entry.customer_email || 'Unknown';
        const label = key === 'Unknown' ? key : /^\d+$/.test(key) ? `<@${key}>` : key;
        const product = `${entry.product_name}${entry.quantity > 1 ? ` ×${entry.quantity}` : ''}`;
        return `${i + 1}. ${label} — ${product}`;
    });

    const roster = uniqueBuyers.map((b, i) => {
        const label = /^\d+$/.test(b.buyer) ? `<@${b.buyer}>` : b.buyer;
        return `${i + 1}. ${label}`;
    }).join('\n');

    return lines.join('\n') + `\n\n🦆 **Duck race roster (${uniqueBuyers.length}):**\n${roster}`;
}

function buildQueueEmbed(queue, entries, uniqueBuyers, status) {
    const statusText = status === 'open'
        ? '🟢 OPEN — Purchases are automatically added'
        : status === 'complete'
            ? `🏆 COMPLETE — Winner: <@${queue.duck_race_winner_id}>`
            : '🔴 CLOSED';

    const color = status === 'open' ? 0xceff00 : status === 'complete' ? 0xffd700 : 0xe74c3c;

    const embed = new EmbedBuilder()
        .setTitle(`📋 Queue #${queue.id}`)
        .setDescription(`${statusText}\n\n${buildQueueDescription(entries, uniqueBuyers)}`)
        .setColor(color)
        .setFooter({ text: `Queue #${queue.id} • Opened ${queue.created_at}` });

    return embed;
}

/**
 * Add a purchase to the active queue (called from Stripe webhook).
 * Returns true if added, false if no active queue.
 */
async function addToQueue(discordUserId, customerEmail, productName, quantity, stripeSessionId) {
    const active = queues.getActiveQueue.get();
    if (!active) return false;

    queues.addEntry.run(active.id, discordUserId, customerEmail, productName, quantity, stripeSessionId);

    // Update the real-time #queue channel embed
    await updateQueueChannelEmbed(active.id);

    return true;
}

export {
    handleQueue,
    handleDuckRace,
    addToQueue,
    postQueueChannelEmbed,
    updateQueueChannelEmbed,
};
