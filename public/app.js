// State
var map;
var markers = [];
var municipalities = [];
var listings = [];
var showTaxMunicipalities = true;
var currency = 'NOK';
var eurRate = null;

// Initialize
document.addEventListener('DOMContentLoaded', async function() {
  initMap();
  initDragHandle();
  await loadExchangeRate();
  await loadMunicipalities();
  await loadListings();
  loadLastUpdate();
});

// --- CURRENCY ---
async function loadExchangeRate() {
  try {
    var resp = await fetch('/api/exchange-rate');
    var data = await resp.json();
    eurRate = data.NOK_EUR;
  } catch (e) {
    eurRate = 0.085;
  }
}

function toggleCurrency() {
  try {
    currency = currency === 'NOK' ? 'EUR' : 'NOK';
    document.title = 'Norway Property Finder (' + currency + ')';

    var nokEl = document.getElementById('cur-nok');
    var eurEl = document.getElementById('cur-eur');
    nokEl.setAttribute('data-active', String(currency === 'NOK'));
    eurEl.setAttribute('data-active', String(currency === 'EUR'));

    var minPrice = document.getElementById('filter-min-price');
    var maxPrice = document.getElementById('filter-max-price');
    if (currency === 'EUR') {
      minPrice.placeholder = 'Min (\u20ac)';
      maxPrice.placeholder = 'Max (\u20ac)';
    } else {
      minPrice.placeholder = 'Min (kr)';
      maxPrice.placeholder = 'Max (kr)';
    }

    renderListings(listings);
  } catch (err) {
    document.title = 'TOGGLE ERROR: ' + err.message;
  }
}

function formatPrice(price) {
  if (!price) return '';
  if (currency === 'EUR' && eurRate) {
    var eur = Math.round(price * eurRate);
    return '\u20ac' + eur.toLocaleString('de-DE');
  }
  return price.toLocaleString('nb-NO') + ' kr';
}

function formatSharedCost(cost) {
  if (!cost || cost === 0) return '';
  if (currency === 'EUR' && eurRate) {
    return '\u20ac' + Math.round(cost * eurRate).toLocaleString('de-DE') + '/mo';
  }
  return cost.toLocaleString('nb-NO') + ' kr/mo';
}

// --- MAP ---
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
  }).setView([64.5, 14], 5);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 18,
  }).addTo(map);

  var controlsDiv = document.createElement('div');
  controlsDiv.className = 'map-controls';
  controlsDiv.innerHTML = '<label class="map-toggle">' +
    '<input type="checkbox" id="show-tax" checked onchange="toggleTaxMunicipalities()">' +
    ' Show municipalities with tax</label>' +
    '<div class="map-legend">' +
    '<div class="legend-item"><div class="legend-dot no-tax"></div><span>No property tax</span></div>' +
    '<div class="legend-item"><div class="legend-dot has-tax"></div><span>Has property tax</span></div>' +
    '</div>';
  document.querySelector('.map-container').appendChild(controlsDiv);
}

