/**
 * Push Card Singles to Stripe from Google Sheets.
 *
 * Reads the `Singles` tab (post-migration A-T schema — see
 * scripts/shop/migrate-singles-schema.js) and creates/updates Stripe
 * products. Every product is tagged with `metadata.type = "card"` so
 * pull-cards.php claims it and pull-products.php skips it.
 *
 * Writes back the Stripe Product ID to column S on first push so
 * re-runs are idempotent (no duplicate Stripe products).
 *
 * Usage:
 *   node scripts/shop/push-cards.js [--clean] [--dry-run] [--limit=N]
 *
 * Column layout expected:
 *   A Card Name            K Variant
 *   B TCGPlayer Direct     L Rarity
 *   C TCGPlayer Market NM  M Game
 *   D Price Charting       N Language
 *   E Price (authoritative → Stripe default_price)
 *   F Stock                O Image URL
 *   G Sale Price (opt)     P Release Year
 *   H Card Number          Q Artist
 *   I Set Name             R Pokemon TCG API ID
 *   J Set Code             S Stripe Product ID (writeback)
 *                          T Notes (internal, not pushed)
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const Stripe = require('stripe');

const CREDENTIALS_PATH = path.join(process.env.HOME, '.config/google/sheets-credentials.json');
const SPREADSHEET_ID = '1erx1dUZ9YIwpg5xbXP_OFrE4i1dV97RoE7M0rsv_JkM';
const SHEET_NAME = 'Singles';

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || (() => {
    const envFile = path.join(__dirname, '../../wp-config-env.php');
    if (fs.existsSync(envFile)) {
        const content = fs.readFileSync(envFile, 'utf8');
        const match = content.match(/define\('STRIPE_SECRET_KEY',\s*'([^']+)'\)/);
        return match ? match[1] : '';
    }
    return '';
})();

if (!STRIPE_KEY) {
    console.error('Error: STRIPE_SECRET_KEY not found.');
    process.exit(1);
}

const stripe = new Stripe(STRIPE_KEY);

const args = process.argv.slice(2);
const CLEAN = args.includes('--clean');
const DRY_RUN = args.includes('--dry-run');
const LIMIT_ARG = args.find((a) => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : Infinity;

// Column indices for the A-T schema.
const COL = {
    A: 0, B: 1, C: 2, D: 3, E: 4,
    F: 5, G: 6, H: 7, I: 8, J: 9,
    K: 10, L: 11, M: 12, N: 13, O: 14,
    P: 15, Q: 16, R: 17, S: 18, T: 19,
};

/**
 * Parse a display price string like "$25", "$1,000", or "$24.99" into
 * Stripe's integer-cents format. Returns NaN when the value can't be parsed.
 */
function priceToCents(raw) {
    if (!raw) return NaN;
    const cleaned = String(raw).replace(/[^\d.]/g, '');
    const dollars = parseFloat(cleaned);
    if (isNaN(dollars) || dollars <= 0) return NaN;
    return Math.round(dollars * 100);
}

async function cleanCardProducts() {
    console.log('Cleaning: deactivating all existing Stripe card products...');
    let hasMore = true;
    let startingAfter = null;
    let count = 0;

    while (hasMore) {
        const params = { limit: 100, active: true };
        if (startingAfter) params.starting_after = startingAfter;

        const products = await stripe.products.list(params);

        for (const product of products.data) {
            if ((product.metadata || {}).type === 'card') {
                if (!DRY_RUN) await stripe.products.update(product.id, { active: false });
                console.log(`  Deactivated: ${product.name}`);
                count++;
            }
            startingAfter = product.id;
        }

        hasMore = products.has_more;
    }

    console.log(`  ${count} card(s) deactivated.\n`);
}

