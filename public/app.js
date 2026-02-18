// State
var map;
var markers = [];
var municipalities = [];
var listings = [];
var showTaxMunicipalities = true;
var currency = 'NOK';
var eurRate = null;
var statsCountByMuni = {};
var hoverMarker = null;
var miniMap = null;
var miniHoverMarker = null;
var miniMapDismissed = false;

// Initialize
document.addEventListener('DOMContentLoaded', async function() {
  initMap();
  initMiniMap();
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
    var wasCurrency = currency;
    currency = currency === 'NOK' ? 'EUR' : 'NOK';
    document.title = 'Norway Property Finder (' + currency + ')';

    var nokEl = document.getElementById('cur-nok');
    var eurEl = document.getElementById('cur-eur');
    nokEl.setAttribute('data-active', String(currency === 'NOK'));
    eurEl.setAttribute('data-active', String(currency === 'EUR'));

    var minPrice = document.getElementById('filter-min-price');
    var maxPrice = document.getElementById('filter-max-price');

    // Convert existing price filter values to the new currency
    if (eurRate) {
      if (wasCurrency === 'NOK' && currency === 'EUR') {
        // NOK → EUR
        if (minPrice.value) minPrice.value = Math.round(Number(minPrice.value) * eurRate);
        if (maxPrice.value) maxPrice.value = Math.round(Number(maxPrice.value) * eurRate);
      } else if (wasCurrency === 'EUR' && currency === 'NOK') {
        // EUR → NOK
        if (minPrice.value) minPrice.value = Math.round(Number(minPrice.value) / eurRate);
        if (maxPrice.value) maxPrice.value = Math.round(Number(maxPrice.value) / eurRate);
      }
    }

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

// --- MINI MAP ---
function initMiniMap() {
  miniMap = L.map('mini-map', {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
  }).setView([64.5, 14], 5);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 18,
  }).addTo(miniMap);

  // Sync mini-map when main map moves (zoom out 2 levels for wider context)
  map.on('moveend zoomend', function() {
    miniMap.setView(map.getCenter(), Math.max(map.getZoom() - 2, 4), { animate: false });
  });

  // Show/hide mini-map based on main map visibility
  var mapContainer = document.querySelector('.map-container');
  var wrapper = document.getElementById('mini-map-wrapper');

  var observer = new IntersectionObserver(function(entries) {
    var mainMapVisible = entries[0].isIntersecting;
    if (miniMapDismissed) return;
    if (mainMapVisible) {
      wrapper.classList.remove('visible');
    } else {
      wrapper.classList.add('visible');
      miniMap.invalidateSize();
      miniMap.setView(map.getCenter(), Math.max(map.getZoom() - 2, 4), { animate: false });
    }
  }, { threshold: 0.1 });

  observer.observe(mapContainer);
}

function closeMiniMap() {
  miniMapDismissed = true;
  var wrapper = document.getElementById('mini-map-wrapper');
  wrapper.classList.remove('visible');
  wrapper.classList.add('dismissed');
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
    var maxHeight = window.innerHeight - 120;
    var newHeight = Math.max(150, Math.min(maxHeight, startHeight + delta));
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
    var maxHeight = window.innerHeight - 120;
    var currentHeight = mapContainer.offsetHeight;
    if (currentHeight > maxHeight * 0.7) {
      mapContainer.style.height = '400px';
    } else {
      mapContainer.style.height = maxHeight + 'px';
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
  if (document.getElementById('filter-ownership').value !== '') return true;
  return false;
}

function plotMunicipalities() {
  markers.forEach(function(m) { map.removeLayer(m); });
  markers = [];

  var category = document.getElementById('filter-category').value;
  var section = category === 'tomt' ? 'plots' : 'homes';

  // Use non-municipality-filtered counts so all municipalities stay visible/clickable
  var countByMuni = Object.keys(statsCountByMuni).length > 0 ? statsCountByMuni : {};
  var filtersActive = Object.keys(countByMuni).length > 0;

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
      radius = 4;
      opacity = 0.2;
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
    } else {
      popupHtml += '<div style="margin-top:6px;font-size:11px;color:#8b8fa3;">Not tracked (has property tax)</div>';
    }

    popupHtml += '<a class="popup-link" href="https://www.finn.no/realestate/' + section + '/search.html?q=' +
      encodeURIComponent(muni.name.split(' - ')[0]) + '" target="_blank" rel="noopener">Browse on Finn.no</a>';

    marker.bindPopup(popupHtml);
    markers.push(marker);
  });
}

