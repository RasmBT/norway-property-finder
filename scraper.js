const path = require('path');
const fs = require('fs');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Load Finn.no location code mapping
let finnLocations = {};
try {
  finnLocations = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'finn_locations.json'), 'utf8'));
} catch (e) {
  console.warn('Warning: Could not load finn_locations.json, falling back to keyword search');
}

/**
 * Find Finn.no location code for a municipality
 */
function getFinnLocationCode(municipalityName) {
  const name = municipalityName.toLowerCase();
  if (finnLocations[name]) return finnLocations[name];

  // Try short name (before " - " for Sami names)
  const shortName = name.split(' - ')[0].trim();
  if (finnLocations[shortName]) return finnLocations[shortName];

  // Try the part after " - " (e.g. "Kárášjohka - Karasjok" → "karasjok")
  const altName = name.split(' - ')[1]?.trim();
  if (altName && finnLocations[altName]) return finnLocations[altName];

  return null;
}

/**
 * Fetch property listings from Finn.no for a given municipality.
 * Uses location codes for precise filtering when available.
 */
async function fetchListingsForMunicipality(municipality) {
  const locationCode = getFinnLocationCode(municipality.name);

  let url;
  if (locationCode) {
    // Use precise location filter
    url = `https://www.finn.no/realestate/homes/search.html?location=${encodeURIComponent(locationCode)}&sort=PUBLISHED_DESC`;
  } else {
    // Fallback to keyword search
    const name = municipality.name.split(' - ')[0].trim();
    url = `https://www.finn.no/realestate/homes/search.html?q=${encodeURIComponent(name)}&sort=PUBLISHED_DESC`;
  }

  try {
    const listings = await scrapeSearchPage(url, municipality, !!locationCode);
    return listings;
  } catch (err) {
    console.error(`  Error scraping ${municipality.name}: ${err.message}`);
    return [];
  }
}

async function scrapeSearchPage(url, municipality, hasLocationFilter) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.7',
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const html = await resp.text();

  // Extract __remixContext JSON from the page
  const contextMatch = html.match(/window\.__remixContext\s*=\s*({.*?});\s*<\/script>/s);
  if (!contextMatch) {
    throw new Error('Could not find __remixContext data');
  }

  let data;
  try {
    data = JSON.parse(contextMatch[1]);
  } catch (e) {
    throw new Error('Failed to parse __remixContext JSON');
  }

  const docs = findDocs(data);
  if (!docs || docs.length === 0) {
    return [];
  }

  let filtered = docs;

  // If using keyword search (no location filter), apply strict name filter
  if (!hasLocationFilter) {
    const muniNameShort = municipality.name.split(' - ')[0].trim().toLowerCase();
    filtered = docs.filter(doc => {
      const localArea = (doc.local_area_name || '').toLowerCase();
      const location = (doc.location || '').toLowerCase();
      if (localArea === muniNameShort) return true;
      if (location.endsWith(muniNameShort)) return true;
      if (location.includes(`, ${muniNameShort}`)) return true;
      return false;
    });
  }

  return filtered.map(doc => {
    const price = doc.price_suggestion?.amount || 0;
    const sharedCost = doc.price_shared_cost?.amount || 0;

    return {
      id: String(doc.ad_id || doc.id),
      title: doc.heading || '',
      price: price > 0 ? price : null,
      priceText: price > 0 ? `${price.toLocaleString('nb-NO')} kr` : '',
      address: doc.location || municipality.name,
      area: doc.area_range?.size_from || null,
      bedrooms: doc.number_of_bedrooms || null,
      propertyType: doc.property_type_description || '',
      imageUrl: doc.image?.url || (doc.image_urls?.[0] ? `https://images.finncdn.no/dynamic/default/${doc.image_urls[0]}` : ''),
      finnUrl: doc.canonical_url || `https://www.finn.no/realestate/homes/ad.html?finnkode=${doc.ad_id || doc.id}`,
      latitude: doc.coordinates?.lat || null,
      longitude: doc.coordinates?.lon || null,
      sharedCost,
      sharedDebt: 0,
    };
  });
}

function findDocs(obj, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return null;

  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj[0]?.ad_id) return obj;
    for (const item of obj) {
      const found = findDocs(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (obj.docs && Array.isArray(obj.docs) && obj.docs.length > 0) {
    return obj.docs;
  }

  for (const key of Object.keys(obj)) {
    const found = findDocs(obj[key], depth + 1);
    if (found) return found;
  }

  return null;
}

module.exports = { fetchListingsForMunicipality };
