/**
 * One-shot migration: reshape the Singles tab from its current
 * A-E layout (Product Name + 4 pricing columns) into the new A-T
 * schema (card name, pricing, stock, parsed card metadata, enrichment
 * slots).
 *
 * Idempotent and dry-run-safe. Re-runs don't duplicate work — only
 * rows whose target columns are still blank get rewritten. Column A
 * is only rewritten if the migration finds a parsed card name that
 * differs from the current value AND the row hasn't been migrated yet.
 *
 * Usage:
 *   node scripts/shop/migrate-singles-schema.js --dry-run
 *   node scripts/shop/migrate-singles-schema.js
 *
 * Takes the backup as given — does not create a new one. Run
 * backup-singles.js first if you haven't already.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CREDS = JSON.parse(
    fs.readFileSync(path.join(process.env.HOME, '.config/google/sheets-credentials.json'), 'utf8'),
);
const SHEET_ID = '1erx1dUZ9YIwpg5xbXP_OFrE4i1dV97RoE7M0rsv_JkM';
const TAB = 'Singles';

const DRY_RUN = process.argv.includes('--dry-run');

// Final column layout (A-T) — all scripts from here on key off this.
const NEW_HEADERS = [
    'Card Name',                  // A
    'TCGPlayer Direct',           // B
    'TCGPlayer Market (NM)',      // C
    'Price Charting Price',       // D
    'Price',                      // E
    'Stock',                      // F
    'Sale Price',                 // G
    'Card Number',                // H
    'Set Name',                   // I
    'Set Code',                   // J
    'Variant',                    // K
    'Rarity',                     // L
    'Game',                       // M
    'Language',                   // N
    'Image URL',                  // O
    'Release Date',               // P
    'Artist',                     // Q
    'Pokemon TCG API ID',         // R
    'Stripe Product ID',          // S
    'Notes',                      // T
];

// Paren-phrases we recognize as variant modifiers (not part of the card name).
const KNOWN_VARIANT_PHRASES = [
    'shiny',
    'full art',
    'alternate full art',
    'alternate art',
    'alt art',
    'cosmos holo',
    'secret',
    'holo common',
    'reverse holo',
    'holo',
    '1st edition',
    'shadowless',
    'delta species',
    'prerelease',
    "let's play, eevee!",
];

// Parsers, most-specific first. Allow ':', space, and : TG suffix style
// (HIF:SV, SWSH10:TG, SWSH11: TG). Space kept internal only — the outer
// regex requires leading uppercase, so "BLE" / "PR" / "SWSH11: TG" all work.
const SET_CODE = '[A-Z][A-Z0-9: ]{0,12}[A-Z0-9]';

const PATTERNS = [
    {
        key: 'full_with_variant_and_code',
        // Name - Number (Variant) - Set (CODE)
        regex: new RegExp(
            '^(.+?)\\s+-\\s+(\\S+(?:\\/\\S+)?)\\s+\\((.+?)\\)\\s+-\\s+(.+?)\\s+\\((' + SET_CODE + ')\\)\\s*$',
        ),
        extract: (m) => ({
            name: m[1],
            number: m[2],
            variant: m[3],
            setName: m[4],
            setCode: m[5],
        }),
    },
    {
        key: 'name_num_set_code',
        // Name - Number - Set (CODE)
        regex: new RegExp(
            '^(.+?)\\s+-\\s+(\\S+(?:\\/\\S+)?)\\s+-\\s+(.+?)\\s+\\((' + SET_CODE + ')\\)\\s*$',
        ),
        extract: (m) => ({
            name: m[1],
            number: m[2],
            setName: m[3],
            setCode: m[4],
        }),
    },
    {
        key: 'name_set_code',
        // Name - Set (CODE)  — no number
        regex: new RegExp('^(.+?)\\s+-\\s+(.+?)\\s+\\((' + SET_CODE + ')\\)\\s*$'),
        extract: (m) => ({
            name: m[1],
            setName: m[2],
            setCode: m[3],
        }),
    },
    {
        key: 'name_num_variant_no_set',
        // Name - Number (Variant)  — no set at all (Cosmos Holo orphans)
        regex: /^(.+?)\s+-\s+(\S+(?:\/\S+)?)\s+\((.+?)\)\s*$/,
        extract: (m) => ({
            name: m[1],
            number: m[2],
            variant: m[3],
        }),
    },
    {
        key: 'name_set',
        // Name - rest — everything else
        regex: /^(.+?)\s+-\s+(.+?)\s*$/,
        extract: (m) => ({ name: m[1], setName: m[2] }),
    },
];

/**
 * Extract a trailing `(variant)` from the card name if the paren phrase is a
 * known variant modifier. Returns { name, extractedVariant } where
 * extractedVariant is null when no match.
 */
function extractTrailingVariant(name) {
    const m = /^(.+?)\s*\(([^)]+)\)\s*$/.exec(name);
    if (!m) return { name, extractedVariant: null };
    const inner = m[2].trim();
    if (KNOWN_VARIANT_PHRASES.includes(inner.toLowerCase())) {
        return { name: m[1].trim(), extractedVariant: inner };
    }
    return { name, extractedVariant: null };
}

/**
 * Parse a full title into components. Falls back through the patterns
 * until one matches. Then runs a second pass to pull trapped variants
 * out of the name.
 */
