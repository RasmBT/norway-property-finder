const path = require('path');
const fs = require('fs');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 10; // Max pages per search (500 listings)
const PAGE_DELAY = 1500; // ms between page requests
const DETAIL_DELAY = 2000; // ms between detail page requests

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

  const shortName = name.split(' - ')[0].trim();
  if (finnLocations[shortName]) return finnLocations[shortName];

  const altName = name.split(' - ')[1]?.trim();
  if (altName && finnLocations[altName]) return finnLocations[altName];

  return null;
}

/**
 * Build search URL for a municipality
 */
function buildSearchUrl(municipality, section) {
  const locationCode = getFinnLocationCode(municipality.name);
  if (locationCode) {
    return {
      url: `https://www.finn.no/realestate/${section}/search.html?location=${encodeURIComponent(locationCode)}&sort=PUBLISHED_DESC`,
      hasLocationFilter: true,
    };
  }
  const name = municipality.name.split(' - ')[0].trim();
  return {
    url: `https://www.finn.no/realestate/${section}/search.html?q=${encodeURIComponent(name)}&sort=PUBLISHED_DESC`,
    hasLocationFilter: false,
  };
}

/**
 * Fetch all home listings for a municipality (all pages)
 */
async function fetchListingsForMunicipality(municipality) {
  const { url, hasLocationFilter } = buildSearchUrl(municipality, 'homes');
  try {
    return await scrapeAllPages(url, municipality, hasLocationFilter, 'home');
  } catch (err) {
    console.error(`  Error scraping homes ${municipality.name}: ${err.message}`);
    return [];
  }
}

/**
 * Fetch all plot (tomt) listings for a municipality (all pages)
 * Also fetches detail pages for byggeplikt detection
 */
async function fetchPlotsForMunicipality(municipality) {
  const { url, hasLocationFilter } = buildSearchUrl(municipality, 'plots');
  try {
    const plots = await scrapeAllPages(url, municipality, hasLocationFilter, 'tomt');

    // Fetch detail pages for byggeplikt detection
    for (let i = 0; i < plots.length; i++) {
      try {
        const details = await fetchBuildingObligation(plots[i].finnUrl);
        plots[i].buildingObligation = details.obligation;
        plots[i].buildingObligationText = details.text;
      } catch (err) {
        plots[i].buildingObligation = 'unknown';
        plots[i].buildingObligationText = null;
      }
      if (i < plots.length - 1) {
        await new Promise(r => setTimeout(r, DETAIL_DELAY));
      }
    }

    return plots;
  } catch (err) {
    console.error(`  Error scraping plots ${municipality.name}: ${err.message}`);
    return [];
  }
}

/**
 * Scrape all pages of a Finn.no search
 */
async function scrapeAllPages(baseUrl, municipality, hasLocationFilter, category) {
  let allListings = [];
  let page = 1;
  let lastPage = 1;

  do {
    const pageUrl = page === 1 ? baseUrl : `${baseUrl}&page=${page}`;
    const { listings, paging } = await scrapeSearchPage(pageUrl, municipality, hasLocationFilter, category);

    allListings.push(...listings);

    if (paging) {
      lastPage = Math.min(paging.last || 1, MAX_PAGES);
    }

    if (page < lastPage) {
      await new Promise(r => setTimeout(r, PAGE_DELAY));
    }
    page++;
  } while (page <= lastPage);

  return allListings;
}

/**
 * Scrape a single search page, returning listings + pagination info
 */
async function scrapeSearchPage(url, municipality, hasLocationFilter, category) {
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

  // Extract pagination metadata
  const paging = findPaging(data);
  const docs = findDocs(data);

  if (!docs || docs.length === 0) {
    return { listings: [], paging };
  }

  let filtered = docs;

  // If using keyword search, apply strict name filter
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

  const listings = filtered.map(doc => {
    const price = doc.price_suggestion?.amount || 0;
    const sharedCost = doc.price_shared_cost?.amount || 0;
    const propType = (doc.property_type_description || '').toLowerCase();

    let isDeveloped = null;
    if (category === 'tomt') {
      isDeveloped = propType.includes('boligtomt') ? 1 : 0;
    }

    const adSection = category === 'tomt' ? 'plots' : 'homes';

    return {
      id: String(doc.ad_id || doc.id),
      title: doc.heading || '',
      price: price > 0 ? price : null,
      priceText: price > 0 ? `${price.toLocaleString('nb-NO')} kr` : '',
      address: doc.location || municipality.name,
      area: doc.area_range?.size_from || doc.area_plot?.size || null,
      bedrooms: doc.number_of_bedrooms || null,
      propertyType: doc.property_type_description || '',
      imageUrl: doc.image?.url || (doc.image_urls?.[0] ? `https://images.finncdn.no/dynamic/default/${doc.image_urls[0]}` : ''),
      finnUrl: doc.canonical_url || `https://www.finn.no/realestate/${adSection}/ad.html?finnkode=${doc.ad_id || doc.id}`,
      latitude: doc.coordinates?.lat || null,
      longitude: doc.coordinates?.lon || null,
      sharedCost,
      sharedDebt: 0,
      category,
      isDeveloped,
      buildingObligation: 'unknown',
      buildingObligationText: null,
    };
  });

  return { listings, paging };
}

