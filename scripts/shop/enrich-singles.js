/**
 * Enrich the Singles tab via the Pokemon TCG API.
 *
 * Assumes the sheet has been migrated to the A-T schema (see
 * scripts/shop/migrate-singles-schema.js). For each row, queries
 * api.pokemontcg.io with parsed Card Name + Card Number and fills
 * the still-blank enrichment slots:
 *
 *   I  Set Name        (only if blank — preserves manual overrides)
 *   J  Set Code        (only if blank)
 *   L  Rarity          (normalized to one of: common, uncommon, rare,
 *                        holo-rare, ultra-rare, secret, promo)
 *   O  Image URL
 *   P  Release Year
 *   Q  Artist
 *   R  Pokemon TCG API ID (e.g. "base1-4")
 *
 * Idempotent — skips rows that are already fully enriched. Logs
 * unmatched rows so they can be hand-corrected.
 *
 * Usage:
 *   node scripts/shop/enrich-singles.js --dry-run
 *   node scripts/shop/enrich-singles.js
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(process.env.HOME, '.config/google/sheets-credentials.json');
const SPREADSHEET_ID = '1erx1dUZ9YIwpg5xbXP_OFrE4i1dV97RoE7M0rsv_JkM';
const SHEET_NAME = 'Singles';
const API_BASE = 'https://api.pokemontcg.io/v2';
const THROTTLE_MS = 400; // free tier = ~30 req/min; keep us well under
const API_KEY = process.env.POKEMON_TCG_API_KEY || '';
const MAX_RETRIES = 3;

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const LIMIT_ARG = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : Infinity;
const ROW_ARG = process.argv.find((a) => a.startsWith('--row='));
const ONLY_ROW = ROW_ARG ? parseInt(ROW_ARG.split('=')[1], 10) : null;
// Process only rows that have a variant marker in column K (Full Art,
// Secret, Alternate Art, etc.). Useful for targeted re-runs after a
// scorer change that affects variant disambiguation.
const VARIANTS_ONLY = process.argv.includes('--variants-only');
// Process only rows where column H carries a letter-prefixed number
// (SWSH076, XY69, SM213). These signal promos and are sensitive to the
// letter-prefix matching rule in scoreCandidate.
const PREFIX_ONLY = process.argv.includes('--prefix-only');

// Column indices for the A-T schema.
const COL = {
    A: 0, // Card Name
    H: 7, // Card Number
    I: 8, // Set Name
    J: 9, // Set Code
    K: 10, // Variant
    L: 11, // Rarity
    O: 14, // Image URL
    P: 15, // Release Date (YYYY-MM-DD)
    Q: 16, // Artist
    R: 17, // Pokemon TCG API ID
    T: 19, // Notes
};

const RARITY_MAP = {
    common: 'common',
    uncommon: 'uncommon',
    rare: 'rare',
    'rare holo': 'holo-rare',
    'rare holo ex': 'holo-rare',
    'rare holo gx': 'ultra-rare',
    'rare holo v': 'ultra-rare',
    'rare holo vmax': 'ultra-rare',
    'rare holo vstar': 'ultra-rare',
    'rare holo lv.x': 'ultra-rare',
    'rare ultra': 'ultra-rare',
    'rare secret': 'secret',
    'rare rainbow': 'secret',
    'rare shiny': 'ultra-rare',
    'rare shiny gx': 'ultra-rare',
    'rare shiny v': 'ultra-rare',
    'rare shining': 'ultra-rare',
    'rare prism star': 'ultra-rare',
    'rare break': 'ultra-rare',
    'rare ace': 'ultra-rare',
    'amazing rare': 'ultra-rare',
    'rare prime': 'ultra-rare',
    'rare holo star': 'ultra-rare',
    'rare radiant': 'ultra-rare',
    promo: 'promo',
    'rare promo': 'promo',
    'classic collection': 'secret',
    'illustration rare': 'secret',
    'special illustration rare': 'secret',
    'hyper rare': 'secret',
    'double rare': 'ultra-rare',
    'ultra rare': 'ultra-rare',
    'trainer gallery rare holo': 'holo-rare',
};

function normalizeRarity(apiRarity) {
    if (!apiRarity) return '';
    const key = apiRarity.toLowerCase().trim();
    return RARITY_MAP[key] || 'rare'; // safe fallback
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize a card-number string for Pokemon TCG API queries.
 *
 * The API stores promo numbers verbatim with the set prefix ("XY69",
 * "SWSH001") but set-card numbers without the total ("83" not "83/116").
 * We try the raw form first, then fall back to a letters-stripped
 * version for the odd set that uses the bare digits.
 */
