/**
 * Bot Commands Reference — auto-synced to #bot-commands on startup.
 *
 * Each entry is an embed posted in order. On startup, the bot compares
 * existing embeds to this content and updates any that have changed.
 */

const messages = [
    // Message 1: Master Commands
    {
        title: '📖 Nous Command Reference',
        description: 'All commands at a glance. Organized by feature area.',
        color: 0xceff00,
    },

    // Message 2: Master Commands
    {
        title: '🎛️ Master Commands',
        description: [
            '**`!hype Product 1, Product 2`** — Pre-stream hype. Looks up products in Stripe, shows a preview with prices (detects sales), then posts a hype embed to #announcements with Buy Now buttons. Also drops raw checkout URLs in #ops for easy copy-paste to socials. React ✅ to confirm.',
            '> Example: `!hype Prismatic Evolutions Booster Box, Crown Zenith ETB`',
            '',
            '**`!live`** — Go live. Posts pre-order summary (queue stays open), starts livestream session, posts shop link in #announcements.',
            '',
            '**`!offline`** — End stream. Ends livestream session, ensures a queue is open for pre-orders, posts stream-ended in #announcements, posts stream recap to #analytics.',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 3: Pack Battles
    {
        title: '⚔️ Pack Battles',
        description: [
            '**`!battle start <product name> [max]`** — Start a battle. Bot searches Stripe for the product, posts embed with Buy Pack button to #pack-battles. No shipping at buy-in — only the winner pays. Default 20 max entries. Auto-closes when full.',
            '> Example: `!battle start Prismatic Evolutions 12`',
            '',
            '**`!battle join`** — Owner enters battle without payment. Decrements stock.',
            '',
            '**`!battle status`** — Show current battle (anyone can use)',
            '',
            '**`!battle close`** — Close entries, update original embed to CLOSED',
            '',
            '**`!battle cancel`** — Cancel the battle, notify entrants',
            '',
            '**`!battle winner @user`** — Declare winner. Assigns Aha role, cross-posts to #announcements. DMs winner shipping link if not already covered.',
            '',
            '*Only one battle can be active at a time. Close or cancel before starting a new one. One entry per user.*',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 4: Queue & Duck Race
    {
        title: '🦆 Queue & Duck Race',
        description: [
            '**`!queue`** — Show current queue (anyone can use)',
            '',
            '**`!queue open`** — Open a new pre-order queue (auto-opened by `!offline`)',
            '',
            '**`!queue close`** — Close queue, update #queue embed (auto-closed by `!offline`)',
            '',
            '**`!queue history`** — Show last 5 queues with winners',
            '',
            '**`!duckrace`** — Show duck race roster (1 entry per unique buyer from queue)',
            '',
            '**`!duckrace start`** — Run animated duck race in #queue. Random winner, Aha role, announcements.',
            '',
            '**`!duckrace winner @user`** — Manual winner (skip animation). Assign Aha role, announce.',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 5: Card Shop
    {
        title: '🃏 Card Shop',
        description: [
            '**`!sell "Card Name" 25.00`** — List a card for open purchase in #card-shop. Posts a "Buy Now" button — buyer clicks, bot checks shipping status, creates personalized checkout. Listing stays active for 2 hours. If a buyer reserves but doesn\'t pay within 30 minutes, the card auto-relists with a fresh 2-hour window.',
            '',
            '**`!sell @buyer "Card Name" 25.00`** — Reserve a card for a specific buyer. Posts listing in #card-shop, DMs buyer a Buy Now button with identity capture. 30-minute reservation expiry — if they don\'t pay, the listing expires permanently.',
            '',
            '**`!list open`** — Open a new batch card list session. Posts a summary embed in #card-shop that updates in real-time as cards are added and sold.',
            '',
            '**`!list add "Card Name" 25.00`** — Add a card to the active list. Summary embed updates with a dropdown menu for buyers to select and purchase cards.',
            '',
            '**`!list close`** — Close the active list. Unsold items are expired and the dropdown is removed.',
            '',
            '**`!sold <message_id>`** — Manually mark a listing as sold. Can also reply to the listing message. Auto-marked on Stripe payment.',
            '',
            '**`!pull "Name" 3.00`** — Open a pull box in #card-shop. Posts a Buy Pull button that stays open for unlimited buyers. Embed updates with a live purchase count. $1–$5 typical.',
            '> Example: `!pull "Mystery Pull Box" 3.00`',
            '',
            '**`!pull close`** — Close the active pull box. Shows final count and revenue.',
            '',
            '**`!pull status`** — Show active pull box info (pulls sold, revenue).',
            '',
            '*Card name must be in quotes. Price in dollars. Shipping: $10 US / $25 international (waived if already covered this week/month).*',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 6: Giveaways
    {
        title: '🎁 Giveaways',
        description: [
            '**`!giveaway start "Prize" [duration] [social] [url]`** — Start a giveaway with Enter button in #giveaways. Add `social` for TikTok engagement giveaways (captures TikTok username). Add a TikTok URL to link to the specific post.',
            '> Examples: `!giveaway start "ETB" 48h` · `!giveaway start "ETB" social https://tiktok.com/...`',
            '',
            '**`!giveaway status`** — Show current giveaway (anyone can use)',
            '',
            '**`!giveaway close`** — Close entries, update embed + announce in #announcements. Auto-closes when duration expires.',
            '',
            '**`!giveaway cancel`** — Cancel the giveaway.',
            '',
            '**`!spin giveaway`** — Animated wheel spin to draw giveaway winner. Decelerating spinner, ~30 sec. Assigns Aha role, announces in #giveaways and #announcements.',
            '',
            '**`!spin @user1 @user2 @user3`** — Ad-hoc spin with mentioned users. No role changes — just picks a winner.',
            '',
            '**`!spin "Prize 1" "Prize 2" "Prize 3"`** — Ad-hoc spin with text entries (comma-separated also works).',
            '',
            '*Only verified members (Xipe role) can enter giveaways. One entry per person. Entry roster shows Discord + TikTok username (social mode). Social copy posted to #ops.*',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 7: Analytics
    {
        title: '📊 Analytics',
        description: [
            '**`!snapshot`** — Post a snapshot of the current month to #analytics. Revenue, orders, buyers (new vs returning), stream count, avg per stream, top products, community goal state.',
            '',
            '**`!snapshot march`** — Snapshot for a specific month (current year)',
            '',
            '**`!snapshot 2026`** — Snapshot for a full year',
            '',
            '**`!snapshot march 2026`** — Snapshot for a specific month and year',
            '',
            '*Stream recaps are posted automatically to #analytics when `!offline` runs — no extra step needed.*',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 8: Other Commands
    {
        title: '🔧 Other Commands',
        description: [
            '**`!tracking @user TRACKING_NUMBER CARRIER`** — Add tracking info for a buyer. Included automatically in their `!dropped-off` DM. Carrier defaults to USPS if omitted.',
            '> Example: `!tracking @user 9400111899223847263910 USPS`',
            '',
            '**`!tracking list`** — Show all pending tracking entries.',
            '',
            '**`!tracking clear`** — Clear all tracking data (post-delivery cleanup).',
            '',
            '**`!dropped-off`** — Weekly domestic shipping notification. DMs every domestic buyer with unshipped orders + tracking info. Posts "Orders Shipped" in #order-feed.',
            '',
            '**`!dropped-off intl`** — Monthly international shipping notification. Same flow, filtered to international buyers only.',
            '',
            '**`!shipping @user 10.00 [reason]`** — Send a Stripe checkout link for any shipping amount. DMs the user; falls back to channel if DMs are disabled.',
            '> Example: `!shipping @user 25.00 International shipping`',
            '',
            '**`!intl @user CA`** — Flag a user as international. `!intl @user US` to revert. `!intl @user` to check. `!intl list` to list all.',
            '',
            '**`!intl-ship`** — Month-end: DM international buyers with unpaid shipping this month.',
            '',
            '**`!shipping-audit`** — Verify all shipping collected. `!shipping-audit intl` or `!shipping-audit week` for filtered views.',
            '',
            '**`!waive @user`** — Waive shipping for a buyer. If they already paid this period, refunds via Stripe and removes the record. If they haven\'t paid, inserts a $0 waiver so all checkouts this period skip shipping.',
            '',
            '**`!refund @user [amount] [reason]`** — Refund the most recent purchase for a user. Full refund if no amount specified, partial if amount given.',
            '> Example: `!refund @user 10.00 Duplicate charge`',
            '',
            '**`!refund session <session_id> [amount] [reason]`** — Refund a specific Stripe session. Use when you need to target a specific transaction.',
            '> Example: `!refund session cs_xxx 25.00 Wrong product shipped`',
            '',
            '**`!nous #channel message`** — Post a message as Nous in any channel. Deletes the command so it looks like Nous spoke on its own.',
            '> Example: `!nous #announcements 🎉 Big news dropping tomorrow.`',
            '',
            '**`!link email@example.com`** — (Ops only) Manually link a Discord account to a shop email. Validates email in Stripe. Bot deletes the message.',
            '',
            '**`!reset`** — Wipe all bot data (purchases, shipping, queues, battles, etc.) and re-sync stock via `!sync`. Requires confirmation. Owner only.',
            '',
            '*Account linking is handled via the Link Account button in #welcome or automatically at checkout. !link is for manual ops use only.*',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 9: Coupons
    {
        title: '🏷️ Coupons',
        description: [
            '**`!coupon create <CODE> <discount> [uses]`** — Create a Stripe coupon. Defaults to single use. Add `unlimited` or a number for more.',
            '> Examples: `!coupon create CREDIT5 5.00` (1 use) · `!coupon create FLASH20 20% unlimited` · `!coupon create VIP10 10% 5`',
            '',
            '**`!coupon <CODE>`** — Announce a promo code in #announcements.',
            '> Example: `!coupon SPRING20`',
            '',
            '**`!coupon off`** — Post coupon expired notice in #announcements.',
            '',
            '**`!coupon status`** — Show the currently active coupon.',
            '',
            '*The promo code field is always visible at checkout. Buyers enter codes directly — no activation needed. Use `!coupon create` for targeted credits (DM the code to one buyer) or `!coupon <CODE>` to announce publicly.*',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 10: Product Sync
    {
        title: '🔄 Product Sync',
        description: [
            '**`!sync`** — Full pipeline: Google Sheets → Stripe → WordPress. Deactivates stale products, syncs all rows from the spreadsheet to Stripe, then rebuilds WordPress product listings. Posts summary to #ops. New products trigger category alerts (#pokemon, #anime, etc.).',
            '',
            '**`!sync stripe`** — Stripe → WordPress only. Skips the Sheets step — useful if you edited Stripe directly or just need to refresh the shop.',
            '',
            '*Run `!sync` after updating the Google Sheets product catalog.*',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 10: Typical Stream Night Flow
    {
        title: '🔴 Typical Stream Night Flow',
        description: [
            '```',
            '!hype Product 1, Product 2            → Pre-stream hype (confirm with ✅)',
            '!live                                  → Go live (queue stays open)',
            '!sell @buyer "Card Name" 25.00        → Reserve a card for a viewer',
            '!sell "Card Name" 25.00               → Open listing (anyone can buy)',
            '!list open                             → Open a batch card list',
            '!list add "Card Name" 25.00           → Add card to the list',
            '!list close                            → Close the list, expire unsold',
            '!coupon STREAM10                       → Activate promo code for flash deal',
            '!coupon off                            → Deactivate when deal window ends',
            '!battle start Product Name 12          → Start pack battle',
            '!battle close                          → Close entries',
            '!battle winner @user                   → Declare winner',
            '!duckrace                              → Show duck race roster',
            '!duckrace start                        → Run animated duck race',
            '!duckrace winner @user                 → Manual winner (skip animation)',
            '!spin giveaway                         → Animated giveaway winner draw',
            '!spin "10% off" "Free pack" "Shoutout" → Ad-hoc wheel spin',
            '!capture                               → Log moment timestamp to #moments',
            '!capture Big Charizard pull             → Log with a note',
            '!offline                               → Close queue, post recap, open next queue',
            '!tracking @user TRACKING USPS          → Add tracking after creating labels',
            '!dropped-off                           → Monday: notify buyers + tracking, mark shipped',
            '!snapshot                              → Anytime: post analytics snapshot to #analytics',
            '```',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message 10: Shipping Model
    {
        title: '📦 Shipping Model',
        description: [
            '**Two tiers, two cadences:**',
            '• **Domestic (US):** $10 flat rate, collected weekly (Mon–Sun)',
            '• **International (CA+):** $25 flat rate, collected monthly (buyers can DM to ship early)',
            '',
            '```',
            'Normal shop (email entered)    →  Bot checks coverage → $10/$25 or skip',
            'Normal shop (email skipped)    →  Both options at checkout, buyer picks',
            'Discord button (!sell/!list/!hype) → Bot checks status → $10/$25 or skip',
            '!sell @buyer (not live)        →  Bot checks status → $10/$25 or skip',
            'Pack battle buy-in             →  No shipping (winner pays after declaration)',
            'Ad-hoc (!shipping @user amt)   →  Any amount, DM with checkout link',
            'Waiver (!waive @user)          →  Pre-waive or refund+remove shipping',
            'Weekly drop-off (!dropped-off) →  DMs domestic buyers + tracking',
            'Monthly (!dropped-off intl)    →  DMs international buyers + tracking',
            '```',
            '',
            '**Delivery estimates:** 5-7 business days (domestic), 7-14 business days (international). Shown at checkout, in receipt DMs, and in shipped notifications.',
            '',
            '**Tracking:** ShippingEasy webhook auto-imports tracking numbers when labels are purchased. Tracking info is included in `!dropped-off` DMs when available.',
            '',
            '*Double-charge prevention: one payment covers all purchases for the period (week/month). Bot checks before every checkout.*',
        ].join('\n'),
        color: 0xceff00,
    },

    // Message: Test Suite
    {
        title: '🧪 Test Suite',
        description: [
            '**`!test`** — Run all three test flows (card night + giveaway/spin + race conditions). All output routes to #test-suite. Ends with data reset.',
            '',
            '**`!test card-night`** — Card night critical path (81 steps: hype → live → purchases → sells → lists → pulls → battles → coupons → duck races → analytics → shipping → tracking → dropped-off → audit → waive → refund).',
            '',
            '**`!test giveaway`** — Giveaway & spin flow (16 steps: standard giveaway → social giveaway → cancel → all spin variants).',
            '',
            '**`!test race`** — Race condition verification (8 steps: atomic reservation, duck race double-start, giveaway double-click, battle capacity, shipping dedup, coupon single-active, TTL vs payment, webhook retry).',
            '',
            '*Uses @rhapttv test account. Simulates buyer interactions via direct handler calls. Stripe must be in test mode.*',
        ].join('\n'),
        color: 0xceff00,
    },
];

export default messages;
