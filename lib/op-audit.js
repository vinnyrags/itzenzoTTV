/**
 * Ops audit logger — durable trace of every slash-command invocation.
 *
 * Posts a structured embed to #ops-log so the operator (and future-self)
 * can answer "what did I run during the last stream?" or "when was reset
 * last fired?" without scrolling through chat.
 *
 * Three states per command:
 *   logStarted   — invocation began, args captured
 *   logCompleted — finished cleanly with optional result detail
 *   logFailed    — threw or returned an error
 *
 * Each entry is a self-contained embed with operator id, timestamp, and
 * argument summary. Embeds are sequential (one per state), so a reset can
 * land as: started → completed (or failed). For long-running commands
 * (e.g. !sync, !reset) this gives a heartbeat trace.
 */

import { EmbedBuilder } from 'discord.js';
import { getChannel } from '../discord.js';

const COLOR_RUN = 0x3498db; // blue
const COLOR_OK = 0x2ecc71; // green
const COLOR_FAIL = 0xe74c3c; // red

function fmtArgs(args) {
    if (!args) return '';
    if (Array.isArray(args)) return args.length ? args.join(' ') : '(none)';
    if (typeof args === 'object') {
        const pairs = Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
        return pairs.length ? pairs.join(', ') : '(none)';
    }
    return String(args);
}

async function postToOpsLog(embed) {
    const ch = getChannel('OPS_LOG');
    if (!ch) {
        console.warn('[op-audit] OPS_LOG channel unavailable — skipping audit entry');
        return;
    }
    try {
        return await ch.send({ embeds: [embed] });
    } catch (e) {
        console.error('[op-audit] failed to post audit entry:', e.message);
    }
}

export async function logStarted({ command, args, operatorId, operatorTag }) {
    const embed = new EmbedBuilder()
        .setColor(COLOR_RUN)
        .setTitle(`▶ /${command}`)
        .setDescription(`<@${operatorId}> (${operatorTag})\n\`\`\`${fmtArgs(args)}\`\`\``)
        .setTimestamp();
    return postToOpsLog(embed);
}

export async function logCompleted({ command, args, operatorId, operatorTag, summary, durationMs }) {
    const embed = new EmbedBuilder()
        .setColor(COLOR_OK)
        .setTitle(`✓ /${command}`)
        .setDescription(`<@${operatorId}> (${operatorTag})\n\`\`\`${fmtArgs(args)}\`\`\`${summary ? '\n' + summary : ''}`)
        .setFooter({ text: durationMs ? `${Math.round(durationMs)}ms` : '' })
        .setTimestamp();
    return postToOpsLog(embed);
}

export async function logFailed({ command, args, operatorId, operatorTag, error, durationMs }) {
    const message = error instanceof Error ? error.message : String(error);
    const embed = new EmbedBuilder()
        .setColor(COLOR_FAIL)
        .setTitle(`✗ /${command}`)
        .setDescription(`<@${operatorId}> (${operatorTag})\n\`\`\`${fmtArgs(args)}\`\`\`\n**Error:** \`${message}\``)
        .setFooter({ text: durationMs ? `${Math.round(durationMs)}ms` : '' })
        .setTimestamp();
    return postToOpsLog(embed);
}

/**
 * Wrap an async handler so audit logging happens automatically. Returns
 * an async function with the same signature; logs started + completed/failed
 * around the wrapped call.
 *
 *   const audited = withAudit('queue', handleQueueSlash);
 *   await audited(interaction, args);
 */
export function withAudit(command, handler) {
    return async (interaction, args) => {
        const operatorId = interaction.user.id;
        const operatorTag = interaction.user.tag || interaction.user.username;
        const started = Date.now();
        await logStarted({ command, args, operatorId, operatorTag });
        try {
            const result = await handler(interaction, args);
            await logCompleted({
                command,
                args,
                operatorId,
                operatorTag,
                summary: typeof result === 'string' ? result : null,
                durationMs: Date.now() - started,
            });
            return result;
        } catch (e) {
            await logFailed({
                command,
                args,
                operatorId,
                operatorTag,
                error: e,
                durationMs: Date.now() - started,
            });
            throw e;
        }
    };
}
