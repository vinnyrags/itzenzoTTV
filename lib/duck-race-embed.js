/**
 * Persistent #duck-race roster embed.
 *
 * Mirrors the `updateQueueChannelEmbed` pattern (commands/queue.js):
 *   - One embed message per session, edited in place as the roster fills.
 *   - Message ID persisted on `wp_queue_sessions.duck_race_channel_message_id`
 *     so the embed survives bot restarts.
 *   - On status transitions (open → racing → complete) the embed
 *     reflects the new state.
 *
 * Wired into server.js's /webhooks/queue-changed handler — every
 * roster.updated and session.updated event from WP triggers a refresh,
 * so the embed stays in sync with the website's Live Queue + Duck Race
 * panels without any operator action.
 *
 * Falls back to noop when CHANNELS.DUCK_RACE is unset (dev environment
 * without the channel configured) — does NOT post anything to #queue
 * as a fallback. The previous in-#queue roster footer is replaced by
 * a small pointer line in the queue embed itself.
 */

import { EmbedBuilder } from 'discord.js';
import { getChannel } from '../discord.js';
import * as queueSource from './queue-source.js';

const COLOR_OPEN = 0xceff00;       // accent — same as open queue embed
const COLOR_RACING = 0xfaa61a;     // amber — race in progress
const COLOR_COMPLETE = 0xffd700;   // gold — winner declared
const COLOR_CLOSED = 0xe74c3c;     // muted red

/**
 * Format a buyer display key for embed text. Three shapes the WP-side
 * uniqueBuyers() returns:
 *   - all digits      → <@id> Discord mention
 *   - contains '@'    → email, render as-is
 *   - otherwise       → @handle (Discord username without OAuth link)
 */
function formatBuyerLabel(buyer) {
    if (/^\d+$/.test(buyer)) return `<@${buyer}>`;
    if (buyer.includes('@')) return buyer;
    return `@${buyer}`;
}

function buildEmbed(queue, roster, winnerId) {
    const status = winnerId ? 'complete' : queue.status;
    const color = status === 'open'
        ? COLOR_OPEN
        : status === 'racing'
            ? COLOR_RACING
            : status === 'complete'
                ? COLOR_COMPLETE
                : COLOR_CLOSED;

    const statusText = status === 'open'
        ? '🟢 OPEN — Every product purchase enters you (1 entry per buyer)'
        : status === 'racing'
            ? '🏁 RACE IN PROGRESS'
            : status === 'complete'
                ? `🏆 COMPLETE — Winner: ${formatBuyerLabel(winnerId)}`
                : '🔴 CLOSED';

    let body;
    if (!roster.length) {
        body = '_No entries yet — be the first to buy a product tonight to claim your duck._';
    } else {
        const lines = roster.map((b, i) => `${i + 1}. ${formatBuyerLabel(b.buyer)}`);
        body = lines.join('\n');
    }

    return new EmbedBuilder()
        .setTitle(`🦆 Duck Race — Queue #${queue.id}`)
        .setDescription(`${statusText}\n\n${body}`)
        .setColor(color)
        .setFooter({
            text: roster.length
                ? `${roster.length} entr${roster.length === 1 ? 'y' : 'ies'} · One per buyer regardless of items purchased`
                : 'Race runs at end of stream when /offline → /duckrace start fires',
        });
}

/**
 * Refresh the persistent #duck-race embed for the given session. Called
 * from server.js's /webhooks/queue-changed handler on every
 * roster.updated and session.updated event affecting this session.
 *
 * Edit-in-place when a message ID is already known; otherwise post a
 * fresh message and persist its ID via setDuckRaceChannelMessage.
 *
 * Errors are logged and swallowed — a failed embed refresh shouldn't
 * cascade into the SSE broadcast or the WP write that triggered it.
 */
export async function updateDuckRaceEmbed(queueId) {
    try {
        const queue = await queueSource.getQueueById(queueId);
        if (!queue) return;

        const channel = getChannel('DUCK_RACE');
        if (!channel) return;  // env var unset — silent noop

        const roster = await queueSource.getUniqueBuyers(queue.id);
        const embed = buildEmbed(queue, roster, queue.duck_race_winner_id);

        const existingMessageId = queue.duck_race_channel_message_id;
        if (existingMessageId) {
            try {
                const msg = await channel.messages.fetch(existingMessageId);
                await msg.edit({ embeds: [embed] });
                return;
            } catch {
                // Message was deleted — fall through to post a fresh one.
            }
        }

        const msg = await channel.send({ embeds: [embed] });
        await queueSource.setDuckRaceChannelMessage(msg.id, queue.id);
    } catch (e) {
        console.error('updateDuckRaceEmbed failed:', e.message);
    }
}