function toggleTaxMunicipalities() {
  showTaxMunicipalities = document.getElementById('show-tax').checked;
  plotMunicipalities();
}

function filterByMunicipality(code) {
  // Only change municipality — keep all other filters (category, price, etc.) intact
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
    await updateStats();
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

// Compute header stats from filtered listings, sidebar stats from non-municipality-filtered data
async function updateStats() {
  var total = listings.length;
  var newCount = 0;

  listings.forEach(function(l) {
    if (l.is_new) newCount++;
  });

  document.getElementById('total-count').textContent = total;
  document.getElementById('new-count').textContent = newCount;

  // Sidebar stats: fetch counts WITHOUT municipality filter so all municipalities stay clickable
  var statsParams = buildFilterParams();
  var p = new URLSearchParams(statsParams);
  p.delete('municipality');
  try {
    var resp = await fetch('/api/listing-counts?' + p.toString());
    var countData = await resp.json();
  } catch (e) {
    return;
  }

  var byCounts = {};
  var byNames = {};
  countData.forEach(function(row) {
    byCounts[row.municipality_code] = row.count;
    byNames[row.municipality_code] = row.municipality_name;
  });

  // Store globally so plotMunicipalities can use non-municipality-filtered counts
  statsCountByMuni = byCounts;

  var selectedMuni = document.getElementById('filter-municipality').value;

  var sorted = Object.keys(byCounts).map(function(code) {
    return { code: code, name: byNames[code], count: byCounts[code] };
  }).sort(function(a, b) { return b.count - a.count; });

  var statsList = document.getElementById('stats-list');
  statsList.innerHTML = sorted.map(function(s) {
    var isSelected = s.code === selectedMuni;
    return '<div class="stat-bar' + (isSelected ? ' selected' : '') + '" onclick="filterByMunicipality(\'' + s.code + '\')">' +
      '<span>' + escapeHtml(s.name) + '</span>' +
      '<span class="count">' + s.count + '</span></div>';
  }).join('');
}

// --- RENDERING ---
function renderListings(items) {
  var grid = document.getElementById('listings-grid');
  var countEl = document.getElementById('listings-count');
  countEl.textContent = items.length.toLocaleString('nb-NO') + ' properties';

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

    if (isTomt && listing.plot_owned === 'selveier') {
      badges += '<span class="listing-badge ownership-selveier">Selveier</span>';
    } else if (isTomt && listing.plot_owned === 'tomtefeste') {
      badges += '<span class="listing-badge ownership-tomtefeste">Tomtefeste</span>';
    }

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

    // Total price line (when different from asking price)
    var totalPriceHtml = '';
    if (isTomt && listing.total_price && listing.total_price !== listing.price) {
      totalPriceHtml = '<div class="listing-total-price">Total incl. costs: ' + formatPrice(listing.total_price) + '</div>';
    }

    // Expandable plot details section
    var plotDetailsHtml = '';
    if (isTomt) {
      var detailRows = [];
      if (listing.cadastre) detailRows.push('<div class="plot-detail-row"><span class="plot-detail-label">Cadastre</span><span>' + escapeHtml(listing.cadastre) + '</span></div>');
      if (listing.plot_owned) detailRows.push('<div class="plot-detail-row"><span class="plot-detail-label">Ownership</span><span>' + escapeHtml(listing.plot_owned === 'selveier' ? 'Selveier (freehold)' : 'Tomtefeste (leasehold)') + '</span></div>');
      if (listing.tax_value) detailRows.push('<div class="plot-detail-row"><span class="plot-detail-label">Tax value</span><span>' + formatPrice(listing.tax_value) + '</span></div>');
      if (listing.facilities) detailRows.push('<div class="plot-detail-row"><span class="plot-detail-label">Facilities</span><span>' + escapeHtml(listing.facilities) + '</span></div>');
      if (listing.utilities) detailRows.push('<div class="plot-detail-row"><span class="plot-detail-label">Utilities</span><span class="plot-detail-text">' + escapeHtml(listing.utilities) + '</span></div>');
      if (listing.regulations) detailRows.push('<div class="plot-detail-row"><span class="plot-detail-label">Zoning</span><span class="plot-detail-text">' + escapeHtml(listing.regulations) + '</span></div>');
      if (listing.yearly_costs_text) {
        detailRows.push('<div class="plot-detail-row"><span class="plot-detail-label">Yearly costs</span><span class="plot-detail-text">' + escapeHtml(listing.yearly_costs_text) + '</span></div>');
      } else {
        detailRows.push('<div class="plot-detail-row"><span class="plot-detail-label">Yearly costs</span><span class="plot-detail-muted">Not specified — check with municipality</span></div>');
      }
      var zeroPrice = currency === 'EUR' ? '\u20ac0' : '0 kr';
      detailRows.push('<div class="plot-detail-row"><span class="plot-detail-label">Property tax</span><span style="color:var(--green)">' + zeroPrice + ' (tax-free municipality)</span></div>');

      if (detailRows.length > 1) {
        var cardId = 'plot-details-' + listing.id;
        plotDetailsHtml = '<div class="plot-details-toggle" onclick="event.preventDefault(); event.stopPropagation(); togglePlotDetails(\'' + cardId + '\', this)">Plot details &#9662;</div>' +
          '<div class="plot-details-content" id="' + cardId + '" style="display:none">' + detailRows.join('') + '</div>';
      }
    }

    var hoverAttrs = '';
    if (listing.latitude && listing.longitude) {
      hoverAttrs = ' onmouseenter="highlightOnMap(' + listing.latitude + ',' + listing.longitude + ')" onmouseleave="removeMapHighlight()"';
    }

    return '<a class="listing-card' + (listing.is_new ? ' is-new' : '') + '" href="' + listing.finn_url + '" target="_blank" rel="noopener"' + hoverAttrs + '>' +
      imgHtml +
      '<div class="listing-body">' +
        '<div class="listing-badges">' + badges + '</div>' +
        '<div class="listing-title">' + escapeHtml(listing.title) + '</div>' +
        '<div class="listing-address">' + escapeHtml(listing.address) + '</div>' +
        obligationHint +
        '<div class="listing-details">' +
          '<div class="listing-price">' + priceHtml + totalPriceHtml + '</div>' +
          '<div class="listing-meta">' + metaParts.join('') + '</div>' +
        '</div>' +
        plotDetailsHtml +
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
  var ownership = document.getElementById('filter-ownership').value;

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
  if (ownership) params.set('plot_owned', ownership);

  return params.toString();
}

function onCategoryChange() {
  var category = document.getElementById('filter-category').value;
  var isTomt = category === 'tomt';
  document.getElementById('developed-filter').style.display = isTomt ? 'block' : 'none';
  document.getElementById('obligation-filter').style.display = isTomt ? 'block' : 'none';
  document.getElementById('ownership-filter').style.display = isTomt ? 'block' : 'none';
  if (!isTomt) {
    document.getElementById('filter-developed').value = '';
    document.getElementById('filter-obligation').value = 'all';
    document.getElementById('filter-ownership').value = '';
  }
  applyFilters();
}

function onListingsSortChange(value) {
  document.getElementById('filter-sort').value = value;
  applyFilters();
}

async function applyFilters() {
  // Keep listings sort in sync with sidebar sort
  var sidebarSort = document.getElementById('filter-sort').value;
  var listingsSort = document.getElementById('listings-sort');
  if (listingsSort) listingsSort.value = sidebarSort;

  updateFilterCount();
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
  var listingsSort = document.getElementById('listings-sort');
  if (listingsSort) listingsSort.value = 'newest';
  document.getElementById('filter-new-only').checked = false;
  document.getElementById('filter-category').value = 'home';
  document.getElementById('filter-developed').value = '';
  document.getElementById('filter-obligation').value = 'all';
  document.getElementById('filter-ownership').value = '';
  document.getElementById('developed-filter').style.display = 'none';
  document.getElementById('obligation-filter').style.display = 'none';
  document.getElementById('ownership-filter').style.display = 'none';
  var noFees = document.getElementById('filter-no-fees');
  if (noFees) noFees.checked = false;
  document.getElementById('listings-title').textContent = 'Properties in Tax-Free Municipalities';
  // Clear smart search too
  var ssInput = document.getElementById('smart-search-input');
  var ssStatus = document.getElementById('smart-search-status');
  if (ssInput) ssInput.value = '';
  if (ssStatus) { ssStatus.className = 'smart-search-status'; ssStatus.textContent = ''; }
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

// --- PLOT DETAILS TOGGLE ---
function togglePlotDetails(id, toggleEl) {
  var el = document.getElementById(id);
  if (!el) return;
  var isHidden = el.style.display === 'none';
  el.style.display = isHidden ? 'block' : 'none';
  toggleEl.innerHTML = isHidden ? 'Plot details &#9652;' : 'Plot details &#9662;';
}

// --- SMART SEARCH ---
async function runSmartSearch() {
  var input = document.getElementById('smart-search-input');
  var status = document.getElementById('smart-search-status');
  var btn = document.querySelector('.smart-search-btn');
  var query = input.value.trim();

  if (!query) {
    status.className = 'smart-search-status error';
    status.textContent = 'Type a search query first';
    return;
  }

  btn.disabled = true;
  status.className = 'smart-search-status loading';
  status.textContent = 'Interpreting your search...';

  try {
    var resp = await fetch('/api/smart-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query }),
    });

    if (!resp.ok) {
      var err = await resp.json().catch(function() { return {}; });
      throw new Error(err.error || 'Search failed');
    }

    var data = await resp.json();
    var filters = data.filters;

    if (!filters || Object.keys(filters).length === 0) {
      status.className = 'smart-search-status error';
      status.textContent = 'Could not understand the query. Try being more specific.';
      btn.disabled = false;
      return;
    }

    applySmartFilters(filters);
    status.className = 'smart-search-status success';
    status.textContent = buildStatusSummary(filters);
  } catch (err) {
    status.className = 'smart-search-status error';
    status.textContent = err.message || 'Search failed';
  }

  btn.disabled = false;
}

function applySmartFilters(params) {
  // Reset all filters to defaults
  document.getElementById('filter-municipality').value = '';
  document.getElementById('filter-min-price').value = '';
  document.getElementById('filter-max-price').value = '';
  document.getElementById('filter-min-area').value = '';
  document.getElementById('filter-property-type').value = '';
  document.getElementById('filter-sort').value = 'newest';
  var lsort = document.getElementById('listings-sort');
  if (lsort) lsort.value = 'newest';
  document.getElementById('filter-new-only').checked = false;
  document.getElementById('filter-category').value = 'home';
  document.getElementById('filter-developed').value = '';
  document.getElementById('filter-obligation').value = 'all';
  document.getElementById('filter-ownership').value = '';
  var noFees = document.getElementById('filter-no-fees');
  if (noFees) noFees.checked = false;

  // Apply returned params
  if (params.municipality) {
    document.getElementById('filter-municipality').value = params.municipality;
  }
  if (params.category) {
    document.getElementById('filter-category').value = params.category;
  }
  if (params.min_price) {
    var minP = Number(params.min_price);
    if (currency === 'EUR' && eurRate) minP = Math.round(minP * eurRate);
    document.getElementById('filter-min-price').value = minP;
  }
  if (params.max_price) {
    var maxP = Number(params.max_price);
    if (currency === 'EUR' && eurRate) maxP = Math.round(maxP * eurRate);
    document.getElementById('filter-max-price').value = maxP;
  }
  if (params.min_area) {
    document.getElementById('filter-min-area').value = params.min_area;
  }
  if (params.property_type) {
    document.getElementById('filter-property-type').value = params.property_type;
  }
  if (params.sort) {
    document.getElementById('filter-sort').value = params.sort;
  }
  if (params.new_only === '1') {
    document.getElementById('filter-new-only').checked = true;
  }
  if (params.no_fees === '1' && noFees) {
    noFees.checked = true;
  }
  if (params.developed) {
    document.getElementById('filter-developed').value = params.developed;
  }
  if (params.building_obligation) {
    document.getElementById('filter-obligation').value = params.building_obligation;
  }
  if (params.plot_owned) {
    document.getElementById('filter-ownership').value = params.plot_owned;
  }

  // Show/hide plot-specific filters and trigger search
  onCategoryChange();
}

function buildStatusSummary(params) {
  var parts = [];

  if (params.category === 'tomt') parts.push('Plots');
  else if (params.category === 'home') parts.push('Homes');
  else if (params.category === 'all') parts.push('All listings');

  if (params.municipality) {
    var muniEl = document.getElementById('filter-municipality');
    var opt = muniEl.querySelector('option[value="' + params.municipality + '"]');
    if (opt) parts.push('in ' + opt.textContent);
  }

  if (params.max_price) {
    var p = Number(params.max_price);
    if (p >= 1000000) parts.push('under ' + (p / 1000000) + 'M kr');
    else parts.push('under ' + p.toLocaleString('nb-NO') + ' kr');
  }
  if (params.min_price) {
    var mp = Number(params.min_price);
    if (mp >= 1000000) parts.push('from ' + (mp / 1000000) + 'M kr');
    else parts.push('from ' + mp.toLocaleString('nb-NO') + ' kr');
  }
  if (params.min_area) parts.push(params.min_area + '+ m\u00b2');
  if (params.property_type) parts.push(params.property_type);
  if (params.building_obligation === 'none') parts.push('no obligation');
  if (params.plot_owned === 'selveier') parts.push('freehold');
  if (params.plot_owned === 'tomtefeste') parts.push('leasehold');
  if (params.no_fees === '1') parts.push('no fees');
  if (params.new_only === '1') parts.push('new only');
  if (params.sort === 'price_asc') parts.push('cheapest first');
  if (params.sort === 'price_desc') parts.push('most expensive first');
  if (params.sort === 'area_desc') parts.push('largest first');
  if (params.sort === 'area_asc') parts.push('smallest first');

  return parts.length > 0 ? parts.join(', ') : 'Filters applied';
}

// --- MAP HOVER ---
function highlightOnMap(lat, lng) {
  removeMapHighlight();
  if (!lat || !lng) return;
  var markerOpts = {
    radius: 14,
    fillColor: '#3b82f6',
    color: '#fff',
    weight: 3,
    opacity: 1,
    fillOpacity: 0.7,
  };
  hoverMarker = L.circleMarker([lat, lng], markerOpts).addTo(map);
  // Only pan if the point is outside the current view, never zoom
  if (!map.getBounds().contains([lat, lng])) {
    map.panTo([lat, lng], { animate: true });
  }
  // Also highlight on mini-map
  if (miniMap) {
    miniHoverMarker = L.circleMarker([lat, lng], {
      radius: 10,
      fillColor: '#3b82f6',
      color: '#fff',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.8,
    }).addTo(miniMap);
  }
}

function removeMapHighlight() {
  if (hoverMarker) {
    map.removeLayer(hoverMarker);
    hoverMarker = null;
  }
  if (miniHoverMarker && miniMap) {
    miniMap.removeLayer(miniHoverMarker);
    miniHoverMarker = null;
  }
}

// --- UTILITIES ---
var escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, function(c) { return escapeMap[c]; });
}

