/**
 * Community Goals — tracks revenue toward the next restock.
 *
 * Every $2,500 in product revenue (shipping excluded) triggers a restock cycle.
 * Lifetime milestones every $5K reward the community with free loot.
 *
 * The pinned message in #restock-tracker is updated on every purchase.
 */

import { EmbedBuilder } from 'discord.js';
import { client, getChannel } from './discord.js';
import config from './config.js';
import { goals } from './db.js';
import { broadcastGoalCycleHit, broadcastGoalMilestone } from './lib/activity-broadcaster.js';

const CYCLE_GOAL = 250000; // $2,500 in cents
const MILESTONE_INCREMENT = 500000; // $5,000 in cents

/**
 * Build a text progress bar.
 * @param {number} percent 0-100
 * @param {number} length bar character count
 */
function progressBar(percent, length = 20) {
    const filled = Math.round((percent / 100) * length);
    return '█'.repeat(filled) + '░'.repeat(length - filled);
}

/**
 * Get the next lifetime milestone amount based on current revenue.
 * Milestones occur at every $5K: $5,000, $10,000, $15,000, etc.
 */
function getNextMilestone(lifetimeRevenue) {
    return Math.ceil((lifetimeRevenue + 1) / MILESTONE_INCREMENT) * MILESTONE_INCREMENT;
}

/**
 * Build the restock tracker embed.
 */
function buildGoalEmbed(goal) {
    const cycleRevenue = goal.cycle_revenue;
    const lifetimeRevenue = goal.lifetime_revenue;
    const cycle = goal.cycle;

    const percent = Math.min(Math.round((cycleRevenue / CYCLE_GOAL) * 100), 100);
    const cycleDollars = (cycleRevenue / 100).toFixed(2);
    const goalDollars = (CYCLE_GOAL / 100).toFixed(2);
    const lifetimeDollars = (lifetimeRevenue / 100).toFixed(2);
    const restocksCompleted = cycle - 1;

    const bar = progressBar(percent);

    const description = [
        `${bar} **${percent}%**`,
        `**$${cycleDollars}** / $${goalDollars}`,
        '',
        `Every $${goalDollars} in sales funds the next restock.`,
        'When we hit the goal, new product drops for everyone.',
    ].join('\n');

    const embed = new EmbedBuilder()
        .setTitle(`📊 Restock Goal — Cycle #${cycle}`)
        .setDescription(description)
        .setColor(0xceff00);

    // Lifetime stats
    const nextMilestone = getNextMilestone(lifetimeRevenue);
    const milestoneDollars = (nextMilestone / 100).toLocaleString('en-US');

    const lifetimeLines = [`💰 **$${lifetimeDollars}** lifetime revenue`];
    if (restocksCompleted > 0) {
        lifetimeLines.push(`📦 **${restocksCompleted}** restock${restocksCompleted !== 1 ? 's' : ''} funded by this community`);
    }
    lifetimeLines.push(`🎯 **Lifetime milestone: $${milestoneDollars}** — free loot for the community!`);

    embed.addFields({ name: 'Lifetime', value: lifetimeLines.join('\n') });
    embed.setFooter({ text: 'Updated live with every purchase' });

    return embed;
}

/**
 * Add revenue from a purchase and update the pinned message.
 * @param {number} amountCents Revenue in cents (shipping excluded)
 */
async function addRevenue(amountCents) {
    if (amountCents <= 0) return;

    // Check lifetime before update (for milestone detection)
    const before = goals.get.get();
    const lifetimeBefore = before.lifetime_revenue;

    // Update revenue
    goals.addRevenue.run(amountCents, amountCents);

    // Check if cycle goal was hit (possibly multiple times)
    let goal = goals.get.get();
    while (goal.cycle_revenue >= CYCLE_GOAL) {
        goals.resetCycle.run(CYCLE_GOAL);
        goal = goals.get.get();

        // Announce cycle completion
        await announceRestock(goal.cycle - 1);
    }

    // Check lifetime milestones (every $5K)
    const lifetimeAfter = goal.lifetime_revenue;
    const milestonesBefore = Math.floor(lifetimeBefore / MILESTONE_INCREMENT);
    const milestonesAfter = Math.floor(lifetimeAfter / MILESTONE_INCREMENT);

    for (let i = milestonesBefore + 1; i <= milestonesAfter; i++) {
        const amount = i * MILESTONE_INCREMENT;
        const label = `$${(amount / 100).toLocaleString('en-US')}`;
        broadcastGoalMilestone(amount);
        await announceMilestone(label);
    }

    // Update pinned message
    await updatePinnedMessage(goal);
}

/**
 * Update (or create) the pinned message in #restock-tracker.
 */
async function updatePinnedMessage(goal) {
    const channel = getChannel('COMMUNITY_GOALS');
    if (!channel) return;

    const embed = buildGoalEmbed(goal || goals.get.get());

    try {
        if (goal?.channel_message_id) {
            // Try to edit existing message
            const msg = await channel.messages.fetch(goal.channel_message_id);
            await msg.edit({ embeds: [embed] });
        } else {
            throw new Error('No pinned message — create one');
        }
    } catch {
        // Create new message and pin it
        const msg = await channel.send({ embeds: [embed] });
        await msg.pin();
        goals.setMessageId.run(msg.id);
    }
}

/**
 * Announce a completed restock cycle in #restock-tracker.
 */
async function announceRestock(cycleNumber) {
    broadcastGoalCycleHit(cycleNumber);

    const channel = getChannel('COMMUNITY_GOALS');
    if (!channel) return;

    const embed = new EmbedBuilder()
        .setTitle('🎉 Restock Goal Hit!')
        .setDescription(
            `**Cycle #${cycleNumber} complete!** The community just hit $${(CYCLE_GOAL / 100).toFixed(2)} in sales.\n\n` +
            'New product is on the way. Stay tuned for the drop!'
        )
        .setColor(0xceff00);

    await channel.send({ embeds: [embed] });
}

/**
 * Announce a lifetime milestone in #restock-tracker and #announcements.
 */
async function announceMilestone(label) {
    const embed = new EmbedBuilder()
        .setTitle(`🏆 Lifetime Milestone — ${label}!`)
        .setDescription(
            `The community just crossed **${label}** in lifetime sales!\n\n` +
            '**Free loot for the community!** Stay tuned for the giveaway.'
        )
        .setColor(0xceff00);

    const goalsChannel = getChannel('COMMUNITY_GOALS');
    if (goalsChannel) await goalsChannel.send({ embeds: [embed] });

    const announcements = getChannel('ANNOUNCEMENTS');
    if (announcements) await announcements.send({ embeds: [embed] });
}

/**
 * Initialize the pinned message on startup.
 */
async function initCommunityGoals() {
    const goal = goals.get.get();
    await updatePinnedMessage(goal);
    console.log(`Community goals initialized: Cycle #${goal.cycle}, $${(goal.cycle_revenue / 100).toFixed(2)}/$${(CYCLE_GOAL / 100).toFixed(2)}`);
}

export { addRevenue, initCommunityGoals, CYCLE_GOAL, MILESTONE_INCREMENT };
