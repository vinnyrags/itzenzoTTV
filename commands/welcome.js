/**
 * Welcome Channel — persistent embed with Link Account button.
 *
 * Auto-posted on bot startup via initWelcome(). No command needed.
 * The embed is edited in place on restart — never duplicated.
 */

import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import config from '../config.js';
import { client, getChannel } from '../discord.js';

function buildWelcomeEmbed() {
    return new EmbedBuilder()
        .setTitle('Welcome to itzenzo.tv')
        .setDescription(
            'Cards. Games. Community. Welcome to the family.\n\n' +
            'We run card nights **Monday through Thursday** — pack openings, pack battles, duck races, and more. ' +
            'Gaming streams happen **Friday through Sunday**. Everything goes through Discord.'
        )
        .setColor(0xceff00)
        .addFields(
            {
                name: 'Key Channels',
                value: [
                    '<#' + config.CHANNELS.ANNOUNCEMENTS + '> — Going-live, drops, flash sales',
                    '<#' + config.CHANNELS.PACK_BATTLES + '> — Buy a pack, winner takes all cards',
                    '<#' + config.CHANNELS.CARD_SHOP + '> — Individual card sales',
                    '<#' + config.CHANNELS.QUEUE + '> — Live queue and duck race roster',
                    '<#' + config.CHANNELS.ORDER_FEED + '> — Real-time order notifications',
                ].join('\n'),
            },
            {
                name: 'Link Your Account',
                value:
                    'If you made a purchase and did not enter your Discord name at checkout, click the **Link Account** button below and enter the email you used at checkout. ' +
                    'This connects your purchases to your Discord profile so your name appears in the queue, order feed, and duck race roster. ' +
                    'You also get automatic role upgrades as you hit purchase milestones.',
            },
            {
                name: 'Get Verified',
                value:
                    'Head to <#1488183429437853696> and react to get the **Xipe** role. ' +
                    'This unlocks full server access — giveaways, pack battles, pull boxes, community channels, and more. ' +
                    'Once verified, check out <#1488041097153347704> to pick up additional roles like **Ena** for After Dark content.',
            },
            {
                name: 'Role Progression',
                value:
                    '**Xipe** — Verified member\n' +
                    '**Long** — 5+ purchases (loyalty recognized)',
            },
        )
        .setFooter({ text: 'itzenzo.tv — Cards. Games. After Dark.' });
}

function buildWelcomeButton() {
    const button = new ButtonBuilder()
        .setCustomId('welcome-link')
        .setLabel('Link Account')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🔗');

    return new ActionRowBuilder().addComponents(button);
}

/**
 * Ensure the welcome embed exists in #welcome on bot startup.
 * Edits the existing message if found, posts fresh if missing.
 */
async function initWelcome() {
    try {
        const { welcome } = await import('../db.js');
        const channel = getChannel('WELCOME');
        if (!channel) {
            console.log('Welcome channel not found — skipping initWelcome');
            return;
        }

        const embed = buildWelcomeEmbed();
        const row = buildWelcomeButton();
        const row_config = welcome.getConfig.get();

        if (row_config?.channel_message_id) {
            try {
                const msg = await channel.messages.fetch(row_config.channel_message_id);
                await msg.edit({ embeds: [embed], components: [row] });
                console.log('Welcome embed updated');
                return;
            } catch {
                // Message was deleted — post fresh below
            }
        }

        const msg = await channel.send({ embeds: [embed], components: [row] });
        welcome.setMessageId.run(msg.id);
        console.log('Welcome embed posted');
    } catch (e) {
        console.error('Failed to initialize welcome embed:', e.message);
    }
}

export { initWelcome };
