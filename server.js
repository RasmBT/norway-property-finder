const express = require('express');
const path = require('path');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const { fetchListingsForMunicipality, fetchPlotsForMunicipality } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3456;

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

db.exec("CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_obligation ON listings(building_obligation)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_plot_owned ON listings(plot_owned)");

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
    sql += ' AND municipality_code = ?';
    params.push(municipality);
  }
  if (min_price) {
    sql += ' AND price >= ?';
    params.push(Number(min_price));
  }
  if (max_price) {
    sql += ' AND price <= ?';
    params.push(Number(max_price));
  }
  if (min_area) {
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

  switch (sort) {
    case 'price_asc': sql += ' ORDER BY price ASC NULLS LAST'; break;
    case 'price_desc': sql += ' ORDER BY price DESC NULLS LAST'; break;
    case 'area_desc': sql += ' ORDER BY area_m2 DESC NULLS LAST'; break;
    case 'newest': sql += ' ORDER BY first_seen DESC'; break;
    default: sql += ' ORDER BY first_seen DESC';
  }

  const listings = db.prepare(sql).all(...params);
  res.json(listings);
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

// Upsert listings into database
function upsertListings(municipalityCode, municipalityName, listings) {
  const upsert = db.prepare(`
    INSERT INTO listings (id, municipality_code, municipality_name, title, price, price_text,
      address, area_m2, bedrooms, property_type, image_url, finn_url, latitude, longitude,
      shared_cost, shared_debt, category, is_developed, building_obligation, building_obligation_text,
      plot_owned, total_price, tax_value, cadastre, facilities, regulations, yearly_costs_text, utilities,
      last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
        listing.utilities || null
      );
    }
  });

  transaction(listings);

  // Remove stale listings (not seen in 7 days)
  db.prepare(`
    DELETE FROM listings
    WHERE municipality_code = ? AND last_seen < datetime('now', '-7 days')
  `).run(municipalityCode);

  return newCount;
}

// Run full update
async function runUpdate() {
  const municipalities = require('./data/municipalities.json');
  const noTax = municipalities.filter(m => !m.hasPropertyTax);

  isRefreshing = true;
  refreshProgress = 0;
  refreshTotal = noTax.length;

  console.log(`[${new Date().toISOString()}] Starting update for ${noTax.length} municipalities...`);

  // Mark all current listings as not-new before refresh
  db.prepare('UPDATE listings SET is_new = 0').run();

  for (const muni of noTax) {
    refreshProgress++;
    try {
      // Fetch homes
      console.log(`  Fetching homes for ${muni.name} (${muni.code})...`);
      const listings = await fetchListingsForMunicipality(muni);
      const newCount = upsertListings(muni.code, muni.name, listings);

      // Fetch plots (tomt)
      console.log(`  Fetching plots for ${muni.name} (${muni.code})...`);
      await new Promise(r => setTimeout(r, 1500));
      const plots = await fetchPlotsForMunicipality(muni);
      const newPlots = upsertListings(muni.code, muni.name, plots);

      const totalFound = listings.length + plots.length;
      const totalNew = newCount + newPlots;

      db.prepare(`
        INSERT INTO update_log (municipality_code, listings_found, new_listings)
        VALUES (?, ?, ?)
      `).run(muni.code, totalFound, totalNew);

      if (totalNew > 0) {
        console.log(`    Found ${listings.length} homes + ${plots.length} plots (${totalNew} new)`);
      }

      // Rate limiting: 2s between requests
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
