/**
 * SQLite database for pack battles, purchase tracking, duck races, and card listings.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// NOUS_DB_PATH env override: lets integration tests open a per-spec
// SQLite file (or :memory:) without touching production data.db.
// Production deploys never set it, so the existing path stays the default.
const dbPath = process.env.NOUS_DB_PATH || path.resolve(__dirname, 'data.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// =========================================================================
// Schema
// =========================================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stripe_session_id TEXT UNIQUE NOT NULL,
        discord_user_id TEXT,
        customer_email TEXT,
        product_name TEXT,
        amount INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        shipped_at TEXT
    );

    CREATE TABLE IF NOT EXISTS purchase_counts (
        discord_user_id TEXT PRIMARY KEY,
        total_purchases INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS battles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        battle_number INTEGER,
        channel_message_id TEXT,
        product_slug TEXT NOT NULL,
        product_name TEXT NOT NULL,
        stripe_price_id TEXT,
        max_entries INTEGER DEFAULT 20,
        status TEXT DEFAULT 'open',
        created_at TEXT DEFAULT (datetime('now')),
        closed_at TEXT,
        winner_id TEXT
    );

    CREATE TABLE IF NOT EXISTS battle_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        battle_id INTEGER NOT NULL,
        discord_user_id TEXT NOT NULL,
        stripe_session_id TEXT,
        paid INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (battle_id) REFERENCES battles(id),
        UNIQUE(battle_id, discord_user_id)
    );

    CREATE TABLE IF NOT EXISTS duck_race_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        race_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        stripe_session_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(race_id, discord_user_id)
    );

    CREATE TABLE IF NOT EXISTS queues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT DEFAULT 'open',
        created_at TEXT DEFAULT (datetime('now')),
        closed_at TEXT,
        duck_race_winner_id TEXT
    );

    CREATE TABLE IF NOT EXISTS queue_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id INTEGER NOT NULL,
        discord_user_id TEXT,
        customer_email TEXT,
        product_name TEXT,
        quantity INTEGER DEFAULT 1,
        stripe_session_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (queue_id) REFERENCES queues(id)
    );

    CREATE TABLE IF NOT EXISTS livestream_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS livestream_buyers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        discord_user_id TEXT,
        customer_email TEXT NOT NULL,
        shipping_paid INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES livestream_sessions(id),
        UNIQUE(session_id, customer_email)
    );

    CREATE TABLE IF NOT EXISTS discord_links (
        discord_user_id TEXT PRIMARY KEY,
        customer_email TEXT NOT NULL,
        country TEXT DEFAULT NULL,
        linked_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shipping_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_email TEXT NOT NULL,
        discord_user_id TEXT,
        amount INTEGER NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS community_goals (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cycle INTEGER DEFAULT 1,
        cycle_revenue INTEGER DEFAULT 0,
        lifetime_revenue INTEGER DEFAULT 0,
        channel_message_id TEXT
    );

    INSERT OR IGNORE INTO community_goals (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS giveaways (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prize_name TEXT NOT NULL,
        channel_message_id TEXT,
        status TEXT DEFAULT 'open',
        created_at TEXT DEFAULT (datetime('now')),
        ends_at TEXT,
        closed_at TEXT,
        winner_id TEXT
    );

    CREATE TABLE IF NOT EXISTS giveaway_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        giveaway_id INTEGER NOT NULL,
        discord_user_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (giveaway_id) REFERENCES giveaways(id),
        UNIQUE(giveaway_id, discord_user_id)
    );

    CREATE TABLE IF NOT EXISTS card_listings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        card_name TEXT NOT NULL,
        price INTEGER NOT NULL,
        stripe_session_id TEXT,
        buyer_discord_id TEXT,
        status TEXT DEFAULT 'active',
        purchase_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        sold_at TEXT
    );

    CREATE TABLE IF NOT EXISTS list_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        status TEXT DEFAULT 'open',
        created_at TEXT DEFAULT (datetime('now')),
        closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_email TEXT NOT NULL,
        discord_user_id TEXT,
        tracking_number TEXT NOT NULL,
        carrier TEXT,
        carrier_service TEXT,
        tracking_url TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS active_coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        promo_code TEXT NOT NULL,
        stripe_promo_id TEXT NOT NULL,
        stripe_coupon_id TEXT NOT NULL,
        discount_display TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        activated_at TEXT DEFAULT (datetime('now')),
        deactivated_at TEXT
    );

    -- ToS acceptance log for Discord-flow purchases (Buy buttons in
    -- #pack-battles, #card-shop, hype embeds, pull-box modal). One-
    -- time-per-version: a buyer who accepts terms v1.1 once doesn't
    -- see the gate again until TERMS_VERSION bumps. See
    -- lib/tos-acceptance.js for the access layer.
    CREATE TABLE IF NOT EXISTS discord_tos_acceptances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id TEXT NOT NULL,
        terms_version TEXT NOT NULL,
        accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
        source TEXT NOT NULL DEFAULT 'discord_button'
    );
    CREATE INDEX IF NOT EXISTS idx_tos_user_version
        ON discord_tos_acceptances(discord_user_id, terms_version);

    -- Persistent log of every activity-feed broadcast. Capture happens
    -- in queue-broadcaster.js's broadcast() before SSE fan-out, so a
    -- single write covers every event kind (queue mutations, pull-box
    -- lifecycle, battle entries/wins, coupon drops, community goals,
    -- stock alerts, Discord/Minecraft joins, card offers, bundle
    -- alerts, cards restocked, shipping settled). Without this, the
    -- itzenzo.tv homepage feed used to wipe on every page reload AND
    -- on every Nous restart — events were only ever in-memory.
    --
    -- /activity/recent reads from this table to backfill the feed on
    -- page mount; live SSE takes over from there. The frontend keeps
    -- its 50-item visible cap; we keep server history unbounded for
    -- now (SQLite handles years of activity events trivially).
    CREATE TABLE IF NOT EXISTS activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_events_created_at
        ON activity_events(created_at DESC);
`);

// =========================================================================
// Migrations
// =========================================================================

// Add shipped_at column to purchases if it doesn't exist (v2)
try {
    db.exec(`ALTER TABLE purchases ADD COLUMN shipped_at TEXT`);
} catch {
    // Column already exists — ignore
}

// Add country column to discord_links if it doesn't exist (v3)
try {
    db.exec(`ALTER TABLE discord_links ADD COLUMN country TEXT DEFAULT NULL`);
} catch {
    // Column already exists — ignore
}

// Create shipping_payments table if it doesn't exist (v3)
db.exec(`
    CREATE TABLE IF NOT EXISTS shipping_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_email TEXT NOT NULL,
        discord_user_id TEXT,
        amount INTEGER NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
    );
`);

// Add purchase_count column to card_listings if it doesn't exist (v4)
try {
    db.exec(`ALTER TABLE card_listings ADD COLUMN purchase_count INTEGER DEFAULT 0`);
} catch {
    // Column already exists — ignore
}

// Add stripe_session_id column to shipping_payments if it doesn't exist (v4)
try {
    db.exec(`ALTER TABLE shipping_payments ADD COLUMN stripe_session_id TEXT DEFAULT NULL`);
} catch {
    // Column already exists — ignore
}

// Add channel_message_id column to queues for real-time #queue embed (v5)
try {
    db.exec(`ALTER TABLE queues ADD COLUMN channel_message_id TEXT`);
} catch {
    // Column already exists — ignore
}

// Add buyer_dm_message_id to card_listings for in-place DM updates (v7)
try {
    db.exec(`ALTER TABLE card_listings ADD COLUMN buyer_dm_message_id TEXT`);
} catch {
    // Column already exists — ignore
}

// Welcome config singleton for persistent #welcome embed (v6)
db.exec(`
    CREATE TABLE IF NOT EXISTS pull_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id INTEGER NOT NULL,
        discord_user_id TEXT,
        customer_email TEXT,
        quantity INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (listing_id) REFERENCES card_listings(id)
    );

    CREATE TABLE IF NOT EXISTS welcome_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channel_message_id TEXT
    );
    INSERT OR IGNORE INTO welcome_config (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS minecraft_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channel_message_id TEXT
    );
    INSERT OR IGNORE INTO minecraft_config (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS lfg_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channel_message_id TEXT
    );
    INSERT OR IGNORE INTO lfg_config (id) VALUES (1);
`);

// Add list_session_id column to card_listings (v9)
try {
    db.exec(`ALTER TABLE card_listings ADD COLUMN list_session_id INTEGER DEFAULT NULL`);
} catch {
    // Column already exists — ignore
}

// Unique index on shipping payments per session (v10 — prevent webhook retry duplicates)
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_shipping_session ON shipping_payments(stripe_session_id) WHERE stripe_session_id IS NOT NULL`);

// Add social giveaway fields (v8)
try { db.exec(`ALTER TABLE giveaways ADD COLUMN is_social INTEGER DEFAULT 0`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE giveaways ADD COLUMN social_link TEXT`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE giveaway_entries ADD COLUMN tiktok_username TEXT`); } catch { /* exists */ }