function normalizeNumber(number) {
    if (!number) return null;

    // "83/116" → "83"; leave promo numbers like "XY69" intact.
    const raw = number.includes('/') ? number.split('/')[0] : number;

    // "XY69" → "69" fallback in case the API happens to use the stripped form
    const stripped = raw.replace(/^[A-Za-z]+/, '');

    return {
        raw,
        stripped: stripped || raw,
    };
}

/**
 * Strip trailing parenthetical content from a card name
 * ("Rapid Strike Urshifu VMAX (Alternate Art Secret)" → "Rapid Strike
 * Urshifu VMAX"). Also pulls out an embedded number if one appears in
 * the parens like "(146 Full Art)".
 */
function stripParensFromName(name) {
    let cleaned = name;
    let embeddedNumber = null;
    const variantParts = [];
    while (true) {
        const m = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(cleaned);
        if (!m) break;
        const inner = m[2].trim();
        // Detect number inside parens (e.g. "146 Full Art", "176")
        const numMatch = /^(\d+)(?:\s+.+)?$/.exec(inner);
        if (numMatch && !embeddedNumber) embeddedNumber = numMatch[1];
        // Capture non-numeric paren content as a variant hint (e.g. "Full Art",
        // "Alternate Art Secret", "Rainbow Rare"). Strip leading number if any.
        const variantText = inner.replace(/^\d+\s*/, '').trim();
        if (variantText) variantParts.push(variantText);
        cleaned = m[1].trim();
    }
    return {
        name: cleaned,
        embeddedNumber,
        variantText: variantParts.join(' '),
    };
}

/**
 * Generate alternate spellings of a card name that the API might use.
 * The Pokemon TCG API hyphenates form suffixes (`Rayquaza EX` →
 * `Rayquaza-EX`, `Umbreon VMAX` → `Umbreon-VMAX`).
 */
function nameVariants(name) {
    const variants = [name];
    const HYPHEN_SUFFIXES = ['EX', 'GX', 'V', 'VMAX', 'VSTAR', 'BREAK', 'LV.X'];
    for (const suffix of HYPHEN_SUFFIXES) {
        const re = new RegExp('\\s+' + suffix.replace(/\./g, '\\.') + '\\b', 'g');
        if (re.test(name)) {
            const hyphenated = name.replace(re, '-' + suffix);
            if (!variants.includes(hyphenated)) variants.push(hyphenated);
        }
    }
    return variants;
}

/**
 * Strip the subset qualifier from a "Parent: Subset" hint for API
 * lookup. The Pokemon TCG API stores subset cards (Radiant Collection,
 * Shiny Vault, Trainer Gallery, etc.) under the parent set's name; the
 * subset itself is encoded in the card's number prefix. So
 * "Generations: Radiant Collection" → query "Generations".
 *
 * The subset hint stays in setHint for scoring (drives the
 * SUBSET_PREFIXES match in scoreCandidate).
 */
function setNameForQuery(setHint) {
    if (!setHint) return '';
    const m = /^([A-Z][a-zA-Z\s]+?):\s*.+$/.exec(setHint);
    return m ? m[1].trim() : setHint;
}

/**
 * Build a Pokemon TCG API query. Prefers name + stripped number + set name.
 */
