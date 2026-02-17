// State
let map;
let markers = [];
let municipalities = [];
let listings = [];
let showTaxMunicipalities = true;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  await loadMunicipalities();
  await loadListings();
  await loadStats();
});

// --- MAP ---
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
  }).setView([64.5, 14], 5);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 18,
  }).addTo(map);

  // Add controls container
  const controlsDiv = document.createElement('div');
  controlsDiv.className = 'map-controls';
  controlsDiv.innerHTML = `
    <label class="map-toggle">
      <input type="checkbox" id="show-tax" checked onchange="toggleTaxMunicipalities()">
      Show municipalities with tax
    </label>
    <div class="map-legend">
      <div class="legend-item">
        <div class="legend-dot no-tax"></div>
        <span>No property tax</span>
      </div>
      <div class="legend-item">
        <div class="legend-dot has-tax"></div>
        <span>Has property tax</span>
      </div>
    </div>
  `;
  document.querySelector('.map-container').appendChild(controlsDiv);
}

function plotMunicipalities() {
  // Clear existing markers
  markers.forEach(m => map.removeLayer(m));
  markers = [];

  municipalities.forEach(muni => {
    // Skip tax municipalities if filter is off
    if (muni.hasPropertyTax && !showTaxMunicipalities) return;

    const color = muni.hasPropertyTax ? '#ef4444' : '#22c55e';
    const radius = muni.hasPropertyTax ? 5 : 8;
    const opacity = muni.hasPropertyTax ? 0.4 : 0.9;

    const marker = L.circleMarker([muni.lat, muni.lon], {
      radius,
      fillColor: color,
      color: color,
      weight: 1,
      opacity,
      fillOpacity: opacity * 0.7,
    }).addTo(map);

    const listingCount = listings.filter(l => l.municipality_code === muni.code).length;

    marker.bindPopup(`
      <div class="popup-title">${muni.name}</div>
      <span class="popup-badge ${muni.hasPropertyTax ? 'has-tax' : 'no-tax'}">
        ${muni.hasPropertyTax ? 'Has property tax' : 'No property tax'}
      </span>
      ${listingCount > 0 ? `<div class="popup-listings">${listingCount} listing${listingCount > 1 ? 's' : ''} found</div>` : ''}
      <a class="popup-link" href="#" onclick="event.preventDefault(); filterByMunicipality('${muni.code}')">
        ${listingCount > 0 ? 'Show listings' : 'Search on Finn.no'}
      </a>
      <br>
      <a class="popup-link" href="https://www.finn.no/realestate/homes/search.html?q=${encodeURIComponent(muni.name)}" target="_blank" rel="noopener">
        Open on Finn.no
      </a>
    `);

    markers.push(marker);
  });
}

function toggleTaxMunicipalities() {
  showTaxMunicipalities = document.getElementById('show-tax').checked;
  plotMunicipalities();
}

function filterByMunicipality(code) {
  document.getElementById('filter-municipality').value = code;
  applyFilters();

  // Scroll to listings
  document.querySelector('.listings-header').scrollIntoView({ behavior: 'smooth' });
}

// --- DATA LOADING ---
async function loadMunicipalities() {
  try {
    const resp = await fetch('/api/municipalities');
    municipalities = await resp.json();

    // Populate municipality filter
    const select = document.getElementById('filter-municipality');
    const noTax = municipalities.filter(m => !m.hasPropertyTax).sort((a, b) => a.name.localeCompare(b.name));
    const hasTax = municipalities.filter(m => m.hasPropertyTax).sort((a, b) => a.name.localeCompare(b.name));

    const noTaxGroup = document.createElement('optgroup');
    noTaxGroup.label = 'No Property Tax';
    noTax.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.code;
      opt.textContent = m.name;
      noTaxGroup.appendChild(opt);
    });

    const hasTaxGroup = document.createElement('optgroup');
    hasTaxGroup.label = 'Has Property Tax';
    hasTax.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.code;
      opt.textContent = m.name;
      hasTaxGroup.appendChild(opt);
    });

    select.appendChild(noTaxGroup);
    select.appendChild(hasTaxGroup);

    plotMunicipalities();
  } catch (err) {
    console.error('Failed to load municipalities:', err);
  }
}

async function loadListings() {
  const grid = document.getElementById('listings-grid');
  grid.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading listings...</p></div>';

  try {
    const params = buildFilterParams();
    const resp = await fetch(`/api/listings?${params}`);
    listings = await resp.json();
    renderListings(listings);
    plotMunicipalities(); // Update marker counts
  } catch (err) {
    console.error('Failed to load listings:', err);
    grid.innerHTML = '<div class="empty-state"><h3>Could not load listings</h3><p>The server may still be fetching data. Try refreshing in a few minutes.</p></div>';
  }
}

