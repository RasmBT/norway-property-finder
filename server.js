const express = require('express');
const path = require('path');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const { fetchListingsForMunicipality, fetchAllListings } = require('./scraper');

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
    is_new INTEGER DEFAULT 1
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

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API: Get all municipalities with tax status
app.get('/api/municipalities', (req, res) => {
  const municipalities = require('./data/municipalities.json');
  res.json(municipalities);
});

// API: Get listings with filters
app.get('/api/listings', (req, res) => {
  const { municipality, min_price, max_price, min_area, property_type, sort, new_only } = req.query;

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
      shared_cost, shared_debt, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      price = excluded.price,
      price_text = excluded.price_text,
      title = excluded.title,
      image_url = excluded.image_url,
      shared_cost = excluded.shared_cost,
      shared_debt = excluded.shared_debt,
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
        listing.sharedDebt || 0
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

  console.log(`[${new Date().toISOString()}] Starting update for ${noTax.length} municipalities...`);

  // Mark all current listings as not-new before refresh
  db.prepare('UPDATE listings SET is_new = 0').run();

  for (const muni of noTax) {
    try {
      console.log(`  Fetching listings for ${muni.name} (${muni.code})...`);
      const listings = await fetchListingsForMunicipality(muni);

      const newCount = upsertListings(muni.code, muni.name, listings);

      db.prepare(`
        INSERT INTO update_log (municipality_code, listings_found, new_listings)
        VALUES (?, ?, ?)
      `).run(muni.code, listings.length, newCount);

      if (newCount > 0) {
        console.log(`    Found ${listings.length} listings (${newCount} new)`);
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