// --- BYGGEPLIKT DETECTION ---

// Keywords that indicate NO building obligation
const NO_OBLIGATION_PATTERNS = [
  'uten byggeklausul',
  'ingen byggeklausul',
  'ingen byggeplikt',
  'uten byggeplikt',
  'fri for byggeklausul',
  'ikke byggeklausul',
  'ingen leverandørbinding',
  'uten leverandørbinding',
  'fritt valg av',
  'velg selv',
  'valgfri',
];

// Keywords that indicate HAS building clause (tied to specific builder)
const HAS_CLAUSE_PATTERNS = [
  'med byggeklausul',
  'byggeklausul på',
  'leverandørbinding',
  'hustype',
  'boligen skal leveres av',
  'skal oppføres av',
  'utbygger er',
  'må bygges av',
];

// Keywords that indicate HAS deadline to build
const HAS_DEADLINE_PATTERNS = [
  'må bebygges innen',
  'skal bebygges innen',
  'bebygd innen',
  'byggefrist',
  'byggetid',
  'byggeplikt',
  'frist for bebyggelse',
  'forpliktet til å bygge',
  'bolig skal oppføres',
  'må bebygges slik',
  'plikt til å bebygge',
];

/**
 * Fetch a plot's detail page and detect building obligation
 */
async function fetchBuildingObligation(finnUrl) {
  const resp = await fetch(finnUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.7',
    },
  });

  if (!resp.ok) {
    return { obligation: 'unknown', text: null };
  }

  const html = await resp.text();

  const contextMatch = html.match(/window\.__remixContext\s*=\s*({.*?});\s*<\/script>/s);
  if (!contextMatch) {
    return { obligation: 'unknown', text: null };
  }

  let data;
  try {
    data = JSON.parse(contextMatch[1]);
  } catch (e) {
    return { obligation: 'unknown', text: null };
  }

  // Find the ad data in the detail page structure
  const ad = findAdData(data);
  if (!ad) {
    return { obligation: 'unknown', text: null };
  }

  // Collect all text from title + generalText sections
  const textParts = [];
  if (ad.title) textParts.push(ad.title);

  if (ad.generalText && Array.isArray(ad.generalText)) {
    for (const section of ad.generalText) {
      if (section.textUnsafe) {
        // Strip HTML tags
        const clean = section.textUnsafe.replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, ' ');
        textParts.push(clean);
      }
    }
  }

  const fullText = textParts.join(' ').toLowerCase();

  // Classify building obligation
  return classifyObligation(fullText);
}

/**
 * Classify building obligation from text
 * Priority: explicit "no obligation" > "has clause" > "has deadline" > "unknown"
 */
function classifyObligation(text) {
  // Check for explicit "no obligation" first (highest priority)
  for (const pattern of NO_OBLIGATION_PATTERNS) {
    if (text.includes(pattern)) {
      const idx = text.indexOf(pattern);
      const snippet = text.substring(Math.max(0, idx - 40), idx + pattern.length + 40).trim();
      return { obligation: 'none', text: snippet };
    }
  }

  // Check for builder clause
  for (const pattern of HAS_CLAUSE_PATTERNS) {
    if (text.includes(pattern)) {
      const idx = text.indexOf(pattern);
      const snippet = text.substring(Math.max(0, idx - 40), idx + pattern.length + 40).trim();
      return { obligation: 'has_clause', text: snippet };
    }
  }

  // Check for building deadline
  for (const pattern of HAS_DEADLINE_PATTERNS) {
    if (text.includes(pattern)) {
      const idx = text.indexOf(pattern);
      const snippet = text.substring(Math.max(0, idx - 40), idx + pattern.length + 40).trim();
      return { obligation: 'has_deadline', text: snippet };
    }
  }

  return { obligation: 'unknown', text: null };
}

/**
 * Find ad data in detail page __remixContext
 */
function findAdData(data) {
  try {
    const loaderData = data?.state?.loaderData;
    if (!loaderData) return null;

    // Try plots route key first, then homes
    for (const key of Object.keys(loaderData)) {
      if (key.includes('_item+/')) {
        const typed = loaderData[key]?.typedObjectData?.objectData?.ad;
        if (typed) return typed;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// --- UTILITY: Find docs array in search results ---

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

/**
 * Find pagination metadata in search results
 */
function findPaging(obj, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findPaging(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (obj.paging && typeof obj.paging === 'object' && 'last' in obj.paging) {
    return obj.paging;
  }

  for (const key of Object.keys(obj)) {
    const found = findPaging(obj[key], depth + 1);
    if (found) return found;
  }

  return null;
}

module.exports = { fetchListingsForMunicipality, fetchPlotsForMunicipality };