function buildQuery(name, number, setHint) {
    const parts = [];
    const safeName = name.replace(/"/g, '\\"');
    parts.push(`name:"${safeName}"`);

    if (number) {
        parts.push(`number:"${number}"`);
    }

    if (setHint) {
        const querySetName = setNameForQuery(setHint);
        const safeSet = querySetName.replace(/"/g, '\\"');
        parts.push(`set.name:"${safeSet}"`);
    }

    return parts.join(' ');
}

async function fetchCards(query) {
    // pageSize=50 so broad name-only queries return the full pool for a
    // given card name; the scorer then picks the right set out of it.
    const url = `${API_BASE}/cards?q=${encodeURIComponent(query)}&pageSize=50`;
    const headers = API_KEY ? { 'X-Api-Key': API_KEY } : {};

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const res = await fetch(url, { headers });
        if (res.ok) {
            const data = await res.json();
            return data.data || [];
        }
        if (res.status === 429) {
            const backoff = 2000 * (attempt + 1);
            await sleep(backoff);
            continue;
        }
        throw new Error(`Pokemon TCG API ${res.status}: ${await res.text()}`);
    }
    throw new Error(`Pokemon TCG API 429 after ${MAX_RETRIES} retries`);
}

/**
 * Strip the user's internal set prefix ("SWSH05: ", "SWSH09: ", etc.)
 * from the beginning of a set hint. The API uses bare set names.
 */
function cleanSetHint(hint) {
    if (!hint) return '';
    return hint.replace(/^[A-Z]+\d*:\s*/, '').trim();
}

const STOPWORDS = new Set([
    'the', 'and', 'or', 'of', 'a', 'an',
    'set', 'sets', 'promos', 'promo', 'exclusive', 'exclusives',
    'collection', 'cards', 'card',
]);

function tokenize(s) {
    return (s || '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Score a candidate card against what we know. Higher is better.
 *
 * Dimensions:
 *   - exact name match (case-insensitive)        +100
 *   - name is substring match                     +40
 *   - exact card number match                     +80
 *   - number match ignoring leading letters       +40
 *   - user set hint tokens ⊆ API set name tokens  +15 per token
 *   - user set hint tokens ⊇ API set name tokens  +10 per token
 *   - user set code appears in API set ID         +25
 *   - Number-only name collision penalty          -50
 *     (if we expected a card with "EX/GX/V" and
 *     matched a base form without it)
 */
function normalizeName(s) {
    // Treat hyphens and spaces as equivalent so "Venusaur-EX" and
    // "Venusaur EX" compare as identical. Case-insensitive.
    return (s || '')
        .toLowerCase()
        .replace(/[-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreCandidate(candidate, { name, number, setHint, setCode, variant }) {
    let score = 0;

    const apiName = normalizeName(candidate.name);
    const userName = normalizeName(name);
    if (apiName === userName) score += 100;
    else if (apiName.includes(userName)) score += 40;
    else if (userName.includes(apiName)) score += 20;

    // Penalty if user expects a form suffix (EX/GX/V/VMAX/VSTAR) and API result lacks it
    const FORMS = ['ex', 'gx', 'v', 'vmax', 'vstar', 'break', 'lv.x'];
    const userForm = FORMS.find((f) =>
        new RegExp('(^|[\\s-])' + f.replace(/\./g, '\\.') + '$', 'i').test(userName.trim()),
    );
    const apiForm = FORMS.find((f) =>
        new RegExp('(^|[\\s-])' + f.replace(/\./g, '\\.') + '$', 'i').test(apiName.trim()),
    );
    if (userForm && userForm !== apiForm) score -= 50;

    const apiNum = (candidate.number || '').toLowerCase();
    const userNum = (number || '').toLowerCase();
    if (userNum) {
        if (apiNum === userNum) score += 80;
        else {
            const userStripped = userNum.replace(/^[a-z]+/, '');
            const apiStripped = apiNum.replace(/^[a-z]+/, '');
            if (userStripped && apiStripped && userStripped === apiStripped) score += 40;
            else if (userNum.includes('/') && userNum.split('/')[0] === apiNum) score += 40;
        }

        // Letter prefix on the number is a near-certain promo signal —
        // "SWSH076", "XY69", "SM213" tell us the card lives in a Black
        // Star Promos / similar promo set, not in the same-named main
        // set. Reward candidates that share the prefix; penalize ones
        // that don't, otherwise the set-name token overlap (e.g. user's
        // "SWSH: Sword & Shield Promo Cards" matching the *main* "Sword
        // & Shield" set) outscores the correct promo match.
        const userPrefix = (userNum.match(/^[a-z]+/i) || [''])[0];
        const apiPrefix = (apiNum.match(/^[a-z]+/i) || [''])[0];
        if (userPrefix) {
            if (apiPrefix === userPrefix) score += 60;
            else score -= 60;
        }
    }

    const apiSetName = (candidate.set?.name || '').toLowerCase();
    const apiSetId = (candidate.set?.id || '').toLowerCase();
    const userHintTokens = tokenize(setHint);
    const apiSetTokens = tokenize(apiSetName);

    // Set-matching is the critical differentiator when users have ambiguous
    // cards like "Yveltal" with no card number — weight it heavily enough
    // to outpace the older-first tiebreaker even with zero user signals.
    // Exact token match: +50 per overlap, bidirectional.
    const tokensInCommon = userHintTokens.filter((t) => apiSetTokens.includes(t));
    score += tokensInCommon.length * 50;

    // Full set-name substring match (API "Generations" ⊂ user "Generations:
    // Radiant Collection" or vice versa) — extra boost.
    if (apiSetName && setHint) {
        const hintLower = setHint.toLowerCase();
        if (apiSetName.length >= 3) {
            if (hintLower.includes(apiSetName)) score += 60;
            else if (apiSetName.includes(hintLower)) score += 60;
        }
    }

    if (setCode) {
        const userCodeLower = setCode.toLowerCase().trim();
        if (apiSetId === userCodeLower) score += 50;
        else if (apiSetId.startsWith(userCodeLower) || userCodeLower.startsWith(apiSetId)) score += 25;
    }

    // Sub-set prefix awareness. Several sets contain in-pack mini-sets
    // numbered with a letter prefix (Radiant Collection in Generations →
    // RC1–RC32, Shiny Vault in Hidden Fates → SV-, Trainer Gallery →
    // TG-, Galarian Gallery → GG-). When the user names the sub-set in
    // their hint, the matching API card carries the prefix in its number
    // — that's a stronger signal than rarity for these collections,
    // since many sub-set cards are full-art treatments of otherwise
    // common/holo printings (e.g. Pikachu RC29 is rarity "Rare Holo"
    // but is in fact the Full Art treatment).
    const SUBSET_PREFIXES = [
        { hint: /radiant\s*collection/i, prefix: 'RC' },
        { hint: /shiny\s*vault/i, prefix: 'SV' },
        { hint: /trainer\s*gallery/i, prefix: 'TG' },
        { hint: /galarian\s*gallery/i, prefix: 'GG' },
    ];
    if (setHint) {
        for (const { hint, prefix } of SUBSET_PREFIXES) {
            if (hint.test(setHint)) {
                const apiNum = (candidate.number || '').toUpperCase();
                if (apiNum.startsWith(prefix)) score += 70;
                else score -= 20;
                break;
            }
        }
    }

    // Variant-aware scoring. Without this, Full Art / Secret / Alt Art
    // listings collide with their plain-holo siblings within the same set
    // (e.g. BREAKpoint Darkrai EX has both #74 holo and #118 Full Art —
    // identical name + set tokens, scorer picks the lower number by
    // tiebreaker). Match the user's variant hint against the API rarity.
    if (variant) {
        const v = variant.toLowerCase();
        const apiRarity = (candidate.rarity || '').toLowerCase();

        const wantsArt = /full\s*art|alternate\s*art|alt\s*art/.test(v);
        const wantsSecret = /secret|rainbow|gold/.test(v);
        const wantsIllustration = /illustration/.test(v);

        if (wantsArt) {
            if (/ultra|secret|illustration|hyper|rainbow/.test(apiRarity)) score += 60;
            else if (/holo/.test(apiRarity) && !/ultra/.test(apiRarity)) score -= 30;
        }
        if (wantsSecret) {
            if (/secret|rainbow|hyper|illustration/.test(apiRarity)) score += 60;
        }
        if (wantsIllustration) {
            if (/illustration/.test(apiRarity)) score += 60;
        }
    }

    return score;
}

function pickBestMatch(candidates, context) {
    if (!candidates.length) return null;

    const scored = candidates.map((c) => ({ card: c, score: scoreCandidate(c, context) }));
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Tiebreaker: older releases first when no other signal
        // (helps keep "Generations" cards matched to the Generations set)
        const da = a.card.set?.releaseDate || '';
        const db = b.card.set?.releaseDate || '';
        return da.localeCompare(db);
    });

    return scored[0]?.card || null;
}

async function main() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A2:T`,
    });

    const rows = res.data.values || [];
    if (!rows.length) {
        console.log('No rows.');
        return;
    }

    console.log(`Scanning ${rows.length} rows...${DRY_RUN ? ' [dry-run]' : ''}\n`);

    const updates = [];
    const logs = {
        enriched: 0,
        alreadyComplete: 0,
        noMatch: [],
        apiError: [],
    };

    let processed = 0;
    for (let i = 0; i < rows.length; i++) {
        if (processed >= LIMIT) break;
        const row = rows[i];
        const sheetRow = i + 2;

        if (ONLY_ROW && sheetRow !== ONLY_ROW) continue;

        const name = (row[COL.A] || '').trim();
        const number = (row[COL.H] || '').trim();
        const rawSetHint = (row[COL.I] || '').trim();
        const setHint = cleanSetHint(rawSetHint);
        const setCode = (row[COL.J] || '').trim();
        const variantCol = (row[COL.K] || '').trim();

        if (!name) continue;
        if (VARIANTS_ONLY && !(row[COL.K] || '').trim()) continue;
        if (PREFIX_ONLY) {
            const h = (row[COL.H] || '').trim();
            // Match "SWSH076", "XY69", "SM213" — letters followed by digits.
            if (!/^[a-z]+\d/i.test(h)) continue;
        }

        // Skip fully-enriched rows unless --force
        const rarity = (row[COL.L] || '').trim();
        const image = (row[COL.O] || '').trim();
        const year = (row[COL.P] || '').trim();
        const artist = (row[COL.Q] || '').trim();
        const apiId = (row[COL.R] || '').trim();
        if (!FORCE && rarity && image && year && artist && apiId) {
            logs.alreadyComplete++;
            continue;
        }

        // Build a cascading list of queries and collect candidates from ALL
        // productive attempts (not just the first non-empty). The scorer then
        // picks the best across the full pool — important when a narrow
        // query returns a worse match than a broader one.
        const cleaned = stripParensFromName(name);
        const searchName = cleaned.name || name;

        // Column H sometimes holds a game-series tag like "SM" or "XY" rather
        // than a real card number. When H has no digits, prefer any number
        // embedded in the card title ("(205)") — that's usually the real
        // set-position, which the API indexes by.
        const hHasDigits = /\d/.test(number);
        const searchNumber = (hHasDigits ? number : '') || cleaned.embeddedNumber || '';
        const norm = normalizeNumber(searchNumber);
        const variants = nameVariants(searchName);
        const queryAttempts = [];

        // Most specific: name variant + number + set
        for (const v of variants) {
            if (norm && setHint) queryAttempts.push(buildQuery(v, norm.raw, setHint));
        }
        // name variant + number (raw and stripped)
        for (const v of variants) {
            if (norm) queryAttempts.push(buildQuery(v, norm.raw, null));
        }
        for (const v of variants) {
            if (norm && norm.stripped !== norm.raw) {
                queryAttempts.push(buildQuery(v, norm.stripped, null));
            }
        }
        // name variant + set (no number)
        for (const v of variants) {
            if (setHint) queryAttempts.push(buildQuery(v, null, setHint));
        }
        // Bare name variant
        for (const v of variants) {
            queryAttempts.push(buildQuery(v, null, null));
        }

        // De-duplicate queries before fetching
        const seenQueries = new Set();
        const allCandidates = new Map(); // id → card

        for (const q of queryAttempts) {
            if (seenQueries.has(q)) continue;
            seenQueries.add(q);
            try {
                const found = await fetchCards(q);
                for (const c of found) {
                    if (c?.id && !allCandidates.has(c.id)) {
                        allCandidates.set(c.id, c);
                    }
                }
            } catch (e) {
                logs.apiError.push({ row: sheetRow, name, error: e.message });
            }
            await sleep(THROTTLE_MS);

            // Early exit is disabled — the broader pool the scorer sees,
            // the better its set-matching can disambiguate. 50 results per
            // query × max a few queries is still cheap vs. being wrong.
        }

        const candidates = Array.from(allCandidates.values());
        // Combine column K (Variant) with any non-numeric paren content from
        // the card name — both signal the user's intended variant.
        const variant = [variantCol, cleaned.variantText].filter(Boolean).join(' ');
        const ctx = { name: searchName, number: searchNumber, setHint, setCode, variant };
        const match = pickBestMatch(candidates, ctx);
        if (!match) {
            logs.noMatch.push({ row: sheetRow, name, number, setHint });
            continue;
        }

        // Build cell updates — only fill blanks (preserve manual edits)
        const apiSetName = match.set?.name || '';
        const apiSetId = match.set?.id || '';
        const apiRarity = normalizeRarity(match.rarity);
        const apiImage = match.images?.large || match.images?.small || '';
        // Full release date (YYYY-MM-DD) so the frontend sort stays
        // chronologically ordered within a single release year.
        const apiReleaseDate = match.set?.releaseDate
            ? match.set.releaseDate.replace(/\//g, '-')
            : '';
        const apiArtist = match.artist || '';
        const apiCardId = match.id || '';

        // In FORCE mode we always overwrite the enriched fields (L/O/P/Q/R)
        // so the new matcher's picks replace the old ones. Set Name (I) and
        // Set Code (J) remain user-owned — only filled when blank.
        const writes = {};
        if (!setHint && apiSetName) writes.I = apiSetName;
        if (!(row[COL.J] || '').trim() && apiSetId) writes.J = apiSetId;
        if ((FORCE || !rarity) && apiRarity) writes.L = apiRarity;
        if ((FORCE || !image) && apiImage) writes.O = apiImage;
        if ((FORCE || !year) && apiReleaseDate) writes.P = apiReleaseDate;
        if ((FORCE || !artist) && apiArtist) writes.Q = apiArtist;
        if ((FORCE || !apiId) && apiCardId) writes.R = apiCardId;

        for (const [col, value] of Object.entries(writes)) {
            updates.push({
                range: `${SHEET_NAME}!${col}${sheetRow}`,
                values: [[value]],
            });
        }

        logs.enriched++;
        processed++;
        const summary = [
            writes.I ? `set="${writes.I}"` : null,
            writes.L ? `rarity=${writes.L}` : null,
            writes.P ? `date=${writes.P}` : null,
            writes.Q ? `artist="${writes.Q}"` : null,
        ].filter(Boolean).join(' ');
        const apiIdDisplay = apiCardId || '—';
        const apiSetDisplay = apiSetName || '—';
        const previousApiId = apiId; // captured before any writes
        const changeMarker = previousApiId && previousApiId !== apiCardId
            ? ` (was ${previousApiId})`
            : '';
        console.log(`  Row ${sheetRow}: ${name}${number ? ' #' + number : ''} → [${apiIdDisplay}]${changeMarker} ${apiSetDisplay}  |  ${summary}`);
    }

    console.log(`\n=== Summary ===`);
    console.log(`  enriched:         ${logs.enriched}`);
    console.log(`  already complete: ${logs.alreadyComplete}`);
    console.log(`  no-match:         ${logs.noMatch.length}`);
    console.log(`  API errors:       ${logs.apiError.length}`);
    console.log(`  cell writes:      ${updates.length}`);

    if (logs.noMatch.length) {
        console.log('\n=== No match (manual review) ===');
        logs.noMatch.slice(0, 30).forEach((r) =>
            console.log(`  Row ${r.row}: ${r.name}${r.number ? ' #' + r.number : ''} (set hint: "${r.setHint}")`),
        );
        if (logs.noMatch.length > 30) {
            console.log(`  ... and ${logs.noMatch.length - 30} more`);
        }
    }

    if (logs.apiError.length) {
        console.log('\n=== API errors ===');
        logs.apiError.slice(0, 10).forEach((r) =>
            console.log(`  Row ${r.row}: ${r.name} — ${r.error}`),
        );
    }

    if (DRY_RUN) {
        console.log(`\n[dry-run] No changes written.`);
        return;
    }

    // Keep column P's header in sync with what we're writing — the
    // migration originally titled it "Release Year" but we now write
    // full YYYY-MM-DD dates.
    updates.push({
        range: `${SHEET_NAME}!P1`,
        values: [['Release Date']],
    });

    if (!updates.length) {
        console.log('\nNothing to write.');
        return;
    }

    console.log(`\nWriting ${updates.length} cell update(s) in batches...`);
    // Chunk at 500 ranges per batch to stay comfortably under API limits
    const CHUNK = 500;
    for (let i = 0; i < updates.length; i += CHUNK) {
        const chunk = updates.slice(i, i + CHUNK);
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: { valueInputOption: 'RAW', data: chunk },
        });
        console.log(`  ✓ wrote batch ${Math.floor(i / CHUNK) + 1} (${chunk.length} cells)`);
    }
    console.log(`\n✓ Enrichment complete.`);
}

main().catch((err) => {
    console.error('Enrichment failed:', err.message);
    process.exit(1);
});