// --- DRAG HANDLE ---
function initDragHandle() {
  var handle = document.getElementById('drag-handle');
  var mapContainer = document.querySelector('.map-container');
  var content = document.querySelector('.content');
  var isDragging = false;
  var startY = 0;
  var startHeight = 0;

  function onStart(e) {
    isDragging = true;
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    startHeight = mapContainer.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  function onMove(e) {
    if (!isDragging) return;
    var clientY = e.touches ? e.touches[0].clientY : e.clientY;
    var delta = clientY - startY;
    var contentHeight = content.offsetHeight;
    var newHeight = Math.max(150, Math.min(contentHeight - 100, startHeight + delta));
    mapContainer.style.height = newHeight + 'px';
    map.invalidateSize();
  }

  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  handle.addEventListener('mousedown', onStart);
  handle.addEventListener('touchstart', onStart, { passive: false });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchend', onEnd);

  handle.addEventListener('dblclick', function() {
    var contentHeight = content.offsetHeight;
    var currentHeight = mapContainer.offsetHeight;
    if (currentHeight > contentHeight * 0.7) {
      mapContainer.style.height = '400px';
    } else {
      mapContainer.style.height = (contentHeight - 80) + 'px';
    }
    map.invalidateSize();
  });
}

// Check if any filter is set beyond the defaults
function hasActiveFilters() {
  if (document.getElementById('filter-municipality').value !== '') return true;
  if (document.getElementById('filter-min-price').value !== '') return true;
  if (document.getElementById('filter-max-price').value !== '') return true;
  if (document.getElementById('filter-min-area').value !== '') return true;
  if (document.getElementById('filter-property-type').value !== '') return true;
  if (document.getElementById('filter-new-only').checked) return true;
  var noFeesEl = document.getElementById('filter-no-fees');
  if (noFeesEl && noFeesEl.checked) return true;
  if (document.getElementById('filter-category').value !== 'home') return true;
  if (document.getElementById('filter-developed').value !== '') return true;
  if (document.getElementById('filter-obligation').value !== 'all') return true;
  return false;
}

function plotMunicipalities() {
  markers.forEach(function(m) { map.removeLayer(m); });
  markers = [];

  var filtersActive = hasActiveFilters();
  var category = document.getElementById('filter-category').value;
  var section = category === 'tomt' ? 'plots' : 'homes';

  // Pre-compute listing counts per municipality from filtered results
  var countByMuni = {};
  listings.forEach(function(l) {
    countByMuni[l.municipality_code] = (countByMuni[l.municipality_code] || 0) + 1;
  });

  municipalities.forEach(function(muni) {
    if (muni.hasPropertyTax && !showTaxMunicipalities) return;

    var listingCount = countByMuni[muni.code] || 0;
    var color, radius, opacity;

    if (muni.hasPropertyTax) {
      // Tax municipalities always dim red
      color = '#ef4444';
      radius = 5;
      opacity = 0.4;
    } else if (filtersActive && listingCount === 0) {
      // No-tax municipality with 0 filtered results: dim it heavily
      color = '#22c55e';
      radius = 3;
      opacity = 0.08;
    } else {
      // No-tax municipality with listings (or no filters active)
      color = '#22c55e';
      radius = listingCount > 0 ? Math.min(6 + Math.sqrt(listingCount) * 1.5, 16) : 7;
      opacity = 0.9;
    }

    var marker = L.circleMarker([muni.lat, muni.lon], {
      radius: radius,
      fillColor: color,
      color: color,
      weight: 1,
      opacity: opacity,
      fillOpacity: opacity * 0.7,
    }).addTo(map);

    // Build popup
    var popupHtml = '<div class="popup-title">' + escapeHtml(muni.name) + '</div>' +
      '<span class="popup-badge ' + (muni.hasPropertyTax ? 'has-tax' : 'no-tax') + '">' +
        (muni.hasPropertyTax ? 'Has property tax' : 'No property tax') +
      '</span>';

    if (listingCount > 0) {
      popupHtml += '<div class="popup-listings">' + listingCount + ' listing' + (listingCount !== 1 ? 's' : '') + ' found</div>';
    }

    if (!muni.hasPropertyTax) {
      popupHtml += '<a class="popup-link" href="#" onclick="event.preventDefault(); filterByMunicipality(\'' + muni.code + '\')">' +
        (listingCount > 0 ? 'Show listings' : 'Filter this municipality') +
      '</a><br>';
    }

    popupHtml += '<a class="popup-link" href="https://www.finn.no/realestate/' + section + '/search.html?q=' +
      encodeURIComponent(muni.name.split(' - ')[0]) + '" target="_blank" rel="noopener">Open on Finn.no</a>';

    marker.bindPopup(popupHtml);
    markers.push(marker);
  });
}

function toggleTaxMunicipalities() {
  showTaxMunicipalities = document.getElementById('show-tax').checked;
  plotMunicipalities();
}

function filterByMunicipality(code) {
  // Reset all filters, then set just the municipality
  document.getElementById('filter-min-price').value = '';
  document.getElementById('filter-max-price').value = '';
  document.getElementById('filter-min-area').value = '';
  document.getElementById('filter-property-type').value = '';
  document.getElementById('filter-sort').value = 'newest';
  document.getElementById('filter-new-only').checked = false;
  document.getElementById('filter-category').value = 'all';
  document.getElementById('filter-developed').value = '';
  document.getElementById('filter-obligation').value = 'all';
  document.getElementById('developed-filter').style.display = 'none';
  document.getElementById('obligation-filter').style.display = 'none';
  var noFees = document.getElementById('filter-no-fees');
  if (noFees) noFees.checked = false;

  document.getElementById('filter-municipality').value = code;
  applyFilters();
  document.querySelector('.listings-header').scrollIntoView({ behavior: 'smooth' });
}

// --- DATA LOADING ---
async function loadMunicipalities() {
  try {
    var resp = await fetch('/api/municipalities');
    municipalities = await resp.json();

    var select = document.getElementById('filter-municipality');
    var noTax = municipalities.filter(function(m) { return !m.hasPropertyTax; }).sort(function(a, b) { return a.name.localeCompare(b.name); });
    var hasTax = municipalities.filter(function(m) { return m.hasPropertyTax; }).sort(function(a, b) { return a.name.localeCompare(b.name); });

    var noTaxGroup = document.createElement('optgroup');
    noTaxGroup.label = 'No Property Tax (' + noTax.length + ')';
    noTax.forEach(function(m) {
      var opt = document.createElement('option');
      opt.value = m.code;
      opt.textContent = m.name;
      noTaxGroup.appendChild(opt);
    });

    var hasTaxGroup = document.createElement('optgroup');
    hasTaxGroup.label = 'Has Property Tax (' + hasTax.length + ')';
    hasTax.forEach(function(m) {
      var opt = document.createElement('option');
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
  var grid = document.getElementById('listings-grid');
  grid.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading listings...</p></div>';

  try {
    var params = buildFilterParams();
    var resp = await fetch('/api/listings?' + params);
    listings = await resp.json();
    renderListings(listings);
    updateStats();
    plotMunicipalities();
  } catch (err) {
    console.error('Failed to load listings:', err);
    grid.innerHTML = '<div class="empty-state"><h3>Could not load listings</h3><p>Try refreshing in a few minutes.</p></div>';
  }
}

// Load lastUpdate time from server (separate from filtered stats)
async function loadLastUpdate() {
  try {
    var resp = await fetch('/api/stats');
    var stats = await resp.json();
    if (stats.lastUpdate) {
      var date = new Date(stats.lastUpdate + 'Z');
      document.getElementById('last-update').textContent = 'Updated ' + timeAgo(date);
    }
  } catch (e) {
    // ignore
  }
}

// Compute header stats + sidebar stats from the filtered listings array
function updateStats() {
  var total = listings.length;
  var newCount = 0;
  var byCounts = {};
  var byNames = {};

  listings.forEach(function(l) {
    if (l.is_new) newCount++;
    if (!byCounts[l.municipality_code]) {
      byCounts[l.municipality_code] = 0;
      byNames[l.municipality_code] = l.municipality_name;
    }
    byCounts[l.municipality_code]++;
  });

  document.getElementById('total-count').textContent = total;
  document.getElementById('new-count').textContent = newCount;

  var sorted = Object.keys(byCounts).map(function(code) {
    return { code: code, name: byNames[code], count: byCounts[code] };
  }).sort(function(a, b) { return b.count - a.count; });

  var statsList = document.getElementById('stats-list');
  statsList.innerHTML = sorted.map(function(s) {
    return '<div class="stat-bar" onclick="filterByMunicipality(\'' + s.code + '\')">' +
      '<span>' + escapeHtml(s.name) + '</span>' +
      '<span class="count">' + s.count + '</span></div>';
  }).join('');
}

// --- RENDERING ---
function renderListings(items) {
  var grid = document.getElementById('listings-grid');
  var countEl = document.getElementById('listings-count');
  countEl.textContent = items.length + ' properties';

  if (items.length === 0) {
    grid.innerHTML = '<div class="empty-state">' +
      '<h3>No listings found</h3>' +
      '<p>Try adjusting your filters or wait for the next data refresh.</p>' +
      '<p style="margin-top:12px;font-size:13px;color:var(--text-muted)">Listings update every 6 hours from Finn.no</p>' +
      '</div>';
    return;
  }

  grid.innerHTML = items.map(function(listing) {
    var muni = municipalities.find(function(m) { return m.code === listing.municipality_code; });
    var hasTax = muni ? muni.hasPropertyTax : false;
    var isTomt = listing.category === 'tomt';
    var obl = listing.building_obligation;

    var badges = '';
    if (listing.is_new) badges += '<span class="listing-badge new-badge">NEW</span>';
    if (isTomt) badges += '<span class="listing-badge tomt-badge">TOMT</span>';
    if (isTomt && listing.is_developed === 1) badges += '<span class="listing-badge developed-badge">Developed</span>';
    if (isTomt && listing.is_developed === 0) badges += '<span class="listing-badge undeveloped-badge">Undeveloped</span>';

    if (isTomt && obl === 'none') {
      badges += '<span class="listing-badge obligation-none" title="No byggeklausul detected">No obligation</span>';
    } else if (isTomt && obl === 'has_clause') {
      badges += '<span class="listing-badge obligation-clause" title="Tied to specific builder">Builder clause</span>';
    } else if (isTomt && obl === 'has_deadline') {
      badges += '<span class="listing-badge obligation-deadline" title="Must build within deadline">Build deadline</span>';
    }

    if (listing.property_type) badges += '<span class="listing-badge type-badge">' + escapeHtml(listing.property_type) + '</span>';
    badges += '<span class="listing-badge municipality-badge">' + escapeHtml(listing.municipality_name) + '</span>';
    if (!hasTax) badges += '<span class="listing-badge" style="background:rgba(34,197,94,0.1);color:#22c55e">No tax</span>';

    var imgHtml = listing.image_url
      ? '<img class="listing-image" src="' + escapeHtml(listing.image_url) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
      : '<div class="listing-image-placeholder">No image</div>';

    var priceHtml = listing.price ? formatPrice(listing.price) : (listing.price_text || 'Price on request');

    var metaParts = [];
    if (listing.area_m2) metaParts.push('<span>' + listing.area_m2 + ' m\u00b2</span>');
    if (listing.bedrooms) metaParts.push('<span>' + listing.bedrooms + ' bed</span>');
    if (listing.shared_cost > 0) {
      metaParts.push('<span style="color:var(--orange)">' + formatSharedCost(listing.shared_cost) + '</span>');
    } else if (!isTomt) {
      metaParts.push('<span style="color:var(--green)">No fees</span>');
    }

    var obligationHint = '';
    if (isTomt && listing.building_obligation_text) {
      obligationHint = '<div class="listing-obligation-hint">"...' + escapeHtml(listing.building_obligation_text) + '..."</div>';
    }

    return '<a class="listing-card' + (listing.is_new ? ' is-new' : '') + '" href="' + listing.finn_url + '" target="_blank" rel="noopener">' +
      imgHtml +
      '<div class="listing-body">' +
        '<div class="listing-badges">' + badges + '</div>' +
        '<div class="listing-title">' + escapeHtml(listing.title) + '</div>' +
        '<div class="listing-address">' + escapeHtml(listing.address) + '</div>' +
        obligationHint +
        '<div class="listing-details">' +
          '<div class="listing-price">' + priceHtml + '</div>' +
          '<div class="listing-meta">' + metaParts.join('') + '</div>' +
        '</div>' +
      '</div></a>';
  }).join('');
}

// --- FILTERS ---
function buildFilterParams() {
  var params = new URLSearchParams();

  var municipality = document.getElementById('filter-municipality').value;
  var minPrice = document.getElementById('filter-min-price').value;
  var maxPrice = document.getElementById('filter-max-price').value;
  var minArea = document.getElementById('filter-min-area').value;
  var propertyType = document.getElementById('filter-property-type').value;
  var sort = document.getElementById('filter-sort').value;
  var newOnly = document.getElementById('filter-new-only').checked;
  var noFeesEl = document.getElementById('filter-no-fees');
  var noFees = noFeesEl ? noFeesEl.checked : false;
  var category = document.getElementById('filter-category').value;
  var developed = document.getElementById('filter-developed').value;
  var obligation = document.getElementById('filter-obligation').value;

  if (municipality) params.set('municipality', municipality);
  if (minPrice) {
    var p = Number(minPrice);
    if (currency === 'EUR' && eurRate) p = Math.round(p / eurRate);
    params.set('min_price', p);
  }
  if (maxPrice) {
    var p2 = Number(maxPrice);
    if (currency === 'EUR' && eurRate) p2 = Math.round(p2 / eurRate);
    params.set('max_price', p2);
  }
  if (minArea) params.set('min_area', minArea);
  if (propertyType) params.set('property_type', propertyType);
  if (sort) params.set('sort', sort);
  if (newOnly) params.set('new_only', '1');
  if (noFees) params.set('no_fees', '1');
  if (category && category !== 'all') params.set('category', category);
  if (developed) params.set('developed', developed);
  if (obligation && obligation !== 'all') params.set('building_obligation', obligation);

  return params.toString();
}

function onCategoryChange() {
  var category = document.getElementById('filter-category').value;
  var isTomt = category === 'tomt';
  document.getElementById('developed-filter').style.display = isTomt ? 'block' : 'none';
  document.getElementById('obligation-filter').style.display = isTomt ? 'block' : 'none';
  if (!isTomt) {
    document.getElementById('filter-developed').value = '';
    document.getElementById('filter-obligation').value = 'all';
  }
  applyFilters();
}

async function applyFilters() {
  await loadListings();

  var titleEl = document.getElementById('listings-title');
  var muniCode = document.getElementById('filter-municipality').value;
  var category = document.getElementById('filter-category').value;

  var title = 'Properties';
  if (category === 'tomt') title = 'Plots (Tomt)';
  else if (category === 'all') title = 'All Properties & Plots';

  if (muniCode) {
    var muni = municipalities.find(function(m) { return m.code === muniCode; });
    if (muni) {
      titleEl.textContent = title + ' in ' + muni.name;
      return;
    }
  }
  titleEl.textContent = title + ' in Tax-Free Municipalities';
}

function clearFilters() {
  document.getElementById('filter-municipality').value = '';
  document.getElementById('filter-min-price').value = '';
  document.getElementById('filter-max-price').value = '';
  document.getElementById('filter-min-area').value = '';
  document.getElementById('filter-property-type').value = '';
  document.getElementById('filter-sort').value = 'newest';
  document.getElementById('filter-new-only').checked = false;
  document.getElementById('filter-category').value = 'home';
  document.getElementById('filter-developed').value = '';
  document.getElementById('filter-obligation').value = 'all';
  document.getElementById('developed-filter').style.display = 'none';
  document.getElementById('obligation-filter').style.display = 'none';
  var noFees = document.getElementById('filter-no-fees');
  if (noFees) noFees.checked = false;
  document.getElementById('listings-title').textContent = 'Properties in Tax-Free Municipalities';
  applyFilters();
}

// --- ACTIONS ---
var refreshInterval = null;

async function triggerRefresh() {
  var btn = document.querySelector('.btn-refresh');
  btn.classList.add('spinning');

  try {
    await fetch('/api/refresh', { method: 'POST' });
    document.getElementById('last-update').textContent = 'Refreshing...';

    // Poll every 15 seconds for up to 10 minutes
    var attempts = 0;
    if (refreshInterval) clearInterval(refreshInterval);

    refreshInterval = setInterval(async function() {
      attempts++;
      try {
        var resp = await fetch('/api/refresh-status');
        var status = await resp.json();

        if (status.refreshing) {
          document.getElementById('last-update').textContent =
            'Refreshing... (' + status.progress + '/' + status.total + ')';
        } else {
          clearInterval(refreshInterval);
          refreshInterval = null;
          btn.classList.remove('spinning');
          await loadListings();
          await loadLastUpdate();
          return;
        }
      } catch (e) {}

      if (attempts >= 40) {
        clearInterval(refreshInterval);
        refreshInterval = null;
        btn.classList.remove('spinning');
        await loadListings();
        await loadLastUpdate();
      }
    }, 15000);
  } catch (err) {
    console.error('Refresh failed:', err);
    btn.classList.remove('spinning');
  }
}

// --- UTILITIES ---
function escapeHtml(str) {
  if (!str) return '';
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(date) {
  var seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}
