/**
 * Twitch EventSub Webhook Handler
 *
 * Handles:
 * - stream.online → Going-live notification in #announcements
 * - stream.offline → Stream-ended recap in #announcements
 *
 * Twitch EventSub sends webhooks for stream events.
 * Requires TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, and TWITCH_WEBHOOK_SECRET.
 */

import crypto from 'node:crypto';
import config from '../config.js';
import { sendEmbed } from '../discord.js';

/**
 * Verify Twitch EventSub webhook signature.
 */
function verifyTwitchSignature(req) {
    const secret = config.TWITCH_WEBHOOK_SECRET;
    if (!secret) return false;

    const messageId = req.headers['twitch-eventsub-message-id'];
    const timestamp = req.headers['twitch-eventsub-message-timestamp'];
    const signature = req.headers['twitch-eventsub-message-signature'];
    const body = req.rawBody;

    const hmacMessage = messageId + timestamp + body;
    const expectedSig = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(hmacMessage)
        .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
}

/**
 * Handle stream.online event.
 */
async function handleStreamOnline(event) {
    const streamTitle = event.title || 'itzenzo.tv is live!';

    await sendEmbed('ANNOUNCEMENTS', {
        title: '🔴 We\'re Live!',
        description: `**${streamTitle}**\n\n👉 [Watch on Twitch](https://twitch.tv/itzenzoTTV)\n\n<@&${config.ROLES.XIPE}> come hang!`,
        color: 0x9146ff, // Twitch purple
    });

    console.log('Posted going-live notification');
}

/**
 * Handle stream.offline event.
 */
async function handleStreamOffline() {
    await sendEmbed('ANNOUNCEMENTS', {
        title: '📴 Stream\'s Over!',
        description: 'Thanks for hanging out! Clips and highlights coming soon.\n\nNext stream — check the schedule on socials.',
        color: 0x95a5a6,
    });

    console.log('Posted stream-ended notification');
}

/**
 * Express route handler for Twitch EventSub.
 */
async function handleTwitchWebhook(req, res) {
    const messageType = req.headers['twitch-eventsub-message-type'];

    // Handle webhook verification challenge
    if (messageType === 'webhook_callback_verification') {
        console.log('Twitch EventSub verification challenge received');
        return res.status(200).type('text/plain').send(req.body.challenge);
    }

    // Verify signature
    if (config.TWITCH_WEBHOOK_SECRET && !verifyTwitchSignature(req)) {
        console.error('Invalid Twitch webhook signature');
        return res.status(403).send('Invalid signature');
    }

    // Handle revocation
    if (messageType === 'revocation') {
        console.log('Twitch EventSub subscription revoked:', req.body.subscription?.type);
        return res.sendStatus(200);
    }

    // Handle events
    const eventType = req.body.subscription?.type;
    const event = req.body.event;

    try {
        switch (eventType) {
            case 'stream.online':
                await handleStreamOnline(event);
                break;
            case 'stream.offline':
                await handleStreamOffline();
                break;
            default:
                console.log('Unhandled Twitch event:', eventType);
        }
    } catch (e) {
        console.error('Error handling Twitch event:', e.message);
    }

    res.sendStatus(200);
}

export { handleTwitchWebhook };
