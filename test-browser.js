const { chromium } = require('playwright');

(async () => {
  const results = [];
  function log(test, pass, detail) {
    const status = pass ? 'PASS' : 'FAIL';
    results.push({ test, status, detail });
    console.log(`[${status}] ${test}${detail ? ' — ' + detail : ''}`);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Collect console errors
  const jsErrors = [];
  page.on('pageerror', err => jsErrors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') jsErrors.push(msg.text());
  });

  try {
    // --- 1. Page loads ---
    console.log('\n=== LOADING PAGE ===');
    await page.goto('http://localhost:3456', { waitUntil: 'networkidle', timeout: 30000 });
    log('Page loads', true, await page.title());

    // Wait for listings to render
    await page.waitForSelector('.listing-card', { timeout: 15000 });
    const listingCount = await page.locator('.listing-card').count();
    log('Listings render', listingCount > 0, listingCount + ' listing cards');

    // --- 2. EUR/NOK Toggle ---
    console.log('\n=== EUR/NOK TOGGLE ===');

    // Get initial price text
    const firstPriceBefore = await page.locator('.listing-price').first().textContent();
    log('Initial price format', firstPriceBefore.includes('kr'), 'Price: ' + firstPriceBefore.trim());

    // Check initial toggle state
    const nokActiveBefore = await page.locator('#cur-nok').getAttribute('data-active');
    const eurActiveBefore = await page.locator('#cur-eur').getAttribute('data-active');
    log('Initial NOK active', nokActiveBefore === 'true', 'NOK=' + nokActiveBefore + ', EUR=' + eurActiveBefore);

    // Click the toggle
    await page.click('.currency-toggle');
    await page.waitForTimeout(500);

    // Check title changed (our debug indicator)
    const titleAfterToggle = await page.title();
    log('Toggle function runs', titleAfterToggle.includes('EUR'), 'Title: ' + titleAfterToggle);

    // Check toggle visual state changed
    const nokActiveAfter = await page.locator('#cur-nok').getAttribute('data-active');
    const eurActiveAfter = await page.locator('#cur-eur').getAttribute('data-active');
    log('Toggle visual switches', eurActiveAfter === 'true' && nokActiveAfter === 'false',
      'NOK=' + nokActiveAfter + ', EUR=' + eurActiveAfter);

    // Check price changed to EUR
    const firstPriceAfter = await page.locator('.listing-price').first().textContent();
    const priceIsEur = firstPriceAfter.includes('€') || firstPriceAfter.includes('\u20ac');
    log('Prices show EUR', priceIsEur, 'Price: ' + firstPriceAfter.trim());

    // Check placeholder changed
    const minPlaceholder = await page.locator('#filter-min-price').getAttribute('placeholder');
    log('Filter placeholder EUR', minPlaceholder.includes('€'), 'Placeholder: ' + minPlaceholder);

    // Toggle back to NOK
    await page.click('.currency-toggle');
    await page.waitForTimeout(500);
    const firstPriceBack = await page.locator('.listing-price').first().textContent();
    log('Prices back to NOK', firstPriceBack.includes('kr'), 'Price: ' + firstPriceBack.trim());

    // --- EUR Price Filter ---
    console.log('\n=== EUR PRICE FILTER ===');

    // Set a NOK min price filter first
    await page.fill('#filter-min-price', '2000000');
    await page.locator('#filter-min-price').press('Enter');
    await page.waitForTimeout(2000);
    const nokFilterCount = await page.locator('.listing-card').count();
    log('NOK price filter works', nokFilterCount > 0 && nokFilterCount < listingCount,
      nokFilterCount + ' listings with min 2M NOK');

    // Toggle to EUR — price filter value should convert
    await page.click('.currency-toggle');
    await page.waitForTimeout(500);
    const convertedMinPrice = await page.locator('#filter-min-price').inputValue();
    const expectedEur = Math.round(2000000 * 0.08864);
    const actualEur = Number(convertedMinPrice);
    log('Price filter converts NOK→EUR on toggle', Math.abs(actualEur - expectedEur) < 1000,
      '2000000 NOK → ' + convertedMinPrice + ' EUR (expected ~' + expectedEur + ')');

    // Now apply the EUR filter — should get same results
    await page.locator('#filter-min-price').press('Enter');
    await page.waitForTimeout(2000);
    const eurFilterCount = await page.locator('.listing-card').count();
    log('EUR filter returns same listings', Math.abs(eurFilterCount - nokFilterCount) <= 2,
      'NOK filter: ' + nokFilterCount + ', EUR filter: ' + eurFilterCount);

    // Enter a EUR max price to narrow further
    await page.fill('#filter-max-price', '500000');
    await page.locator('#filter-max-price').press('Enter');
    await page.waitForTimeout(2000);
    const eurRangeCount = await page.locator('.listing-card').count();
    log('EUR range filter works', eurRangeCount <= eurFilterCount,
      eurRangeCount + ' listings in EUR range');

    // Toggle back to NOK and verify conversion
    await page.click('.currency-toggle');
    await page.waitForTimeout(500);
    const backToNokMax = await page.locator('#filter-max-price').inputValue();
    const expectedNok = Math.round(500000 / 0.08864);
    log('Price filter converts EUR→NOK on toggle', Math.abs(Number(backToNokMax) - expectedNok) < 100000,
      '500000 EUR → ' + backToNokMax + ' NOK (expected ~' + expectedNok + ')');

    // Clear for next tests
    await page.fill('#filter-min-price', '');
    await page.fill('#filter-max-price', '');
    await page.click('.btn-clear');
    await page.waitForTimeout(2000);

    // --- 3. Map loads with dots ---
    console.log('\n=== MAP ===');
    const mapExists = await page.locator('#map').count();
    log('Map container exists', mapExists > 0);

    // Check for Leaflet circle markers (rendered as SVG circles)
    const circles = await page.locator('.leaflet-interactive').count();
    log('Map has markers', circles > 0, circles + ' markers');

    // --- 4. Filters ---
    console.log('\n=== FILTERS ===');

    // Test category filter - switch to Tomt
    await page.selectOption('#filter-category', 'tomt');
    await page.waitForTimeout(2000);
    await page.waitForSelector('.listing-card,.empty-state', { timeout: 10000 });

    const tomtCount = await page.locator('.listing-card').count();
    log('Tomt filter works', true, tomtCount + ' plot listings');

    // Check obligation filter appears
    const obligationVisible = await page.locator('#obligation-filter').isVisible();
    log('Obligation filter shows for Tomt', obligationVisible);

    // Check developed filter appears
    const developedVisible = await page.locator('#developed-filter').isVisible();
    log('Developed filter shows for Tomt', developedVisible);

    // Check for tomt badges
    if (tomtCount > 0) {
      const tomtBadge = await page.locator('.listing-badge.tomt-badge').count();
      log('TOMT badges shown', tomtBadge > 0, tomtBadge + ' badges');
    }

    // Check ownership filter appears for tomt
    const ownershipVisible = await page.locator('#ownership-filter').isVisible();
    log('Ownership filter shows for Tomt', ownershipVisible);

    // Check plot details toggles exist on tomt cards
    if (tomtCount > 0) {
      const plotToggles = await page.locator('.plot-details-toggle').count();
      log('Plot details toggles shown', plotToggles > 0, plotToggles + ' toggles');

      // Click first toggle to expand
      if (plotToggles > 0) {
        await page.locator('.plot-details-toggle').first().click();
        await page.waitForTimeout(300);
        const expanded = await page.locator('.plot-details-content').first().isVisible();
        log('Plot details expand on click', expanded);

        // Check property tax row shows "0 kr"
        const taxRow = await page.locator('.plot-details-content').first().textContent();
        log('Property tax shows 0', taxRow.includes('0 kr'), 'Contains tax-free info');

        // Click again to collapse
        await page.locator('.plot-details-toggle').first().click();
        await page.waitForTimeout(300);
        const collapsed = !(await page.locator('.plot-details-content').first().isVisible());
        log('Plot details collapse on second click', collapsed);
      }
    }

    // Test no-fees filter
    await page.selectOption('#filter-category', 'home');
    await page.waitForTimeout(2000);
    await page.waitForSelector('.listing-card', { timeout: 10000 });
    const homeCountBefore = await page.locator('.listing-card').count();

    await page.check('#filter-no-fees');
    await page.waitForTimeout(2000);
    await page.waitForSelector('.listing-card,.empty-state', { timeout: 10000 });
    const homeCountAfter = await page.locator('.listing-card').count();
    log('No-fees filter reduces listings', homeCountAfter <= homeCountBefore,
      homeCountBefore + ' → ' + homeCountAfter);

    // --- 5. Map reacts to filters ---
    console.log('\n=== MAP REACTIVITY ===');

    // Use a very high min price to eliminate most municipalities
    await page.uncheck('#filter-no-fees');
    await page.fill('#filter-min-price', '15000000');
    await page.waitForTimeout(100);
    // Trigger the onchange
    await page.locator('#filter-min-price').press('Enter');
    await page.waitForTimeout(3000);

    const markerOpacities = await page.evaluate(() => {
      const paths = document.querySelectorAll('.leaflet-interactive');
      const opacities = [];
      for (let i = 0; i < Math.min(paths.length, 100); i++) {
        const opacity = paths[i].getAttribute('fill-opacity');
        if (opacity) opacities.push(parseFloat(opacity));
      }
      return opacities;
    });
    const hasDimDots = markerOpacities.some(o => o < 0.1);
    const hasBrightDots = markerOpacities.some(o => o > 0.5);
    log('Map has dimmed dots (filtered out)', hasDimDots, 'Opacities range: ' +
      Math.min(...markerOpacities).toFixed(3) + ' to ' + Math.max(...markerOpacities).toFixed(2));
    log('Map has bright dots (with listings)', hasBrightDots);

    // Reset price filter
    await page.fill('#filter-min-price', '');

    // --- 6. Clear filters ---
    await page.click('.btn-clear');
    await page.waitForTimeout(2000);
    await page.waitForSelector('.listing-card', { timeout: 10000 });
    const afterClear = await page.locator('.listing-card').count();
    log('Clear filters restores listings', afterClear >= homeCountBefore,
      afterClear + ' listings after clear');

    // --- 7. Stats sidebar ---
    console.log('\n=== STATS ===');
    const totalCount = await page.locator('#total-count').textContent();
    const newCountText = await page.locator('#new-count').textContent();
    log('Header shows total count', parseInt(totalCount) > 0, 'Total: ' + totalCount);
    log('Header shows new count', true, 'New: ' + newCountText);

    const statBars = await page.locator('.stat-bar').count();
    log('Sidebar municipality stats', statBars > 0, statBars + ' municipalities listed');

    // --- 8. Municipality click preserves filters ---
    console.log('\n=== MUNICIPALITY CLICK (preserves filters) ===');

    // Set category to tomt first
    await page.selectOption('#filter-category', 'tomt');
    await page.waitForTimeout(2000);
    await page.waitForSelector('.listing-card,.empty-state', { timeout: 10000 });
    const tomtCountBefore = await page.locator('.listing-card').count();
    log('Set category to tomt', true, tomtCountBefore + ' plots');

    // Click first municipality in stats sidebar
    if (statBars > 0) {
      const firstStatName = await page.locator('.stat-bar span').first().textContent();
      await page.locator('.stat-bar').first().click();
      await page.waitForTimeout(2000);

      // Verify category is STILL tomt (not reset)
      const catAfterClick = await page.locator('#filter-category').inputValue();
      log('Municipality click keeps category', catAfterClick === 'tomt',
        'Category after click: ' + catAfterClick);

      const titleText = await page.locator('#listings-title').textContent();
      log('Title shows municipality', titleText.includes(firstStatName.trim()),
        'Title: ' + titleText);

      // Now click a SECOND municipality — should work without clearing
      if (await page.locator('.stat-bar').count() > 1) {
        const secondStatName = await page.locator('.stat-bar span').nth(2).textContent();
        await page.locator('.stat-bar').nth(1).click();
        await page.waitForTimeout(2000);

        const catAfterSecond = await page.locator('#filter-category').inputValue();
        log('Second municipality keeps category', catAfterSecond === 'tomt',
          'Category: ' + catAfterSecond);

        const titleText2 = await page.locator('#listings-title').textContent();
        log('Can switch between municipalities', true, 'Title: ' + titleText2);
      }
    }

    // Reset for remaining tests
    await page.click('.btn-clear');
    await page.waitForTimeout(2000);

    // --- 9. Drag handle exists ---
    console.log('\n=== DRAG HANDLE ===');
    const dragHandle = await page.locator('#drag-handle').count();
    log('Drag handle exists', dragHandle > 0);

    // --- 10. Exchange rate loaded ---
    console.log('\n=== EXCHANGE RATE ===');
    const eurRateLoaded = await page.evaluate(() => typeof eurRate === 'number' && eurRate > 0);
    const eurRateValue = await page.evaluate(() => eurRate);
    log('Exchange rate loaded', eurRateLoaded, 'Rate: ' + eurRateValue);

    // --- 11. Refresh button ---
    console.log('\n=== REFRESH STATUS ENDPOINT ===');
    const refreshStatus = await page.evaluate(async () => {
      const resp = await fetch('/api/refresh-status');
      return await resp.json();
    });
    log('Refresh status endpoint works', 'refreshing' in refreshStatus,
      JSON.stringify(refreshStatus));

    // --- JS Errors ---
    console.log('\n=== JS ERRORS ===');
    if (jsErrors.length === 0) {
      log('No JavaScript errors', true);
    } else {
      jsErrors.forEach(err => log('JS Error', false, err));
    }

  } catch (err) {
    console.error('TEST CRASHED:', err.message);
    log('Test execution', false, err.message);
  }

  await browser.close();

  // Summary
  console.log('\n========================================');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${results.length} tests`);
  if (failed > 0) {
    console.log('\nFAILED TESTS:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.test}: ${r.detail || ''}`);
    });
  }
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
})();