async function main() {
    if (CLEAN) {
        await cleanCardProducts();
    }

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
        console.log('No cards found in the sheet.');
        return;
    }

    console.log(`Found ${rows.length} card(s).${DRY_RUN ? ' [dry-run]' : ''}\n`);

    const writebacks = []; // { rowIndex, productId }
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let processed = 0;

    for (let i = 0; i < rows.length; i++) {
        if (processed >= LIMIT) break;
        const row = rows[i];
        const sheetRow = i + 2;

        const name = (row[COL.A] || '').trim();
        const priceStr = (row[COL.E] || '').trim();
        const stock = (row[COL.F] || '1').trim();
        const salePriceStr = (row[COL.G] || '').trim();
        const cardNumber = (row[COL.H] || '').trim();
        const setName = (row[COL.I] || '').trim();
        const setCode = (row[COL.J] || '').trim();
        const variant = (row[COL.K] || '').trim();
        const rarity = (row[COL.L] || '').trim();
        const game = (row[COL.M] || 'pokemon').trim();
        const language = (row[COL.N] || 'English').trim();
        const imageUrl = (row[COL.O] || '').trim();
        const releaseYear = (row[COL.P] || '').trim();
        const artist = (row[COL.Q] || '').trim();
        const tcgApiId = (row[COL.R] || '').trim();
        const existingProductId = (row[COL.S] || '').trim();
        const tcgDirect = (row[COL.B] || '').trim();
        const tcgMarketNM = (row[COL.C] || '').trim();
        const priceCharting = (row[COL.D] || '').trim();

        if (!name) {
            console.log(`  Skipping row ${sheetRow} — missing name`);
            skipped++;
            continue;
        }

        const priceAmount = priceToCents(priceStr);
        if (isNaN(priceAmount)) {
            console.log(`  Skipping row ${sheetRow} (${name}) — invalid price: "${priceStr}"`);
            skipped++;
            continue;
        }

        // Build Stripe product name — include Variant when present so two
        // printings of the same card (e.g. regular vs. Secret / Full Art)
        // don't collide on identical name+number.
        const variantSuffix = variant ? ` (${variant})` : '';
        const productName = cardNumber
            ? `${name}${variantSuffix} #${cardNumber}${setName ? ' — ' + setName : ''}`
            : `${name}${variantSuffix}${setName ? ' — ' + setName : ''}`;

        const metadata = {
            type: 'card',
            stock,
            card_name: name,
        };
        if (cardNumber) metadata.card_number = cardNumber;
        if (setName) metadata.set_name = setName;
        if (setCode) metadata.set_code = setCode;
        if (variant) metadata.variant = variant;
        if (rarity) metadata.rarity = rarity;
        if (game) metadata.game = game;
        if (language) metadata.language = language;
        if (releaseYear) metadata.release_year = releaseYear;
        if (artist) metadata.artist = artist;
        if (tcgApiId) metadata.tcg_api_id = tcgApiId;
        // Reference prices — kept on Stripe for operator context, not used at checkout.
        if (tcgDirect) metadata.ref_tcg_direct = tcgDirect;
        if (tcgMarketNM) metadata.ref_tcg_market_nm = tcgMarketNM;
        if (priceCharting) metadata.ref_price_charting = priceCharting;

        // Find existing product — prefer the stored ID, fall back to name+type search
        let existingProduct = null;
        if (existingProductId) {
            try {
                const fetched = await stripe.products.retrieve(existingProductId);
                if (fetched && !fetched.deleted) existingProduct = fetched;
            } catch {
                console.log(`  Warning: stored Stripe ID ${existingProductId} not found, will search.`);
            }
        }
        if (!existingProduct) {
            const search = await stripe.products.search({
                query: `name~"${productName.replace(/"/g, '\\"')}" AND metadata['type']:'card'`,
            });
            existingProduct = search.data.find(
                (p) => p.name.toLowerCase() === productName.toLowerCase(),
            ) || null;
        }

        let product;
        let defaultPriceId;

        if (DRY_RUN) {
            const preview = [
                `price=$${(priceAmount / 100).toFixed(2)}`,
                `stock=${stock}`,
                rarity ? `rarity=${rarity}` : null,
                imageUrl ? 'image=✓' : null,
            ].filter(Boolean).join(' ');
            console.log(`  [dry] ${existingProduct ? 'update' : 'create'}: ${productName} (${preview})`);
            processed++;
            continue;
        }

        if (existingProduct) {
            const updateData = { metadata, active: true, name: productName };
            if (imageUrl) updateData.images = [imageUrl];

            product = await stripe.products.update(existingProduct.id, updateData);

            const currentPrice = existingProduct.default_price;
            if (currentPrice) {
                const priceObj = typeof currentPrice === 'string'
                    ? await stripe.prices.retrieve(currentPrice)
                    : currentPrice;

                if (priceObj.unit_amount === priceAmount) {
                    defaultPriceId = priceObj.id;
                } else {
                    const newPrice = await stripe.prices.create({
                        product: product.id,
                        unit_amount: priceAmount,
                        currency: 'usd',
                    });
                    await stripe.products.update(product.id, { default_price: newPrice.id });
                    defaultPriceId = newPrice.id;
                    console.log(`    Price updated: $${(priceAmount / 100).toFixed(2)}`);
                }
            }

            console.log(`  Updated: ${productName}`);
            updated++;
        } else {
            const createData = {
                name: productName,
                metadata,
                default_price_data: {
                    unit_amount: priceAmount,
                    currency: 'usd',
                },
            };
            if (imageUrl) createData.images = [imageUrl];

            product = await stripe.products.create(createData);
            defaultPriceId = typeof product.default_price === 'string'
                ? product.default_price
                : product.default_price?.id;

            console.log(`  Created: ${productName} ($${(priceAmount / 100).toFixed(2)})`);
            created++;
        }

        processed++;

        // Queue a writeback if the Product ID column was blank or mismatched
        if (product && (!existingProductId || existingProductId !== product.id)) {
            writebacks.push({ rowIndex: sheetRow, productId: product.id });
        }

        // Sale price handling (column G)
        const salePriceAmount = priceToCents(salePriceStr);
        if (!isNaN(salePriceAmount) && salePriceAmount > 0) {
            const prices = await stripe.prices.list({
                product: product.id,
                active: true,
                limit: 10,
            });

            let salePriceObj = prices.data.find(
                (p) => p.unit_amount === salePriceAmount && p.id !== defaultPriceId,
            );
            if (!salePriceObj) {
                salePriceObj = await stripe.prices.create({
                    product: product.id,
                    unit_amount: salePriceAmount,
                    currency: 'usd',
                });
                console.log(`    Sale price created: $${(salePriceAmount / 100).toFixed(2)}`);
            }

            await stripe.products.update(product.id, {
                metadata: { ...metadata, sale_price_id: salePriceObj.id },
            });
            console.log(`    Sale active: $${(salePriceAmount / 100).toFixed(2)}`);
        } else if (existingProduct) {
            const currentMeta = existingProduct.metadata || {};
            if (currentMeta.sale_price_id) {
                await stripe.products.update(product.id, {
                    metadata: { ...metadata, sale_price_id: '' },
                });
                console.log(`    Sale ended`);
            }
        }
    }

    if (!DRY_RUN && writebacks.length) {
        console.log(`\nWriting ${writebacks.length} Stripe Product ID(s) back to column S...`);
        const data = writebacks.map(({ rowIndex, productId }) => ({
            range: `${SHEET_NAME}!S${rowIndex}`,
            values: [[productId]],
        }));
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
                valueInputOption: 'RAW',
                data,
            },
        });
    }

    console.log(`\nDone: ${created} created, ${updated} updated, ${skipped} skipped.`);
}

main().catch((e) => {
    console.error('push-cards failed:', e.message);
    process.exit(1);
});