function parseTitle(title) {
    for (const pattern of PATTERNS) {
        const m = pattern.regex.exec(title);
        if (!m) continue;

        const parsed = pattern.extract(m);

        // Second pass: if the name has a trailing (variant) in it, promote it.
        const { name, extractedVariant } = extractTrailingVariant(parsed.name);
        parsed.name = name;
        if (extractedVariant && !parsed.variant) {
            parsed.variant = extractedVariant;
        }

        return { matchedPattern: pattern.key, ...parsed };
    }

    return { matchedPattern: 'none', name: title };
}

function colLetter(index) {
    return String.fromCharCode(65 + index);
}

async function main() {
    const auth = new google.auth.GoogleAuth({
        credentials: CREDS,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${TAB}!A2:T`,
    });
    const rows = res.data.values || [];
    console.log(`Found ${rows.length} data rows to migrate.${DRY_RUN ? ' [dry-run]' : ''}`);
    console.log('');

    // Preview buffer
    const previewLines = [];
    const buckets = {};
    const notes = [];

    // Collect new values per cell
    const updates = []; // { range, values }

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const sheetRow = i + 2;
        const currentTitle = (row[0] || '').trim();
        if (!currentTitle) continue;

        // Skip rows that already have a Set Name in column I (0-indexed 8). That means
        // this script has run before and the parse happened.
        const alreadyMigrated = (row[8] || '').trim() !== '' || (row[10] || '').trim() !== '';
        if (alreadyMigrated) {
            buckets['skipped_already_migrated'] = (buckets['skipped_already_migrated'] || 0) + 1;
            continue;
        }

        const parsed = parseTitle(currentTitle);
        buckets[parsed.matchedPattern] = (buckets[parsed.matchedPattern] || 0) + 1;

        const cleanedName = parsed.name.trim();
        const flags = [];
        if (parsed.matchedPattern === 'none') flags.push('UNPARSED');
        if (parsed.matchedPattern === 'name_set' && !parsed.setCode) {
            // Likely an orphan — set column will hold the whole tail which is suspect
            flags.push('AMBIGUOUS_SET');
        }
        if (parsed.matchedPattern === 'name_num_variant_no_set') flags.push('NO_SET');

        // Build per-cell values
        const cells = {
            A: cleanedName,                 // cleaned card name
            F: '1',                         // default stock
            H: parsed.number || '',
            I: parsed.setName || '',
            J: parsed.setCode || '',
            K: parsed.variant || '',
            M: 'pokemon',
            N: 'English',
        };

        // Only push to Notes (T) if there are flags
        if (flags.length) {
            cells.T = 'migrate: ' + flags.join(', ');
            notes.push({ row: sheetRow, title: currentTitle, flags });
        }

        // Build update requests per cell (batch later)
        for (const [colL, value] of Object.entries(cells)) {
            if (value === null || value === undefined) continue;
            updates.push({
                range: `${TAB}!${colL}${sheetRow}`,
                values: [[value]],
            });
        }

        if (previewLines.length < 10) {
            previewLines.push({
                row: sheetRow,
                pattern: parsed.matchedPattern,
                from: currentTitle,
                cells,
                flags,
            });
        }
    }

    // Print pattern histogram
    console.log('=== Pattern histogram (after : allowed in set codes) ===');
    Object.entries(buckets)
        .sort((a, b) => b[1] - a[1])
        .forEach(([k, v]) => console.log(`  ${k}: ${v}`));

    console.log('\n=== Preview — first 10 rows ===\n');
    for (const p of previewLines) {
        console.log(`Row ${p.row} [${p.pattern}]${p.flags.length ? ' ⚠ ' + p.flags.join(',') : ''}`);
        console.log(`  FROM: ${p.from}`);
        console.log(`  TO:   A="${p.cells.A}" H="${p.cells.H || ''}" I="${p.cells.I || ''}" J="${p.cells.J || ''}" K="${p.cells.K || ''}"`);
    }

    console.log(`\n=== Flag summary ===`);
    console.log(`  rows with notes: ${notes.length}`);
    const byFlag = {};
    for (const n of notes) {
        for (const f of n.flags) byFlag[f] = (byFlag[f] || 0) + 1;
    }
    Object.entries(byFlag).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
    if (notes.length && notes.length <= 30) {
        console.log('\n=== All flagged rows ===');
        notes.forEach((n) => console.log(`  Row ${n.row} [${n.flags.join(',')}]: ${n.title}`));
    } else if (notes.length > 30) {
        console.log('\n=== First 15 flagged rows ===');
        notes.slice(0, 15).forEach((n) => console.log(`  Row ${n.row} [${n.flags.join(',')}]: ${n.title}`));
    }

    // Headers (row 1)
    const headerRange = `${TAB}!A1:${colLetter(NEW_HEADERS.length - 1)}1`;
    updates.push({
        range: headerRange,
        values: [NEW_HEADERS],
    });

    console.log(`\n=== Write plan ===`);
    console.log(`  cell updates: ${updates.length}`);
    console.log(`  header row rewrite: ${headerRange}`);

    if (DRY_RUN) {
        console.log('\n[dry-run] No changes written. Re-run without --dry-run to apply.');
        return;
    }

    console.log('\nWriting...');
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
            valueInputOption: 'RAW',
            data: updates,
        },
    });
    console.log(`✓ Migration complete: ${updates.length} cell updates applied.`);
}

main().catch((e) => {
    console.error('Migration failed:', e.message);
    process.exit(1);
});
