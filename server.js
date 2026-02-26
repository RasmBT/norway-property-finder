require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const { fetchListingsForMunicipality, fetchPlotsForMunicipality } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3456;

// Parse JSON request bodies
app.use(express.json());

// Database setup
const db = new Database(path.join(__dirname, 'data', 'listings.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    municipality_code TEXT NOT NULL,
    municipality_name TEXT NOT NULL,
    title TEXT,
    price INTEGER,
    price_text TEXT,
    address TEXT,
    area_m2 INTEGER,
    bedrooms INTEGER,
    property_type TEXT,
    image_url TEXT,
    finn_url TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    shared_cost INTEGER DEFAULT 0,
    shared_debt INTEGER DEFAULT 0,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now')),
    is_new INTEGER DEFAULT 1,
    category TEXT DEFAULT 'home',
    is_developed INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS update_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    municipality_code TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    listings_found INTEGER DEFAULT 0,
    new_listings INTEGER DEFAULT 0,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_listings_municipality ON listings(municipality_code);
  CREATE INDEX IF NOT EXISTS idx_listings_first_seen ON listings(first_seen);
`);

// Migrations: add new columns if they don't exist
try {
  db.prepare("SELECT category FROM listings LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE listings ADD COLUMN category TEXT DEFAULT 'home'");
  db.exec("ALTER TABLE listings ADD COLUMN is_developed INTEGER DEFAULT NULL");
}
try {
  db.prepare("SELECT building_obligation FROM listings LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE listings ADD COLUMN building_obligation TEXT DEFAULT 'unknown'");
  db.exec("ALTER TABLE listings ADD COLUMN building_obligation_text TEXT DEFAULT NULL");
}

// Migration: enhanced plot detail columns
const plotDetailCols = [
  { name: 'plot_owned', def: 'TEXT DEFAULT NULL' },
  { name: 'total_price', def: 'INTEGER DEFAULT NULL' },
  { name: 'tax_value', def: 'INTEGER DEFAULT NULL' },
  { name: 'cadastre', def: 'TEXT DEFAULT NULL' },
  { name: 'facilities', def: 'TEXT DEFAULT NULL' },
  { name: 'regulations', def: 'TEXT DEFAULT NULL' },
  { name: 'yearly_costs_text', def: 'TEXT DEFAULT NULL' },
  { name: 'utilities', def: 'TEXT DEFAULT NULL' },
];
for (const col of plotDetailCols) {
  try {
    db.prepare(`SELECT ${col.name} FROM listings LIMIT 1`).get();
  } catch (e) {
    db.exec(`ALTER TABLE listings ADD COLUMN ${col.name} ${col.def}`);
  }
}

// Migration: has_property_tax column
try {
  db.prepare("SELECT has_property_tax FROM listings LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE listings ADD COLUMN has_property_tax INTEGER DEFAULT 0");
}

db.exec("CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_obligation ON listings(building_obligation)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_plot_owned ON listings(plot_owned)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_tax ON listings(has_property_tax)");

// Refresh status tracking
let isRefreshing = false;
let refreshProgress = 0;
let refreshTotal = 0;

// Exchange rate cache
let eurRate = { rate: null, fetchedAt: 0 };

async function getEurRate() {
  const now = Date.now();
  // Cache for 1 hour
  if (eurRate.rate && now - eurRate.fetchedAt < 3600000) return eurRate.rate;
  try {
    const resp = await fetch('https://api.frankfurter.app/latest?from=NOK&to=EUR');
    const data = await resp.json();
    eurRate = { rate: data.rates.EUR, fetchedAt: now };
    return eurRate.rate;
  } catch (e) {
    return eurRate.rate || 0.085; // fallback
  }
}

// Serve static files with no-cache headers to prevent stale JS/CSS
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, filePath) {
    res.set('Cache-Control', 'no-cache, must-revalidate');
  }
}));

// API: Get all municipalities with tax status
app.get('/api/municipalities', (req, res) => {
  const municipalities = require('./data/municipalities.json');
  res.json(municipalities);
});

// API: Get EUR exchange rate
app.get('/api/exchange-rate', async (req, res) => {
  const rate = await getEurRate();
  res.json({ NOK_EUR: rate });
});

// API: Get listings with filters
app.get('/api/listings', (req, res) => {
  const { municipality, min_price, max_price, min_area, property_type, sort, new_only, category, developed, building_obligation, plot_owned } = req.query;

  let sql = 'SELECT * FROM listings WHERE 1=1';
  const params = [];

  if (municipality) {
    const codes = municipality.split(',').map(c => c.trim()).filter(Boolean);
    if (codes.length === 1) {
      sql += ' AND municipality_code = ?';
      params.push(codes[0]);
    } else if (codes.length > 1) {
      sql += ` AND municipality_code IN (${codes.map(() => '?').join(',')})`;
      params.push(...codes);
    }
  }
  if (min_price && !isNaN(Number(min_price))) {
    sql += ' AND price >= ?';
    params.push(Number(min_price));
  }
  if (max_price && !isNaN(Number(max_price))) {
    sql += ' AND price <= ?';
    params.push(Number(max_price));
  }
  if (min_area && !isNaN(Number(min_area))) {
    sql += ' AND area_m2 >= ?';
    params.push(Number(min_area));
  }
  if (property_type) {
    sql += ' AND property_type = ?';
    params.push(property_type);
  }
  if (new_only === '1') {
    sql += ' AND is_new = 1';
  }
  if (req.query.no_fees === '1') {
    sql += ' AND shared_cost = 0';
  }
  if (category && category !== 'all') {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (developed === '1') {
    sql += ' AND is_developed = 1';
  } else if (developed === '0') {
    sql += ' AND is_developed = 0';
  }
  if (building_obligation && building_obligation !== 'all') {
    sql += ' AND building_obligation = ?';
    params.push(building_obligation);
  }
  if (plot_owned) {
    sql += ' AND plot_owned = ?';
    params.push(plot_owned);
  }
  if (req.query.tax_free === '1') {
    sql += ' AND has_property_tax = 0';
  }
  // Bounding box filter (map area selection)
  const { north, south, east, west } = req.query;
  if (north && south && east && west) {
    sql += ' AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?';
    params.push(Number(south), Number(north), Number(west), Number(east));
  }

  switch (sort) {
    case 'price_asc': sql += ' ORDER BY price ASC NULLS LAST'; break;
    case 'price_desc': sql += ' ORDER BY price DESC NULLS LAST'; break;
    case 'area_desc': sql += ' ORDER BY area_m2 DESC NULLS LAST'; break;
    case 'area_asc': sql += ' ORDER BY area_m2 ASC NULLS LAST'; break;
    case 'newest': sql += ' ORDER BY first_seen DESC'; break;
    default: sql += ' ORDER BY first_seen DESC';
  }

  const listings = db.prepare(sql).all(...params);
  res.json(listings);
});

// API: Get listing counts grouped by municipality (lightweight alternative to fetching all listings)
app.get('/api/listing-counts', (req, res) => {
  const { min_price, max_price, min_area, property_type, sort, new_only, category, developed, building_obligation, plot_owned } = req.query;

  let sql = 'SELECT municipality_code, municipality_name, COUNT(*) as count FROM listings WHERE 1=1';
  const params = [];

  if (min_price && !isNaN(Number(min_price))) { sql += ' AND price >= ?'; params.push(Number(min_price)); }
  if (max_price && !isNaN(Number(max_price))) { sql += ' AND price <= ?'; params.push(Number(max_price)); }
  if (min_area && !isNaN(Number(min_area))) { sql += ' AND area_m2 >= ?'; params.push(Number(min_area)); }
  if (property_type) { sql += ' AND property_type = ?'; params.push(property_type); }
  if (new_only === '1') { sql += ' AND is_new = 1'; }
  if (req.query.no_fees === '1') { sql += ' AND shared_cost = 0'; }
  if (category && category !== 'all') { sql += ' AND category = ?'; params.push(category); }
  if (developed === '1') { sql += ' AND is_developed = 1'; }
  else if (developed === '0') { sql += ' AND is_developed = 0'; }
  if (building_obligation && building_obligation !== 'all') { sql += ' AND building_obligation = ?'; params.push(building_obligation); }
  if (plot_owned) { sql += ' AND plot_owned = ?'; params.push(plot_owned); }
  if (req.query.tax_free === '1') { sql += ' AND has_property_tax = 0'; }
  const { north, south, east, west } = req.query;
  if (north && south && east && west) {
    sql += ' AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?';
    params.push(Number(south), Number(north), Number(west), Number(east));
  }

  sql += ' GROUP BY municipality_code ORDER BY count DESC';

  const counts = db.prepare(sql).all(...params);
  res.json(counts);
});

// API: Get listing stats
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM listings').get();
  const newCount = db.prepare('SELECT COUNT(*) as count FROM listings WHERE is_new = 1').get();
  const lastUpdate = db.prepare('SELECT MAX(updated_at) as last FROM update_log').get();
  const byMunicipality = db.prepare(`
    SELECT municipality_code, municipality_name, COUNT(*) as count
    FROM listings GROUP BY municipality_code ORDER BY count DESC
  `).all();

  res.json({
    total: total.count,
    new: newCount.count,
    lastUpdate: lastUpdate.last,
    byMunicipality
  });
});

// API: Trigger manual refresh
app.post('/api/refresh', async (req, res) => {
  res.json({ message: 'Refresh started' });
  try {
    await runUpdate();
  } catch (err) {
    console.error('Manual refresh failed:', err.message);
  }
});

// API: Get refresh status
app.get('/api/refresh-status', (req, res) => {
  res.json({ refreshing: isRefreshing, progress: refreshProgress, total: refreshTotal });
});

// API: Get update history
app.get('/api/updates', (req, res) => {
  const updates = db.prepare(
    'SELECT * FROM update_log ORDER BY updated_at DESC LIMIT 50'
  ).all();
  res.json(updates);
});

// --- Smart Search via DeepSeek ---
const SMART_SEARCH_SYSTEM_PROMPT = `You are a filter-extraction assistant for a Norwegian property finder app.
Given a natural language query, return a JSON object with the matching filter parameters.

The app covers ALL Norwegian municipalities. Some are tax-free (no property tax).

MUNICIPALITIES (code → name):
0301=Oslo, 4601=Bergen, 5001=Trondheim, 1103=Stavanger, 1108=Sandnes,
3201=Bærum, 3203=Asker, 3301=Drammen, 3205=Lillestrøm, 3107=Fredrikstad,
3105=Sarpsborg, 3403=Hamar, 3405=Lillehammer, 3407=Gjøvik, 3901=Horten,
3903=Holmestrand, 3905=Tønsberg, 3907=Sandefjord, 3909=Larvik, 3911=Færder,
4001=Porsgrunn, 4003=Skien, 4201=Risør, 4202=Grimstad, 4203=Arendal,
4204=Kristiansand, 5501=Tromsø, 5503=Harstad, 5601=Alta, 1804=Bodø,
1806=Narvik, 1506=Molde, 1505=Kristiansund, 1508=Ålesund, 1106=Haugesund,
3303=Kongsberg, 3305=Ringerike, 3312=Lier, 3314=Øvre Eiker, 3310=Hole,
3220=Enebakk, 3207=Nordre Follo, 1124=Sola, 1120=Klepp, 1119=Hå,
3238=Nannestad, 3224=Rælingen, 3230=Gjerdrum, 4624=Bjørnafjorden,
4625=Austevoll, 4612=Sveio, 5035=Stjørdal, 3447=Søndre Land

DRIVING DISTANCES FROM OSLO (0301):
<1h: 3201 Bærum, 3203 Asker, 3312 Lier, 3205 Lillestrøm, 3224 Rælingen, 3207 Nordre Follo, 3220 Enebakk, 3230 Gjerdrum, 3238 Nannestad, 3310 Hole, 3301 Drammen, 3314 Øvre Eiker, 3305 Ringerike
1-2h: 3107 Fredrikstad, 3105 Sarpsborg, 3901 Horten, 3903 Holmestrand, 3911 Færder, 3905 Tønsberg, 3303 Kongsberg, 3907 Sandefjord, 3403 Hamar, 3909 Larvik
2-3h: 4001 Porsgrunn, 4003 Skien, 3405 Lillehammer, 3407 Gjøvik, 3447 Søndre Land, 4203 Arendal, 4202 Grimstad, 4201 Risør
3-4h: 4204 Kristiansand

DRIVING DISTANCES FROM BERGEN (4601):
<1h: 4624 Bjørnafjorden
1-2h: 4625 Austevoll, 4612 Sveio, 1106 Haugesund

DRIVING DISTANCES FROM TRONDHEIM (5001):
<1h: 5035 Stjørdal

DRIVING DISTANCES FROM STAVANGER (1103):
<1h: 1108 Sandnes, 1124 Sola, 1120 Klepp, 1119 Hå

NOTE: Bergen, Trondheim, Stavanger, Bodø, Tromsø are 7+ hours from Oslo by car.
Northern Norway (Bodø, Narvik, Tromsø, Harstad, Alta) are standalone regional centers, very far apart.
Molde, Kristiansund, Ålesund are mid-Norway coast, 4-6h from both Oslo and Trondheim.

FILTER FIELDS (only include keys that the user's query implies):
- municipality: comma-separated municipality codes for distance queries (e.g. "3301,3303,3305"), or single code for specific municipality
- category: "home", "tomt", or "all"
- min_price: integer in NOK
- max_price: integer in NOK
- min_area: integer in m²
- property_type: "Enebolig", "Leilighet", "Gårdsbruk/Småbruk", "Rekkehus", or "Tomannsbolig"
- developed: "1" (utilities connected) or "0" (no utilities)
- building_obligation: "none", "has_clause", "has_deadline", or "unknown"
- plot_owned: "selveier" (freehold) or "tomtefeste" (leasehold)
- sort: "newest", "price_asc", "price_desc", "area_desc", or "area_asc"
- new_only: "1" (only new listings)
- no_fees: "1" (no shared monthly costs)
- tax_free: "1" (only municipalities without property tax)

RULES:
- All prices must be in NOK. 1 million = 1000000. "2M" = 2000000. "500k" = 500000.
- "cheap" or "affordable" → sort by price_asc, do NOT guess a max_price.
- "large" or "big" → sort by area_desc.
- "plot" or "tomt" or "land" → category: "tomt".
- "house" or "home" or "cabin" → category: "home".
- "apartment" or "leilighet" → property_type: "Leilighet".
- "freehold" or "selveier" → plot_owned: "selveier".
- "leasehold" or "tomtefeste" → plot_owned: "tomtefeste".
- "no obligation" or "no byggeklausul" → building_obligation: "none".
- "tax free" or "no tax" or "no property tax" or "skattefri" → tax_free: "1".
- "detached" or "enebolig" → property_type: "Enebolig".
- "farm" or "småbruk" → property_type: "Gårdsbruk/Småbruk".
- Match municipality names case-insensitively and with partial matching.
- DISTANCE QUERIES: When the user says "Xh from [city]" or "near [city]" or "X-Yh from [city]", use the driving distance data above. Include ALL municipalities that fall within the requested range. Use comma-separated codes in the municipality field.
  - "near Oslo" or "close to Oslo" → all municipalities <1h from Oslo
  - "1-2h from Oslo" → all municipalities in the 1-2h zone
  - "1-3h from Oslo" → combine <1h + 1-2h + 2-3h zones
  - "within 2h of Oslo" → combine <1h + 1-2h zones
  - Do the same logic for Bergen, Trondheim, Stavanger.
  - NEVER include cities 7+ hours away (e.g. Trondheim is NOT near Oslo).
- Only output valid JSON. No extra text, no markdown.

EXAMPLES:
Input: "cheap plot in Asker under 2 million with no building obligation"
Output: {"municipality":"3203","category":"tomt","max_price":2000000,"building_obligation":"none","sort":"price_asc"}

Input: "large detached house"
Output: {"category":"home","property_type":"Enebolig","sort":"area_desc"}

Input: "apartments in Oslo under 3M"
Output: {"municipality":"0301","category":"home","property_type":"Leilighet","max_price":3000000}

Input: "cheap tomt 1-3h from Oslo"
Output: {"municipality":"3107,3105,3901,3903,3911,3905,3303,3907,3403,3909,4001,4003,3405,3407,3447,4203,4202,4201","category":"tomt","sort":"price_asc"}

Input: "plots near Bergen"
Output: {"municipality":"4624","category":"tomt"}

Input: "tax free plots in Bærum"
Output: {"municipality":"3201","category":"tomt","tax_free":"1"}

Input: "new listings under 5M"
Output: {"max_price":5000000,"new_only":"1"}

Input: "affordable homes within 2h of Oslo"
Output: {"municipality":"3201,3203,3312,3205,3224,3207,3220,3230,3238,3310,3301,3314,3305,3107,3105,3901,3903,3911,3905,3303,3907,3403,3909","category":"home","sort":"price_asc"}`;

const ALLOWED_SMART_KEYS = new Set([
  'municipality', 'category', 'min_price', 'max_price', 'min_area',
  'property_type', 'developed', 'building_obligation', 'plot_owned',
  'sort', 'new_only', 'no_fees', 'tax_free'
]);

app.post('/api/smart-search', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SMART_SEARCH_SYSTEM_PROMPT },
          { role: 'user', content: query.trim() },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('DeepSeek API error:', response.status, errText);
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(502).json({ error: 'No response from AI' });
    }

    const parsed = JSON.parse(content);

    // Whitelist-sanitize: only keep allowed keys
    const filters = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (ALLOWED_SMART_KEYS.has(key) && value !== null && value !== undefined && value !== '') {
        filters[key] = value;
      }
    }

    res.json({ filters, raw_query: query.trim() });
  } catch (err) {
    console.error('Smart search error:', err.message);
    res.status(500).json({ error: 'Failed to process search query' });
  }
});

// Upsert listings into database
function upsertListings(municipalityCode, municipalityName, listings, hasPropertyTax) {
  const upsert = db.prepare(`
    INSERT INTO listings (id, municipality_code, municipality_name, title, price, price_text,
      address, area_m2, bedrooms, property_type, image_url, finn_url, latitude, longitude,
      shared_cost, shared_debt, category, is_developed, building_obligation, building_obligation_text,
      plot_owned, total_price, tax_value, cadastre, facilities, regulations, yearly_costs_text, utilities,
      has_property_tax, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      price = excluded.price,
      price_text = excluded.price_text,
      title = excluded.title,
      image_url = excluded.image_url,
      shared_cost = excluded.shared_cost,
      shared_debt = excluded.shared_debt,
      category = excluded.category,
      is_developed = excluded.is_developed,
      building_obligation = excluded.building_obligation,
      building_obligation_text = excluded.building_obligation_text,
      plot_owned = excluded.plot_owned,
      total_price = excluded.total_price,
      tax_value = excluded.tax_value,
      cadastre = excluded.cadastre,
      facilities = excluded.facilities,
      regulations = excluded.regulations,
      yearly_costs_text = excluded.yearly_costs_text,
      utilities = excluded.utilities,
      has_property_tax = excluded.has_property_tax,
      last_seen = datetime('now'),
      is_new = 0
  `);

  let newCount = 0;
  const transaction = db.transaction((items) => {
    for (const listing of items) {
      const existing = db.prepare('SELECT id FROM listings WHERE id = ?').get(listing.id);
      if (!existing) newCount++;

      upsert.run(
        listing.id,
        municipalityCode,
        municipalityName,
        listing.title,
        listing.price,
        listing.priceText,
        listing.address,
        listing.area,
        listing.bedrooms,
        listing.propertyType,
        listing.imageUrl,
        listing.finnUrl,
        listing.latitude || null,
        listing.longitude || null,
        listing.sharedCost || 0,
        listing.sharedDebt || 0,
        listing.category || 'home',
        listing.isDeveloped ?? null,
        listing.buildingObligation || 'unknown',
        listing.buildingObligationText || null,
        listing.plotOwned || null,
        listing.totalPrice || null,
        listing.taxValue || null,
        listing.cadastre || null,
        listing.facilities || null,
        listing.regulations || null,
        listing.yearlyCostsText || null,
        listing.utilities || null,
        hasPropertyTax ? 1 : 0
      );
    }
  });

  transaction(listings);

  // Remove stale listings (not seen in 7 days) — only if scrape returned results
  if (listings.length > 0) {
    db.prepare(`
      DELETE FROM listings
      WHERE municipality_code = ? AND last_seen < datetime('now', '-7 days')
    `).run(municipalityCode);
  }

  return newCount;
}

// Run full update
async function runUpdate() {
  const municipalities = require('./data/municipalities.json');

  isRefreshing = true;
  refreshProgress = 0;
  refreshTotal = municipalities.length;

  console.log(`[${new Date().toISOString()}] Starting update for ${municipalities.length} municipalities...`);

  // Mark all current listings as not-new before refresh
  db.prepare('UPDATE listings SET is_new = 0').run();

  for (const muni of municipalities) {
    refreshProgress++;
    try {
      const hasTax = muni.hasPropertyTax;
      // Fetch homes
      console.log(`  [${refreshProgress}/${refreshTotal}] Fetching homes for ${muni.name} (${muni.code})${hasTax ? ' [TAX]' : ''}...`);
      const listings = await fetchListingsForMunicipality(muni);
      const newCount = upsertListings(muni.code, muni.name, listings, hasTax);

      // Fetch plots (tomt)
      console.log(`  [${refreshProgress}/${refreshTotal}] Fetching plots for ${muni.name} (${muni.code})...`);
      await new Promise(r => setTimeout(r, 1500));
      const plots = await fetchPlotsForMunicipality(muni);
      const newPlots = upsertListings(muni.code, muni.name, plots, hasTax);

      const totalFound = listings.length + plots.length;
      const totalNew = newCount + newPlots;

      db.prepare(`
        INSERT INTO update_log (municipality_code, listings_found, new_listings)
        VALUES (?, ?, ?)
      `).run(muni.code, totalFound, totalNew);

      if (totalFound > 0) {
        console.log(`    Found ${listings.length} homes + ${plots.length} plots (${totalNew} new)`);
      }

      // Rate limiting: 2s between municipalities
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`    Error for ${muni.name}:`, err.message);
      db.prepare(`
        INSERT INTO update_log (municipality_code, error)
        VALUES (?, ?)
      `).run(muni.code, err.message);
    }
  }

  isRefreshing = false;
  console.log(`[${new Date().toISOString()}] Update complete.`);
}

// Schedule updates every 6 hours
cron.schedule('0 */6 * * *', () => {
  console.log('Scheduled update triggered');
  runUpdate().catch(err => console.error('Scheduled update failed:', err));
});

// Start server
app.listen(PORT, () => {
  console.log(`Norway Property Finder running on http://localhost:${PORT}`);

  // Run initial update on startup if DB is empty
  const count = db.prepare('SELECT COUNT(*) as c FROM listings').get();
  if (count.c === 0) {
    console.log('Database empty, running initial fetch...');
    runUpdate().catch(err => console.error('Initial update failed:', err));
  }
});
