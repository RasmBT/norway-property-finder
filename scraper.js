const path = require('path');
const fs = require('fs');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PAGES = 10; // Max pages per search (500 listings)
const PAGE_DELAY = 1500; // ms between page requests
const DETAIL_DELAY = 2000; // ms between detail page requests

/**
 * Decode React Router turbo-stream data from Finn.no pages.
 * Finn.no migrated from Remix (__remixContext) to React Router (__reactRouterContext)
 * which uses a streamed indexed-array serialization format.
 */
function decodeTurboStream(html) {
  // Extract the turbo-stream payload from the enqueue call
  const enqueueStart = html.indexOf('streamController.enqueue(');
  if (enqueueStart === -1) return null;

  const strStart = html.indexOf('"', enqueueStart + 24);
  if (strStart === -1) return null;

  // Walk the JS string to find the closing quote, respecting escapes
  let i = strStart + 1;
  while (i < html.length) {
    if (html[i] === '\\') { i += 2; continue; }
    if (html[i] === '"') break;
    i++;
  }

  const jsString = html.slice(strStart, i + 1);

  // Double-parse: first JS string unescape, then JSON array
  const inner = JSON.parse(jsString);
  return JSON.parse(inner);
}

/**
 * Resolve a turbo-stream indexed reference into a plain JS object.
 * The turbo-stream format stores data as a flat array where objects use
 * {"_keyIndex": valueIndex} pairs referencing other positions in the array.
 * Negative indices are special values (null/undefined).
 */
function resolveRef(arr, idx, depth = 0) {
  if (depth > 15) return null;

  let val;
  if (typeof idx === 'number') {
    if (idx < 0) return null; // -5 = undefined, -7 = null, etc.
    val = arr[idx];
  } else {
    val = idx;
  }

  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      const keyIdx = parseInt(k.replace('_', ''), 10);
      const keyName = arr[keyIdx];
      out[keyName] = resolveRef(arr, v, depth + 1);
    }
    return out;
  }

  if (Array.isArray(val)) {
    return val.map(x => resolveRef(arr, x, depth + 1));
  }

  return val;
}

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

    // Fetch detail pages for enhanced plot info
    for (let i = 0; i < plots.length; i++) {
      try {
        const details = await fetchPlotDetails(plots[i].finnUrl);
        plots[i].buildingObligation = details.buildingObligation;
        plots[i].buildingObligationText = details.buildingObligationText;
        plots[i].plotOwned = details.plotOwned;
        plots[i].totalPrice = details.totalPrice;
        plots[i].taxValue = details.taxValue;
        plots[i].cadastre = details.cadastre;
        plots[i].facilities = details.facilities;
        plots[i].regulations = details.regulations;
        plots[i].yearlyCostsText = details.yearlyCostsText;
        plots[i].utilities = details.utilities;
        plots[i].isDeveloped = details.isDeveloped;
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

  const arr = decodeTurboStream(html);
  if (!arr) {
    throw new Error('Could not find turbo-stream data in page');
  }

  // Find "docs" and "paging" keys in the flat array and resolve them
  const docsIdx = arr.indexOf('docs');
  const pagingIdx = arr.indexOf('paging');

  const docs = docsIdx >= 0 ? resolveRef(arr, arr[docsIdx + 1]) : null;
  const paging = pagingIdx >= 0 ? resolveRef(arr, arr[pagingIdx + 1]) : null;

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

    // isDeveloped will be determined from detail page facilities, not search results
    let isDeveloped = null;

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

// --- TEXT HELPERS ---

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '...';
}

/**
 * Find a text section by heading pattern — checks both agent format (generalText)
 * and FSBO format (propertyInfo), returns stripped text or null
 */
function findTextSection(ad, pattern) {
  // Agent format: generalText[].heading + textUnsafe
  if (Array.isArray(ad.generalText)) {
    for (const section of ad.generalText) {
      const heading = (section.heading || '').toLowerCase();
      if (heading.includes(pattern)) {
        return stripHtml(section.textUnsafe);
      }
    }
  }
  // FSBO format: propertyInfo[].title + content
  if (Array.isArray(ad.propertyInfo)) {
    for (const section of ad.propertyInfo) {
      const title = (section.title || '').toLowerCase();
      if (title.includes(pattern)) {
        return stripHtml(section.content || section.text || '');
      }
    }
  }
  return null;
}

/**
 * Collect all text from ad for keyword searching
 */
function collectAllText(ad) {
  const parts = [];
  if (ad.title) parts.push(ad.title);
  if (ad.regulations) parts.push(stripHtml(ad.regulations));
  if (Array.isArray(ad.generalText)) {
    for (const s of ad.generalText) {
      if (s.textUnsafe) parts.push(stripHtml(s.textUnsafe));
    }
  }
  if (Array.isArray(ad.propertyInfo)) {
    for (const s of ad.propertyInfo) {
      if (s.content) parts.push(stripHtml(s.content));
    }
  }
  return parts.join(' ').toLowerCase();
}

// --- PLOT DETAIL EXTRACTION ---

/**
 * Fetch a plot's detail page and extract all useful info
 */
async function fetchPlotDetails(finnUrl) {
  const defaults = {
    buildingObligation: 'unknown', buildingObligationText: null,
    plotOwned: null, totalPrice: null, taxValue: null,
    cadastre: null, facilities: null, regulations: null,
    yearlyCostsText: null, utilities: null,
  };

  const resp = await fetch(finnUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.7',
    },
  });

  if (!resp.ok) return defaults;

  const html = await resp.text();
  const arr = decodeTurboStream(html);
  if (!arr) return defaults;

  const ad = findAdData(arr);
  if (!ad) return defaults;

  // Extract all fields
  const details = {};

  // 1. Ownership (selveier vs tomtefeste)
  if (ad.plot && typeof ad.plot.owned === 'boolean') {
    details.plotOwned = ad.plot.owned ? 'selveier' : 'tomtefeste';
  } else {
    details.plotOwned = null;
  }

  // 2. Total price incl. omkostninger
  details.totalPrice = (ad.price && typeof ad.price.total === 'number') ? ad.price.total : null;

  // 3. Tax assessed value (formuesverdi)
  details.taxValue = (ad.price && typeof ad.price.taxValue === 'number') ? ad.price.taxValue : null;

  // 4. Cadastre (gnr/bnr)
  if (Array.isArray(ad.cadastres) && ad.cadastres.length > 0) {
    const c = ad.cadastres[0];
    details.cadastre = `gnr. ${c.landNumber} bnr. ${c.titleNumber}`;
  } else {
    details.cadastre = null;
  }

  // 5. Facilities
  if (Array.isArray(ad.facilities) && ad.facilities.length > 0) {
    details.facilities = ad.facilities.join(', ');
  } else {
    details.facilities = null;
  }

  // 6. Regulations/zoning
  let regs = findTextSection(ad, 'regulering');
  if (!regs && ad.regulations && typeof ad.regulations === 'string') {
    regs = stripHtml(ad.regulations);
  }
  details.regulations = regs ? truncate(regs, 500) : null;

  // 7. Yearly running costs
  let costs = findTextSection(ad, 'andre faste');
  if (!costs) costs = findTextSection(ad, 'løpende kostnader');
  if (!costs) costs = findTextSection(ad, 'kommunale avgifter');
  details.yearlyCostsText = costs ? truncate(costs, 500) : null;

  // 8. Utilities (vei/vann/avlop)
  let utils = findTextSection(ad, 'vei / vann');
  if (!utils) utils = findTextSection(ad, 'vann og avløp');
  if (!utils) utils = findTextSection(ad, 'infrastruktur');
  details.utilities = utils ? truncate(utils, 300) : null;

  // 9. Building obligation (existing keyword analysis)
  const fullText = collectAllText(ad);
  const oblResult = classifyObligation(fullText);
  details.buildingObligation = oblResult.obligation;
  details.buildingObligationText = oblResult.text;

  // 10. Developed status — check if infrastructure (water/sewer/electricity) is connected
  details.isDeveloped = classifyDeveloped(details.facilities, details.utilities, fullText);

  return details;
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
 * Classify whether a plot is developed (infrastructure connected) or undeveloped.
 * Developed = water, sewer, electricity, and road access are already connected/available.
 * Returns: 1 (developed), 0 (undeveloped), or null (unknown/insufficient data).
 */