// Debounced filter apply for text inputs
var debounceTimer = null;
function debouncedApplyFilters() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(function() { applyFilters(); }, 400);
}

// Back to top
function scrollToTop() {
  var content = document.querySelector('.content');
  if (content) content.scrollTo({ top: 0, behavior: 'smooth' });
}

// Show/hide back-to-top button based on scroll
(function() {
  var lastCheck = 0;
  function checkBackToTop() {
    var now = Date.now();
    if (now - lastCheck < 100) return;
    lastCheck = now;
    var content = document.querySelector('.content');
    var btn = document.getElementById('back-to-top');
    if (!content || !btn) return;
    if (content.scrollTop > 600) {
      btn.classList.add('visible');
    } else {
      btn.classList.remove('visible');
    }
  }
  document.addEventListener('DOMContentLoaded', function() {
    var content = document.querySelector('.content');
    if (content) content.addEventListener('scroll', checkBackToTop, { passive: true });
  });
})();

// Update active filter count on Clear Filters button
function updateFilterCount() {
  var count = 0;
  if (document.getElementById('filter-municipality').value !== '') count++;
  if (document.getElementById('filter-min-price').value !== '') count++;
  if (document.getElementById('filter-max-price').value !== '') count++;
  if (document.getElementById('filter-min-area').value !== '') count++;
  if (document.getElementById('filter-property-type').value !== '') count++;
  if (document.getElementById('filter-new-only').checked) count++;
  var noFees = document.getElementById('filter-no-fees');
  if (noFees && noFees.checked) count++;
  if (document.getElementById('filter-category').value !== 'home') count++;
  if (document.getElementById('filter-developed').value !== '') count++;
  if (document.getElementById('filter-obligation').value !== 'all') count++;
  if (document.getElementById('filter-ownership').value !== '') count++;
  if (document.getElementById('filter-sort').value !== 'newest') count++;

  var btn = document.getElementById('btn-clear');
  if (!btn) return;
  if (count > 0) {
    btn.textContent = 'Clear Filters (' + count + ')';
    btn.classList.add('has-filters');
  } else {
    btn.textContent = 'Clear Filters';
    btn.classList.remove('has-filters');
  }
}

function timeAgo(date) {
  var seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}