async function loadStats() {
  try {
    const resp = await fetch('/api/stats');
    const stats = await resp.json();

    document.getElementById('total-count').textContent = stats.total;
    document.getElementById('new-count').textContent = stats.new;

    if (stats.lastUpdate) {
      const date = new Date(stats.lastUpdate + 'Z');
      document.getElementById('last-update').textContent = `Updated ${timeAgo(date)}`;
    }

    // Render municipality stats
    const statsList = document.getElementById('stats-list');
    statsList.innerHTML = stats.byMunicipality.map(s => `
      <div class="stat-bar" onclick="filterByMunicipality('${s.municipality_code}')">
        <span>${s.municipality_name}</span>
        <span class="count">${s.count}</span>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// --- RENDERING ---
function renderListings(items) {
  const grid = document.getElementById('listings-grid');
  const countEl = document.getElementById('listings-count');

  countEl.textContent = `${items.length} properties`;

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <h3>No listings found</h3>
        <p>Try adjusting your filters or wait for the next data refresh.</p>
        <p style="margin-top:12px;font-size:13px;color:var(--text-muted)">
          The system fetches new listings every 6 hours from Finn.no
        </p>
      </div>
    `;
    return;
  }

  grid.innerHTML = items.map(listing => {
    const muni = municipalities.find(m => m.code === listing.municipality_code);
    const hasTax = muni ? muni.hasPropertyTax : false;

    return `
      <a class="listing-card ${listing.is_new ? 'is-new' : ''}" href="${listing.finn_url}" target="_blank" rel="noopener">
        ${listing.image_url
          ? `<img class="listing-image" src="${escapeHtml(listing.image_url)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'listing-image-placeholder\\'>No image</div>'">`
          : '<div class="listing-image-placeholder">No image</div>'
        }
        <div class="listing-body">
          <div class="listing-badges">
            ${listing.is_new ? '<span class="listing-badge new-badge">NEW</span>' : ''}
            ${listing.property_type ? `<span class="listing-badge type-badge">${escapeHtml(listing.property_type)}</span>` : ''}
            <span class="listing-badge municipality-badge">${escapeHtml(listing.municipality_name)}</span>
            ${!hasTax ? '<span class="listing-badge" style="background:rgba(34,197,94,0.1);color:#22c55e">No tax</span>' : ''}
          </div>
          <div class="listing-title">${escapeHtml(listing.title)}</div>
          <div class="listing-address">${escapeHtml(listing.address)}</div>
          <div class="listing-details">
            <div class="listing-price">${listing.price ? formatPrice(listing.price) : (listing.price_text || 'Price on request')}</div>
            <div class="listing-meta">
              ${listing.area_m2 ? `<span>${listing.area_m2} m²</span>` : ''}
              ${listing.bedrooms ? `<span>${listing.bedrooms} bed</span>` : ''}
              ${listing.shared_cost > 0 ? `<span style="color:var(--orange)">${listing.shared_cost.toLocaleString('nb-NO')} kr/mo</span>` : '<span style="color:var(--green)">No fees</span>'}
            </div>
          </div>
        </div>
      </a>
    `;
  }).join('');
}

// --- FILTERS ---
function buildFilterParams() {
  const params = new URLSearchParams();

  const municipality = document.getElementById('filter-municipality').value;
  const minPrice = document.getElementById('filter-min-price').value;
  const maxPrice = document.getElementById('filter-max-price').value;
  const minArea = document.getElementById('filter-min-area').value;
  const propertyType = document.getElementById('filter-property-type').value;
  const sort = document.getElementById('filter-sort').value;
  const newOnly = document.getElementById('filter-new-only').checked;
  const noFees = document.getElementById('filter-no-fees')?.checked;

  if (municipality) params.set('municipality', municipality);
  if (minPrice) params.set('min_price', minPrice);
  if (maxPrice) params.set('max_price', maxPrice);
  if (minArea) params.set('min_area', minArea);
  if (propertyType) params.set('property_type', propertyType);
  if (sort) params.set('sort', sort);
  if (newOnly) params.set('new_only', '1');
  if (noFees) params.set('no_fees', '1');

  return params.toString();
}

async function applyFilters() {
  await loadListings();

  // Update title based on selection
  const titleEl = document.getElementById('listings-title');
  const muniCode = document.getElementById('filter-municipality').value;
  if (muniCode) {
    const muni = municipalities.find(m => m.code === muniCode);
    if (muni) {
      titleEl.textContent = `Properties in ${muni.name}`;
    }
  } else {
    titleEl.textContent = 'Properties in Tax-Free Municipalities';
  }
}

function clearFilters() {
  document.getElementById('filter-municipality').value = '';
  document.getElementById('filter-min-price').value = '';
  document.getElementById('filter-max-price').value = '';
  document.getElementById('filter-min-area').value = '';
  document.getElementById('filter-property-type').value = '';
  document.getElementById('filter-sort').value = 'newest';
  document.getElementById('filter-new-only').checked = false;
  const noFees = document.getElementById('filter-no-fees');
  if (noFees) noFees.checked = false;
  document.getElementById('listings-title').textContent = 'Properties in Tax-Free Municipalities';
  applyFilters();
}

// --- ACTIONS ---
async function triggerRefresh() {
  const btn = document.querySelector('.btn-refresh');
  btn.classList.add('spinning');

  try {
    await fetch('/api/refresh', { method: 'POST' });
    document.getElementById('last-update').textContent = 'Refreshing...';
    // Poll for completion
    setTimeout(async () => {
      await loadListings();
      await loadStats();
      btn.classList.remove('spinning');
    }, 5000);
  } catch (err) {
    console.error('Refresh failed:', err);
    btn.classList.remove('spinning');
  }
}

// --- UTILITIES ---
function formatPrice(price) {
  if (!price) return '';
  return new Intl.NumberFormat('nb-NO', {
    style: 'currency',
    currency: 'NOK',
    maximumFractionDigits: 0,
  }).format(price);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