function classifyDeveloped(facilities, utilities, fullText) {
  const facilLower = (facilities || '').toLowerCase();
  const utilLower = (utilities || '').toLowerCase();
  const combined = facilLower + ' ' + utilLower + ' ' + (fullText || '');

  // Strong indicator: "Offentlig vann/kloakk" in facilities means public water/sewer connected
  const hasPublicWater = facilLower.includes('offentlig vann');

  // Check utilities text for connected infrastructure
  const waterConnected = /vann.*tilkoblet|tilknyttet.*vann|koblet.*vann|vann.*lagt.*til|etablert.*vann|vann og avløp.*til tomtegrense|vann.*i tomtegrense/i.test(combined);
  const sewerConnected = /avløp.*tilkoblet|tilknyttet.*avløp|koblet.*avløp|kloakk.*tilkoblet/i.test(combined);
  const roadAccess = facilLower.includes('bilvei frem') || /adkomst.*vei|tilkomst.*vei|tilknyttet.*vei|vei.*til tomten/i.test(combined);
  const powerConnected = /strøm.*til.*tomt|el.*satt av|byggestrøm|strøm.*lagt/i.test(combined);

  // Check for NOT connected indicators
  const notConnected = /ikke tilkoblet|ikke tilknyttet|ikke koblet|tomten er ikke.*vann|må selv.*tilknytt|kjøper.*besørge tilkn/i.test(combined);

  // Developed: has public water/sewer OR multiple infrastructure items connected
  if (hasPublicWater && roadAccess) return 1;
  if (hasPublicWater && !notConnected) return 1;
  if (waterConnected && !notConnected) return 1;

  // Undeveloped: explicitly not connected
  if (notConnected) return 0;

  // If we have facilities data but no water/sewer mentioned, likely undeveloped
  if (facilities && !hasPublicWater && !waterConnected) return 0;

  // No data to determine
  return null;
}

/**
 * Find ad data in detail page turbo-stream array
 */
function findAdData(arr) {
  try {
    // Find "ad" key in the flat array and resolve the object it points to
    const adIdx = arr.indexOf('ad');
    if (adIdx < 0) return null;

    // The value after "ad" key should be a reference to the ad object
    const adRef = arr[adIdx + 1];
    if (adRef === undefined || adRef === null) return null;

    return resolveRef(arr, adRef);
  } catch (e) {
    return null;
  }
}

// Note: findDocs/findPaging no longer needed — turbo-stream decoder resolves
// "docs" and "paging" directly by index lookup in decodeTurboStream output.

module.exports = { fetchListingsForMunicipality, fetchPlotsForMunicipality };