// Add source column to purchases for speculative-vs-committed tracking.
// Populated from Stripe metadata.source — 'pull_box' / 'speculative' /
// 'pack_battle' identify items that don't auto-include shipping at
// checkout. NULL means committed (existing behavior).
try { db.exec(`ALTER TABLE purchases ADD COLUMN source TEXT DEFAULT NULL`); } catch { /* exists */ }

// Speculative-purchase shipping DM log. One row per DM sent at /offline
// to a buyer with held items. Used to dedup: only DM after a fresh
// speculative purchase since the last DM. Period_start is the start of
// the buyer's shipping period (Monday for US, first of month for intl)
// so cross-period DMs are tracked separately.
db.exec(`
    CREATE TABLE IF NOT EXISTS speculative_shipping_dms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_email TEXT NOT NULL,
        sent_at TEXT DEFAULT (datetime('now')),
        period_start TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_spec_dms_email_sent ON speculative_shipping_dms (customer_email, sent_at);
`);

// Store full shipping address and ShippingEasy order link on purchases (v11)
// Add max_quantity for pull box stock caps (v12)
try { db.exec(`ALTER TABLE card_listings ADD COLUMN max_quantity INTEGER DEFAULT NULL`); } catch { /* exists */ }

try { db.exec(`ALTER TABLE purchases ADD COLUMN shipping_name TEXT DEFAULT NULL`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE purchases ADD COLUMN shipping_address TEXT DEFAULT NULL`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE purchases ADD COLUMN shipping_city TEXT DEFAULT NULL`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE purchases ADD COLUMN shipping_state TEXT DEFAULT NULL`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE purchases ADD COLUMN shipping_postal_code TEXT DEFAULT NULL`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE purchases ADD COLUMN shipping_country TEXT DEFAULT NULL`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE purchases ADD COLUMN shippingeasy_order_id TEXT DEFAULT NULL`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE purchases ADD COLUMN shippingeasy_canceled_at TEXT DEFAULT NULL`); } catch { /* exists */ }

// Refund tracking (v13) — set when a Stripe refund or dispute closes against this session.
// Captured here so the unified refund propagator (lib/refund-propagator.js) has a single
// idempotency point and the audit trail lives next to the purchase row.
try { db.exec(`ALTER TABLE purchases ADD COLUMN refunded_at TEXT DEFAULT NULL`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE purchases ADD COLUMN refund_amount INTEGER DEFAULT NULL`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE purchases ADD COLUMN refund_reason TEXT DEFAULT NULL`); } catch { /* exists */ }

// Stripe webhook idempotency (v14) — dedupe by event.id so a Stripe retry of the same
// event never re-applies side effects. Pruned daily by a cleanup cron.
db.exec(`
    CREATE TABLE IF NOT EXISTS processed_stripe_events (
        event_id TEXT PRIMARY KEY,
        received_at TEXT DEFAULT (datetime('now'))
    );
`);

// =========================================================================
// Purchases
// =========================================================================

const stmts = {
    insertPurchase: db.prepare(`
        INSERT OR IGNORE INTO purchases (stripe_session_id, discord_user_id, customer_email, product_name, amount)
        VALUES (?, ?, ?, ?, ?)
    `),

    /**
     * Speculative-aware insert. Same shape as insertPurchase plus the
     * source column ('pull_box' / 'speculative' / 'pack_battle' / NULL).
     * The /offline shipping-DM scan keys off the source column to find
     * buyers with held items who haven't paid for the period.
     */
    insertPurchaseWithSource: db.prepare(`
        INSERT OR IGNORE INTO purchases (stripe_session_id, discord_user_id, customer_email, product_name, amount, source)
        VALUES (?, ?, ?, ?, ?, ?)
    `),

    /**
     * Speculative-shipping DM dedup. Looks up the most recent DM sent
     * to this email (any period). The /offline scan compares this
     * timestamp against the most recent speculative purchase to decide
     * whether to send a fresh DM.
     */
    getLastSpeculativeDm: db.prepare(`
        SELECT sent_at FROM speculative_shipping_dms
        WHERE customer_email = ?
        ORDER BY sent_at DESC LIMIT 1
    `),

    insertSpeculativeDm: db.prepare(`
        INSERT INTO speculative_shipping_dms (customer_email, period_start)
        VALUES (?, ?)
    `),

    /**
     * Find buyers eligible for a speculative-shipping DM right now.
     * Eligibility:
     *   1. They have at least one purchase with source IN ('pull_box',
     *      'speculative', 'pack_battle') OR an unconfirmed pull-box slot
     *      claim for an active box.
     *   2. They haven't paid shipping for the current period (NOT IN the
     *      shipping_payments-this-period subquery).
     *   3. Their most recent speculative purchase is newer than their
     *      most recent DM (or they've never been DM'd).
     *
     * The query unions purchases.source matches AND pull_box_slots
     * confirmed claims (since pull-box buys are also recorded as
     * purchases, but we keep both paths for resilience).
     */
    getSpeculativeBuyersNeedingDm: db.prepare(`
        SELECT DISTINCT p.customer_email AS email
        FROM purchases p
        WHERE p.source IN ('pull_box', 'speculative', 'pack_battle')
          AND p.customer_email IS NOT NULL
          AND p.created_at >= datetime('now', '-31 days')
          AND p.created_at > COALESCE(
              (SELECT MAX(sent_at) FROM speculative_shipping_dms d WHERE d.customer_email = p.customer_email),
              '1970-01-01'
          )
          AND p.customer_email NOT IN (
              SELECT customer_email FROM shipping_payments
              WHERE created_at >= datetime('now', '-5 hours', 'start of day', 'weekday 1', '-7 days', '+5 hours')
          )
    `),

    getPurchaseCount: db.prepare(`
        SELECT total_purchases FROM purchase_counts WHERE discord_user_id = ?
    `),

    incrementPurchaseCount: db.prepare(`
        INSERT INTO purchase_counts (discord_user_id, total_purchases)
        VALUES (?, 1)
        ON CONFLICT(discord_user_id) DO UPDATE SET total_purchases = total_purchases + 1
    `),

    getDiscordIdByEmail: db.prepare(`
        SELECT discord_user_id FROM discord_links WHERE customer_email = ?
    `),

    getEmailByDiscordId: db.prepare(`
        SELECT customer_email FROM discord_links WHERE discord_user_id = ?
    `),

    linkDiscord: db.prepare(`
        INSERT OR REPLACE INTO discord_links (discord_user_id, customer_email) VALUES (?, ?)
    `),

    getUnshipped: db.prepare(`
        SELECT * FROM purchases WHERE shipped_at IS NULL AND discord_user_id IS NOT NULL
    `),

    getUnshippedNoDiscord: db.prepare(`
        SELECT * FROM purchases WHERE shipped_at IS NULL AND discord_user_id IS NULL
    `),

    markShipped: db.prepare(`
        UPDATE purchases SET shipped_at = datetime('now') WHERE shipped_at IS NULL
    `),

    getRecentByDiscordId: db.prepare(`
        SELECT * FROM purchases WHERE discord_user_id = ? ORDER BY id DESC LIMIT 1
    `),

    getRecentsByDiscordId: db.prepare(`
        SELECT * FROM purchases WHERE discord_user_id = ? ORDER BY id DESC LIMIT 10
    `),

    getBySessionId: db.prepare(`
        SELECT * FROM purchases WHERE stripe_session_id = ?
    `),

    updateShippingAddress: db.prepare(`
        UPDATE purchases
        SET shipping_name = ?, shipping_address = ?, shipping_city = ?, shipping_state = ?, shipping_postal_code = ?, shipping_country = ?
        WHERE stripe_session_id = ?
    `),

    setShippingEasyOrderId: db.prepare(`
        UPDATE purchases SET shippingeasy_order_id = ? WHERE stripe_session_id = ?
    `),

    markShippingEasyCanceled: db.prepare(`
        UPDATE purchases SET shippingeasy_canceled_at = datetime('now') WHERE stripe_session_id = ?
    `),

    /**
     * Mark every purchases row for a Stripe session as refunded. A multi-line
     * order produces N rows sharing one stripe_session_id, so this is a bulk
     * update by design. Idempotent — re-running keeps the original
     * refunded_at; refund_amount tracks the cumulative refund (latest wins on
     * the off-chance of a partial-then-full sequence).
     */
    markRefunded: db.prepare(`
        UPDATE purchases
        SET refunded_at = COALESCE(refunded_at, datetime('now')),
            refund_amount = ?,
            refund_reason = ?
        WHERE stripe_session_id = ?
    `),

    decrementPurchaseCountBySession: db.prepare(`
        UPDATE purchase_counts
        SET total_purchases = MAX(0, total_purchases - (
            SELECT COUNT(*) FROM purchases
            WHERE stripe_session_id = ? AND discord_user_id = purchase_counts.discord_user_id
        ))
        WHERE discord_user_id = (
            SELECT discord_user_id FROM purchases WHERE stripe_session_id = ? LIMIT 1
        )
    `),

    getPendingShipments: db.prepare(`
        SELECT p.* FROM purchases p
        WHERE p.shippingeasy_order_id IS NOT NULL
          AND p.shipped_at IS NULL
          AND p.shippingeasy_canceled_at IS NULL
          AND p.shipping_address IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM tracking t WHERE t.customer_email = p.customer_email AND t.created_at >= p.created_at)
    `),

    getReadyShipments: db.prepare(`
        SELECT p.*, t.tracking_number, t.carrier, t.tracking_url
        FROM purchases p
        JOIN tracking t ON t.customer_email = p.customer_email AND t.created_at >= p.created_at
        WHERE p.shippingeasy_order_id IS NOT NULL
          AND p.shipped_at IS NULL
          AND p.shippingeasy_canceled_at IS NULL
    `),

    getShipmentsByDiscordId: db.prepare(`
        SELECT p.*, t.tracking_number, t.carrier, t.tracking_url
        FROM purchases p
        LEFT JOIN tracking t ON t.customer_email = p.customer_email AND t.created_at >= p.created_at
        WHERE p.discord_user_id = ? AND p.shipping_address IS NOT NULL
        ORDER BY p.created_at DESC LIMIT 10
    `),
};

// =========================================================================
// Battles
// =========================================================================

const battleStmts = {
    getNextBattleNumber: db.prepare(`
        SELECT COALESCE(MAX(battle_number), 0) + 1 as next FROM battles WHERE battle_number IS NOT NULL
    `),

    createBattle: db.prepare(`
        INSERT INTO battles (product_slug, product_name, stripe_price_id, max_entries, channel_message_id)
        VALUES (?, ?, ?, ?, ?)
    `),

    setBattleNumber: db.prepare(`
        UPDATE battles SET battle_number = ? WHERE id = ?
    `),

    getActiveBattle: db.prepare(`
        SELECT * FROM battles WHERE status = 'open' ORDER BY created_at DESC LIMIT 1
    `),

    getBattleById: db.prepare(`
        SELECT * FROM battles WHERE id = ?
    `),

    closeBattle: db.prepare(`
        UPDATE battles SET status = 'closed', closed_at = datetime('now') WHERE id = ?
    `),

    deleteBattle: db.prepare(`
        DELETE FROM battles WHERE id = ?
    `),

    cancelBattle: db.prepare(`
        UPDATE battles SET status = 'cancelled', closed_at = datetime('now') WHERE id = ?
    `),

    setBattleWinner: db.prepare(`
        UPDATE battles SET status = 'complete', winner_id = ? WHERE id = ?
    `),

    setBattleMessage: db.prepare(`
        UPDATE battles SET channel_message_id = ? WHERE id = ?
    `),

    addEntry: db.prepare(`
        INSERT OR IGNORE INTO battle_entries (battle_id, discord_user_id)
        SELECT ?, ?
        WHERE (SELECT COUNT(*) FROM battle_entries WHERE battle_id = ?) < (SELECT max_entries FROM battles WHERE id = ?)
    `),

    confirmPayment: db.prepare(`
        UPDATE battle_entries SET paid = 1, stripe_session_id = ? WHERE battle_id = ? AND discord_user_id = ?
    `),

    getEntries: db.prepare(`
        SELECT * FROM battle_entries WHERE battle_id = ?
    `),

    getPaidEntries: db.prepare(`
        SELECT * FROM battle_entries WHERE battle_id = ? AND paid = 1
    `),

    getEntryCount: db.prepare(`
        SELECT COUNT(*) as count FROM battle_entries WHERE battle_id = ?
    `),

    getPaidEntryCount: db.prepare(`
        SELECT COUNT(*) as count FROM battle_entries WHERE battle_id = ? AND paid = 1
    `),
};

// =========================================================================
// Duck Races
// =========================================================================

const duckStmts = {
    addEntry: db.prepare(`
        INSERT OR IGNORE INTO duck_race_entries (race_id, discord_user_id, stripe_session_id)
        VALUES (?, ?, ?)
    `),

    getEntries: db.prepare(`
        SELECT * FROM duck_race_entries WHERE race_id = ?
    `),
};

// =========================================================================
// Queues
// =========================================================================

const queueStmts = {
    createQueue: db.prepare(`
        INSERT INTO queues (status) VALUES ('open')
    `),

    getActiveQueue: db.prepare(`
        SELECT * FROM queues WHERE status = 'open' ORDER BY created_at DESC LIMIT 1
    `),

    getQueueById: db.prepare(`
        SELECT * FROM queues WHERE id = ?
    `),

    closeQueue: db.prepare(`
        UPDATE queues SET status = 'closed', closed_at = datetime('now') WHERE id = ?
    `),

    claimForRace: db.prepare(`
        UPDATE queues SET status = 'racing' WHERE id = ? AND status IN ('open', 'closed')
    `),

    setDuckRaceWinner: db.prepare(`
        UPDATE queues SET status = 'complete', duck_race_winner_id = ? WHERE id = ?
    `),

    addEntry: db.prepare(`
        INSERT INTO queue_entries (queue_id, discord_user_id, customer_email, product_name, quantity, stripe_session_id)
        VALUES (?, ?, ?, ?, ?, ?)
    `),

    getEntries: db.prepare(`
        SELECT * FROM queue_entries WHERE queue_id = ? ORDER BY created_at ASC
    `),

    getUniqueBuyers: db.prepare(`
        SELECT DISTINCT COALESCE(discord_user_id, customer_email) AS buyer FROM queue_entries WHERE queue_id = ?
    `),

    getEntryCount: db.prepare(`
        SELECT COUNT(*) as count FROM queue_entries WHERE queue_id = ?
    `),

    setChannelMessage: db.prepare(`
        UPDATE queues SET channel_message_id = ? WHERE id = ?
    `),

    getRecentQueues: db.prepare(`
        SELECT * FROM queues WHERE status IN ('closed', 'complete') ORDER BY created_at DESC LIMIT ?
    `),
};

// =========================================================================
// Livestream Sessions
// =========================================================================

const livestreamStmts = {
    startSession: db.prepare(`
        INSERT INTO livestream_sessions (status) VALUES ('active')
    `),

    getActiveSession: db.prepare(`
        SELECT * FROM livestream_sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1
    `),

    endSession: db.prepare(`
        UPDATE livestream_sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?
    `),

    addBuyer: db.prepare(`
        INSERT OR IGNORE INTO livestream_buyers (session_id, discord_user_id, customer_email)
        VALUES (?, ?, ?)
    `),

    getBuyers: db.prepare(`
        SELECT * FROM livestream_buyers WHERE session_id = ? AND shipping_paid = 0
    `),

    markShippingPaid: db.prepare(`
        UPDATE livestream_buyers SET shipping_paid = 1 WHERE session_id = ? AND customer_email = ?
    `),

    hasShippingThisWeek: db.prepare(`
        SELECT 1 FROM livestream_buyers
        WHERE customer_email = ?
          AND shipping_paid = 1
          AND created_at >= datetime('now', '-5 hours', 'start of day', 'weekday 1', '-7 days', '+5 hours')
        LIMIT 1
    `),
};

// =========================================================================
// Shipping Payments
// =========================================================================

const shippingStmts = {
    record: db.prepare(`
        INSERT OR IGNORE INTO shipping_payments (customer_email, discord_user_id, amount, source, stripe_session_id)
        VALUES (?, ?, ?, ?, ?)
    `),

    hasShippingThisWeek: db.prepare(`
        SELECT 1 FROM shipping_payments
        WHERE customer_email = ?
          AND created_at >= datetime('now', '-5 hours', 'start of day', 'weekday 1', '-7 days', '+5 hours')
        LIMIT 1
    `),

    hasShippingThisMonth: db.prepare(`
        SELECT 1 FROM shipping_payments
        WHERE customer_email = ?
          AND strftime('%Y-%m', created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')
        LIMIT 1
    `),

    getByEmailThisWeek: db.prepare(`
        SELECT * FROM shipping_payments
        WHERE customer_email = ?
          AND created_at >= datetime('now', '-5 hours', 'start of day', 'weekday 1', '-7 days', '+5 hours')
        ORDER BY created_at DESC LIMIT 1
    `),

    getByEmailThisMonth: db.prepare(`
        SELECT * FROM shipping_payments
        WHERE customer_email = ?
          AND strftime('%Y-%m', created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')
        ORDER BY created_at DESC LIMIT 1
    `),

    deleteById: db.prepare(`
        DELETE FROM shipping_payments WHERE id = ?
    `),

    getThisWeek: db.prepare(`
        SELECT * FROM shipping_payments
        WHERE created_at >= datetime('now', '-5 hours', 'start of day', 'weekday 1', '-7 days', '+5 hours')
    `),

    getThisMonth: db.prepare(`
        SELECT * FROM shipping_payments
        WHERE strftime('%Y-%m', created_at, '-5 hours') = strftime('%Y-%m', 'now', '-5 hours')
    `),
};

// =========================================================================
// Discord Links — country management
// =========================================================================

const discordLinkStmts = {
    setCountry: db.prepare(`
        UPDATE discord_links SET country = ? WHERE discord_user_id = ?
    `),

    getCountry: db.prepare(`
        SELECT country FROM discord_links WHERE discord_user_id = ?
    `),

    getCountryByEmail: db.prepare(`
        SELECT country FROM discord_links WHERE customer_email = ?
    `),

    getInternationalUsers: db.prepare(`
        SELECT * FROM discord_links WHERE country IS NOT NULL AND country != 'US'
    `),
};

// =========================================================================
// Card Listings
// =========================================================================

const cardListingStmts = {
    create: db.prepare(`
        INSERT INTO card_listings (card_name, price, buyer_discord_id, status)
        VALUES (?, ?, ?, ?)
    `),

    setMessageId: db.prepare(`
        UPDATE card_listings SET message_id = ? WHERE id = ?
    `),

    setStripeSessionId: db.prepare(`
        UPDATE card_listings SET stripe_session_id = ? WHERE id = ?
    `),

    getById: db.prepare(`
        SELECT * FROM card_listings WHERE id = ?
    `),

    getByMessageId: db.prepare(`
        SELECT * FROM card_listings WHERE message_id = ?
    `),

    getByStripeSessionId: db.prepare(`
        SELECT * FROM card_listings WHERE stripe_session_id = ?
    `),

    markSold: db.prepare(`
        UPDATE card_listings SET status = 'sold', sold_at = datetime('now') WHERE id = ?
    `),

    markExpired: db.prepare(`
        UPDATE card_listings SET status = 'expired' WHERE id = ?
    `),

    relistAsActive: db.prepare(`
        UPDATE card_listings SET status = 'active', buyer_discord_id = NULL, stripe_session_id = NULL WHERE id = ?
    `),

    getByStatus: db.prepare(`
        SELECT * FROM card_listings WHERE status = ? ORDER BY created_at DESC LIMIT 1
    `),

    incrementPurchaseCount: db.prepare(`
        UPDATE card_listings SET purchase_count = purchase_count + 1 WHERE id = ?
    `),

    setMaxQuantity: db.prepare(`
        UPDATE card_listings SET max_quantity = ? WHERE id = ?
    `),

    incrementPurchaseCountCapped: db.prepare(`
        UPDATE card_listings
        SET purchase_count = purchase_count + ?
        WHERE id = ? AND status = 'pull'
          AND (max_quantity IS NULL OR purchase_count + ? <= max_quantity)
    `),

    setBuyerDmMessageId: db.prepare(`
        UPDATE card_listings SET buyer_dm_message_id = ? WHERE id = ?
    `),

    reserveForBuyer: db.prepare(`
        UPDATE card_listings SET status = 'reserved', buyer_discord_id = ? WHERE id = ? AND status = 'active'
    `),

    getBySessionId: db.prepare(`
        SELECT * FROM card_listings WHERE list_session_id = ? ORDER BY id ASC
    `),

    createWithSession: db.prepare(`
        INSERT INTO card_listings (card_name, price, buyer_discord_id, status, list_session_id)
        VALUES (?, ?, ?, ?, ?)
    `),

    expireBySessionId: db.prepare(`
        UPDATE card_listings SET status = 'expired' WHERE list_session_id = ? AND status IN ('active', 'reserved')
    `),
};

// =========================================================================
// Pull Entries
// =========================================================================

const pullEntryStmts = {
    addEntry: db.prepare(`
        INSERT INTO pull_entries (listing_id, discord_user_id, customer_email, quantity) VALUES (?, ?, ?, ?)
    `),

    getEntries: db.prepare(`
        SELECT * FROM pull_entries WHERE listing_id = ? ORDER BY created_at ASC
    `),
};

// =========================================================================
// Community Goals
// =========================================================================

const goalStmts = {
    get: db.prepare(`SELECT * FROM community_goals WHERE id = 1`),

    addRevenue: db.prepare(`
        UPDATE community_goals
        SET cycle_revenue = cycle_revenue + ?,
            lifetime_revenue = lifetime_revenue + ?
        WHERE id = 1
    `),

    resetCycle: db.prepare(`
        UPDATE community_goals
        SET cycle = cycle + 1,
            cycle_revenue = cycle_revenue - ?
        WHERE id = 1
    `),

    setMessageId: db.prepare(`
        UPDATE community_goals SET channel_message_id = ? WHERE id = 1
    `),
};

// =========================================================================
// Giveaways
// =========================================================================

const giveawayStmts = {
    create: db.prepare(`
        INSERT INTO giveaways (prize_name, ends_at, is_social, social_link) VALUES (?, ?, ?, ?)
    `),

    getActive: db.prepare(`
        SELECT * FROM giveaways WHERE status = 'open' ORDER BY id DESC LIMIT 1
    `),

    getById: db.prepare(`
        SELECT * FROM giveaways WHERE id = ?
    `),

    getByMessageId: db.prepare(`
        SELECT * FROM giveaways WHERE channel_message_id = ?
    `),

    close: db.prepare(`
        UPDATE giveaways SET status = 'closed', closed_at = datetime('now') WHERE id = ?
    `),

    cancel: db.prepare(`
        UPDATE giveaways SET status = 'cancelled', closed_at = datetime('now') WHERE id = ?
    `),

    setWinner: db.prepare(`
        UPDATE giveaways SET status = 'complete', winner_id = ? WHERE id = ?
    `),

    setMessageId: db.prepare(`
        UPDATE giveaways SET channel_message_id = ? WHERE id = ?
    `),

    addEntry: db.prepare(`
        INSERT OR IGNORE INTO giveaway_entries (giveaway_id, discord_user_id, tiktok_username) VALUES (?, ?, ?)
    `),

    getEntries: db.prepare(`
        SELECT * FROM giveaway_entries WHERE giveaway_id = ? ORDER BY created_at ASC
    `),

    getEntryCount: db.prepare(`
        SELECT COUNT(*) as count FROM giveaway_entries WHERE giveaway_id = ?
    `),

    hasEntry: db.prepare(`
        SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND discord_user_id = ? LIMIT 1
    `),

    getEntryByUser: db.prepare(`
        SELECT * FROM giveaway_entries WHERE giveaway_id = ? AND discord_user_id = ? LIMIT 1
    `),

    getExpired: db.prepare(`
        SELECT * FROM giveaways WHERE status = 'open' AND ends_at IS NOT NULL AND ends_at <= datetime('now')
    `),
};

// =========================================================================
// Coupons
// =========================================================================

// =========================================================================
// List Sessions
// =========================================================================

const listSessionStmts = {
    create: db.prepare(`INSERT INTO list_sessions (status) VALUES ('open')`),

    getActive: db.prepare(`SELECT * FROM list_sessions WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`),

    getById: db.prepare(`SELECT * FROM list_sessions WHERE id = ?`),

    setMessageId: db.prepare(`UPDATE list_sessions SET message_id = ? WHERE id = ?`),

    close: db.prepare(`UPDATE list_sessions SET status = 'closed', closed_at = datetime('now') WHERE id = ?`),
};

const couponStmts = {
    activate: db.prepare(`
        INSERT INTO active_coupons (promo_code, stripe_promo_id, stripe_coupon_id, discount_display)
        SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM active_coupons WHERE status = 'active')
    `),

    getActive: db.prepare(`
        SELECT * FROM active_coupons WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1
    `),

    deactivate: db.prepare(`
        UPDATE active_coupons SET status = 'inactive', deactivated_at = datetime('now') WHERE id = ?
    `),
};

// =========================================================================
// Tracking
// =========================================================================

const trackingStmts = {
    add: db.prepare(`
        INSERT INTO tracking (customer_email, discord_user_id, tracking_number, carrier, carrier_service, tracking_url)
        VALUES (?, ?, ?, ?, ?, ?)
    `),

    getByEmail: db.prepare(`
        SELECT * FROM tracking WHERE customer_email = ? ORDER BY created_at DESC
    `),

    getByDiscordId: db.prepare(`
        SELECT * FROM tracking WHERE discord_user_id = ? ORDER BY created_at DESC
    `),

    getRecentByEmail: db.prepare(`
        SELECT * FROM tracking WHERE customer_email = ? ORDER BY created_at DESC LIMIT 1
    `),

    getAll: db.prepare(`
        SELECT * FROM tracking ORDER BY created_at DESC
    `),
};

// =========================================================================
// Analytics
// =========================================================================

const analyticsStmts = {
    getRangeStats: db.prepare(`
        SELECT
            COALESCE(SUM(amount), 0) as total_revenue,
            COUNT(*) as order_count,
            COUNT(DISTINCT COALESCE(discord_user_id, customer_email)) as unique_buyers
        FROM purchases
        WHERE created_at >= ? AND created_at < ?
    `),

    getTopProducts: db.prepare(`
        SELECT product_name, COUNT(*) as count, SUM(amount) as revenue
        FROM purchases
        WHERE created_at >= ? AND created_at < ?
        GROUP BY product_name
        ORDER BY revenue DESC
        LIMIT 5
    `),

    getStreamCount: db.prepare(`
        SELECT COUNT(*) as count FROM livestream_sessions
        WHERE created_at >= ? AND created_at < ?
    `),

    getNewBuyerCount: db.prepare(`
        SELECT COUNT(DISTINCT buyer) as count FROM (
            SELECT COALESCE(discord_user_id, customer_email) as buyer
            FROM purchases
            WHERE created_at >= ? AND created_at < ?
            AND COALESCE(discord_user_id, customer_email) NOT IN (
                SELECT COALESCE(discord_user_id, customer_email)
                FROM purchases
                WHERE created_at < ?
            )
        )
    `),

    getBattleCount: db.prepare(`
        SELECT COUNT(*) as count FROM battles
        WHERE created_at >= ? AND created_at < ?
        AND status = 'complete'
    `),

    getShippingStats: db.prepare(`
        SELECT
            COALESCE(SUM(amount), 0) as total_shipping,
            COUNT(*) as shipping_count
        FROM shipping_payments
        WHERE created_at >= ? AND created_at < ?
    `),

    getCardSaleCount: db.prepare(`
        SELECT COUNT(*) as count FROM card_listings
        WHERE sold_at >= ? AND sold_at < ?
        AND status = 'sold'
    `),
};

const welcomeStmts = {
    getConfig: db.prepare('SELECT * FROM welcome_config WHERE id = 1'),
    setMessageId: db.prepare('UPDATE welcome_config SET channel_message_id = ? WHERE id = 1'),
};

const minecraftStmts = {
    getConfig: db.prepare('SELECT * FROM minecraft_config WHERE id = 1'),
    setMessageId: db.prepare('UPDATE minecraft_config SET channel_message_id = ? WHERE id = 1'),
};

const lfgStmts = {
    getConfig: db.prepare('SELECT * FROM lfg_config WHERE id = 1'),
    setMessageId: db.prepare('UPDATE lfg_config SET channel_message_id = ? WHERE id = 1'),
};

const stripeEventStmts = {
    /**
     * Returns true on the FIRST attempt to process this event id, false
     * on any retry (Stripe re-delivers on non-2xx or timeout). Use as the
     * very first guard inside the express webhook handler.
     */
    claimEvent: db.prepare(`INSERT OR IGNORE INTO processed_stripe_events (event_id) VALUES (?)`),
    pruneOlderThan: db.prepare(`DELETE FROM processed_stripe_events WHERE received_at < datetime('now', ?)`),
};

const activityEventStmts = {
    /** Record a broadcast event. Called from queue-broadcaster.js so a
     *  single capture point covers queue mutations + envelope events. */
    insert: db.prepare(`
        INSERT INTO activity_events (event, data)
        VALUES (?, ?)
    `),
    /** Most-recent-first list of activity events for the homepage feed
     *  backfill on page mount. limit defaults to 50 at the call site
     *  (matches ACTIVITY_FEED_CAP on the frontend). */
    recent: db.prepare(`
        SELECT id, event, data, created_at
        FROM activity_events
        ORDER BY id DESC
        LIMIT ?
    `),
};

const tosAcceptanceStmts = {
    /** Does this Discord user have an acceptance row for this version? */
    has: db.prepare(`
        SELECT 1 FROM discord_tos_acceptances
        WHERE discord_user_id = ? AND terms_version = ?
        LIMIT 1
    `),
    /** Record a fresh acceptance. Multiple acceptances per user are fine
     *  — we keep the full audit trail; the latest is used for metadata. */
    insert: db.prepare(`
        INSERT INTO discord_tos_acceptances (discord_user_id, terms_version, source)
        VALUES (?, ?, ?)
    `),
    /** Get the most recent acceptance row for a user — used by
     *  metadataFor() to attach the original accepted_at timestamp to
     *  Stripe metadata, not the time of the actual purchase. */
    getLatest: db.prepare(`
        SELECT * FROM discord_tos_acceptances
        WHERE discord_user_id = ?
        ORDER BY id DESC
        LIMIT 1
    `),
};

export {
    db,
    stmts as purchases,
    battleStmts as battles,
    duckStmts as ducks,
    queueStmts as queues,
    livestreamStmts as livestream,
    cardListingStmts as cardListings,
    listSessionStmts as listSessions,
    goalStmts as goals,
    analyticsStmts as analytics,
    giveawayStmts as giveaways,
    couponStmts as coupons,
    shippingStmts as shipping,
    discordLinkStmts as discordLinks,
    welcomeStmts as welcome,
    minecraftStmts as minecraft,
    lfgStmts as lfg,
    pullEntryStmts as pullEntries,
    trackingStmts as tracking,
    stripeEventStmts as stripeEvents,
    tosAcceptanceStmts as tosAcceptances,
    activityEventStmts as activityEvents,
};
