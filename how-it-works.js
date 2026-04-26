/**
 * #how-it-works Reference — auto-synced to #how-it-works on startup.
 *
 * Customer-facing payment, shipping, and refund explanation. Each entry
 * becomes one embed posted in order. The bot compares existing embeds to
 * this content and edits any that have changed (see sync-bot-commands.js).
 *
 * Canonical copy lives in akivili/business/discord.md under "#how-it-works
 * — Planned Content"; keep these in sync when policy changes.
 */

const messages = [
    // Message 1: Overview
    {
        title: '💳 How Payments & Shipping Work',
        description: [
            'We sell sealed TCG product (Pokemon, anime, and more) through the shop at **itzenzo.tv**, plus hand-inspected raw singles in our [card catalog](https://itzenzo.tv/cards) — condition shown right on the listing.',
            '',
            'Here\'s exactly how everything works — buying, shipping, refunds, and what to expect at every step.',
            '',
            '_Have a question this doesn\'t cover? DM the shop owner directly or reply to your Stripe receipt email._',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 2: Buying
    {
        title: '🛒 Buying',
        description: [
            '**Between streams**',
            'Shop anytime at [itzenzo.tv](https://itzenzo.tv). We automatically check your shipping coverage using the email from a previous order. If your shipping is already covered this week (US) or month (international), you won\'t be charged again. If not, shipping is included at checkout — $10 US / $25 International.',
            '',
            '**During a livestream**',
            'When a stream is live, the shop link in #announcements puts you in livestream mode — same shipping check, same flat rates, but the energy is faster. Pack battles, flash deals, and duck races all run in real time.',
            '',
            '**Why flat-rate shipping?**',
            'One payment covers every purchase you make in the same period. Buy a single card or fifteen products in the same week — you pay shipping exactly once. No per-item math, no surprise stacking fees.',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 3: Pack battles + card shop
    {
        title: '⚔️ Pack Battles & 🃏 Card Shop',
        description: [
            '**Pack battles**',
            'Multiple buyers each grab a pack at full retail. Every pack opens live on stream, and the highest-value card wins **all** the cards from **all** the packs. No shipping is collected at buy-in — only the winner pays shipping after the battle is declared. Losers pay nothing extra.',
            '',
            '**Card shop (#card-shop)**',
            'Graded cards, vintage one-offs, and anything outside the main catalog get listed in `#card-shop` as embeds with Buy Now buttons. Click to check out — a reservation locks the card to you for 30 minutes while you complete the purchase. If you don\'t finish in time, the card is released back to the shop for the next buyer.',
            '',
            '**Raw singles catalog**',
            'Browse the catalog at [itzenzo.tv/cards](https://itzenzo.tv/cards). Every card is hand-inspected, with condition (NM, LP, MP, HP, DMG) shown in the corner of the listing. Not sure about a card? Hit **Request to See** and we\'ll feature it on stream so you can see edges, surface, and holo shift in real time — no commitment.',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 4: Shipping
    {
        title: '📦 Shipping & 🌍 International',
        description: [
            '**Shipping schedule**',
            'US orders ship every Monday. International orders ship at the end of each month. Your shipping payment covers everything you buy during that period — pay once, ship once.',
            '',
            'When your order ships, you\'ll get a DM from Nous with your tracking number and a link to track your package. A public notification also goes out in `#order-feed`.',
            '',
            '**International buyers**',
            'We ship to the US and Canada. International shipping is $25/month — one payment covers all your purchases for the entire month. If you\'re outside the US, select your country at checkout and you\'re set. Want your order sooner? DM the shop owner — we can ship early instead of waiting for the monthly batch.',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 5: Payment security
    {
        title: '🔒 Payment Security',
        description: [
            'All payments go through **Stripe**, a PCI-compliant payment processor used by millions of businesses. We never see or store your card information — Stripe handles every part of the transaction.',
            '',
            'You\'ll get an email receipt directly from Stripe for every purchase. Replying to that receipt is one of the fastest ways to reach us if anything goes wrong.',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 6: Refunds
    {
        title: '💸 Refunds, Returns, and "Is My Card Actually NM?"',
        description: [
            'If something\'s wrong, we\'ll make it right. The short version:',
            '',
            '**Before your order ships** — A full refund cancels everything. Stripe refunds your money and the order is killed in our shipping system so nothing goes out the door.',
            '',
            '**After your order ships** — We can still refund, we just can\'t recall the package. If your package is lost, damaged, or never shows up, DM us with your tracking number and we\'ll work it out together.',
            '',
            '**Concerned about a card?** — Hit **Request to See** on the listing before you buy. We\'ll feature the card on the next card night so you can see edges, surface, and centering on stream before committing.',
            '',
            '**Pack battle buy-ins** — Refundable up until the battle starts on stream. Once packs are being opened, the result is locked in.',
            '',
            'Refunds land back on your card in 5–10 business days (Stripe processes immediately, your bank takes a beat).',
            '',
            '**Full policy:** [itzenzo.tv/how-it-works/refund-policy](https://itzenzo.tv/how-it-works/refund-policy)',
            '',
            '_How to ask: DM the shop owner directly, or reply to your Stripe receipt email — both routes reach me._',
        ].join('\n'),
        color: 0xceff00,
    },
];

export default messages;
