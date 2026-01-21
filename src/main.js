// Carfax Used Cars Scraper - Camoufox with US Geolocation
// Bypasses DataDome anti-bot using Camoufox + US residential proxies

import { PlaywrightCrawler } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';

await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            startUrl,
            startUrls,
            url,
            make,
            model,
            year_min,
            year_max,
            price_min,
            price_max,
            mileage_max,
            location,
            results_wanted: RESULTS_WANTED_RAW = 20,
            max_pages: MAX_PAGES_RAW = 50,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 50;

        // Build start URL from parameters
        const buildStartUrl = () => {
            const baseUrl = 'https://www.carfax.com/Used-';
            let path = 'Cars';

            if (make && model) {
                path = `${make}-${model}`.replace(/\s+/g, '-');
            } else if (make) {
                path = make.replace(/\s+/g, '-');
            }

            const params = new URLSearchParams();
            if (year_min) params.set('yearMin', year_min);
            if (year_max) params.set('yearMax', year_max);
            if (price_min) params.set('priceMin', price_min);
            if (price_max) params.set('priceMax', price_max);
            if (mileage_max) params.set('mileageMax', mileage_max);
            if (location) params.set('location', location);

            return params.toString() ? `${baseUrl}${path}?${params}` : `${baseUrl}${path}`;
        };

        // Prepare start URLs
        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl());

        log.info(`Starting Carfax scraper with URLs: ${initial.join(', ')}`);

        // Configure US-based residential proxy
        const proxyConfiguration = await Actor.createProxyConfiguration({
            groups: ['RESIDENTIAL'],
            countryCode: 'US',  // Force US-based proxy
        });

        let saved = 0;

        // Normalize vehicle data from MobX state
        function normalizeVehicle(item) {
            return {
                vin: item.vin || null,
                title: item.title || `${item.year || ''} ${item.make || ''} ${item.model || ''}`.trim() || null,
                year: item.year || null,
                make: item.make || null,
                model: item.model || null,
                trim: item.trim || null,
                price: item.listPrice || item.currentPrice || item.price || null,
                currency: 'USD',
                mileage: typeof item.mileage === 'object' ? item.mileage.value : item.mileage || null,
                mileage_label: typeof item.mileage === 'object' ? item.mileage.label : null,
                badge: item.badge || null,
                image_url: item.primaryImageUrl || item.imageUrl || null,
                url: item.vehicleUrl || item.url || null,
                dealer_name: item.dealerName || null,
                distance_to_dealer: item.distanceToDealer || null,
                stock_number: item.stockNumber || null,
            };
        }

        // Get Camoufox launch options with US proxy
        const proxyUrl = await proxyConfiguration.newUrl();
        log.info('Camoufox configured with US residential proxy');

        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            launchContext: {
                launcher: firefox,
                launchOptions: await camoufoxLaunchOptions({
                    headless: true,
                    proxy: proxyUrl,
                    geoip: true,
                }),
            },
            maxConcurrency: 1,
            maxRequestRetries: 3,
            navigationTimeoutSecs: 90,
            requestHandlerTimeoutSecs: 120,
            useSessionPool: true,

            preNavigationHooks: [
                async ({ page }) => {
                    // Set US locale
                    await page.setExtraHTTPHeaders({
                        'Accept-Language': 'en-US,en;q=0.9',
                    });

                    // Block trackers
                    await page.route('**/*', (route) => {
                        const url = route.request().url();
                        if (url.includes('google-analytics') ||
                            url.includes('googletagmanager') ||
                            url.includes('facebook.net') ||
                            url.includes('doubleclick')) {
                            return route.abort();
                        }
                        return route.continue();
                    });
                },
            ],

            async requestHandler({ page, request }) {
                const pageNo = request.userData?.pageNo || 1;
                log.info(`Processing page ${pageNo}: ${request.url}`);

                // Wait for page to load
                await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => { });
                await page.waitForTimeout(2000);

                // Handle cookie consent popup (European GDPR)
                try {
                    const acceptBtn = page.locator('button:has-text("Accept"), button:has-text("accept"), button:has-text("Continue"), [class*="accept"], [class*="consent"]').first();
                    if (await acceptBtn.isVisible({ timeout: 3000 })) {
                        await acceptBtn.click();
                        log.info('Clicked cookie consent button');
                        await page.waitForTimeout(1000);
                    }
                } catch (e) {
                    // No consent popup
                }

                // Check if we're on the right page (US Carfax with search results)
                const pageContent = await page.content();
                const currentUrl = page.url();

                // Detect if we got redirected to European site
                if (currentUrl.includes('carfax.eu') ||
                    pageContent.includes('La confiance') ||
                    pageContent.includes('carfax.eu')) {
                    log.warning('Redirected to European Carfax site, retrying with US proxy...');
                    throw new Error('Redirected to non-US site');
                }

                // Check if we got a homepage instead of search results
                if (!currentUrl.includes('Used-') && !pageContent.includes('srp-list-item')) {
                    log.warning(`Got homepage instead of search results: ${currentUrl}`);
                    // Save screenshot for debugging
                    const kvStore = await Actor.openKeyValueStore();
                    const screenshot = await page.screenshot({ fullPage: true });
                    await kvStore.setValue(`wrong-page-${Date.now()}`, screenshot, { contentType: 'image/png' });
                    throw new Error('Got homepage instead of search results');
                }

                await page.waitForTimeout(2000);

                let vehicles = [];
                let source = 'unknown';

                // PRIORITY 1: Extract from MobX state
                try {
                    vehicles = await page.evaluate(() => {
                        const state = window.__MOBX_STATE__;
                        if (!state) return [];

                        const searchStore = state.SearchRequestStore;
                        if (searchStore?.results?.listings) {
                            return searchStore.results.listings;
                        }
                        if (searchStore?.searchResults?.listings) {
                            return searchStore.searchResults.listings;
                        }

                        for (const key of Object.keys(state)) {
                            const store = state[key];
                            if (store?.results?.listings) return store.results.listings;
                        }

                        return [];
                    });

                    if (vehicles.length > 0) {
                        source = 'MobX';
                        vehicles = vehicles.map(normalizeVehicle);
                        log.info(`Extracted ${vehicles.length} vehicles from MobX state`);
                    }
                } catch (e) {
                    log.debug('MobX extraction failed', { error: e.message });
                }

                // PRIORITY 2: DOM parsing fallback
                if (vehicles.length === 0) {
                    try {
                        vehicles = await page.evaluate(() => {
                            const cards = document.querySelectorAll('.srp-grid-list-item, div[id^="listing_"]');
                            return Array.from(cards).map(card => {
                                const titleEl = card.querySelector('h3.srp-list-item-basic-info-model, h3');
                                const linkEl = card.querySelector('.srp-list-item__header a, header a');
                                const priceEl = card.querySelector('.srp-list-item__price, [class*="price"]');
                                const infoEl = card.querySelector('span.srp-grid-list-item__mileage-address');

                                const infoText = infoEl ? infoEl.textContent.trim() : '';
                                const [mileageStr] = infoText.split('|').map(s => s?.trim() || '');
                                const mileage = mileageStr ? parseInt(mileageStr.replace(/[^0-9]/g, ''), 10) : null;

                                const priceText = priceEl ? priceEl.textContent.trim() : '';
                                const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) : null;

                                return {
                                    title: titleEl ? titleEl.textContent.trim() : null,
                                    price,
                                    currency: 'USD',
                                    mileage,
                                    url: linkEl ? linkEl.href : null,
                                };
                            }).filter(v => v.title);
                        });

                        if (vehicles.length > 0) {
                            source = 'DOM';
                            log.info(`Extracted ${vehicles.length} vehicles from DOM`);
                        }
                    } catch (e) {
                        log.debug('DOM extraction failed', { error: e.message });
                    }
                }

                // No data found
                if (vehicles.length === 0) {
                    log.warning('No vehicles found on page');
                    const kvStore = await Actor.openKeyValueStore();
                    const screenshot = await page.screenshot({ fullPage: true });
                    await kvStore.setValue(`debug-page-${pageNo}-${Date.now()}`, screenshot, { contentType: 'image/png' });

                    if (pageContent.includes('datadome') || pageContent.includes('captcha')) {
                        log.error('Detected anti-bot blocking page');
                    }
                    return;
                }

                log.info(`Found ${vehicles.length} vehicles (source: ${source})`);

                // Save vehicles
                const remaining = RESULTS_WANTED - saved;
                const toSave = vehicles.slice(0, Math.max(0, remaining));

                for (const vehicle of toSave) {
                    await Actor.pushData({
                        ...vehicle,
                        scraped_at: new Date().toISOString(),
                        source: 'carfax.com',
                        extraction_method: source,
                    });
                    saved++;
                    if (saved >= RESULTS_WANTED) break;
                }

                log.info(`Saved ${saved}/${RESULTS_WANTED} vehicles`);

                // Handle pagination
                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    const hasNext = await page.evaluate(() => {
                        const btn = document.querySelector('button.pagination_pages_nav:not([disabled])');
                        return btn?.textContent?.includes('Next');
                    });

                    if (hasNext) {
                        await page.click('button.pagination_pages_nav:last-of-type');
                        await page.waitForTimeout(3000);
                        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => { });

                        let currentPage = pageNo + 1;

                        while (saved < RESULTS_WANTED && currentPage <= MAX_PAGES) {
                            await page.waitForTimeout(2000);

                            let nextVehicles = await page.evaluate(() => {
                                const state = window.__MOBX_STATE__;
                                return state?.SearchRequestStore?.results?.listings || [];
                            });

                            if (nextVehicles.length > 0) {
                                nextVehicles = nextVehicles.map(normalizeVehicle);
                                log.info(`Page ${currentPage}: Found ${nextVehicles.length} vehicles`);

                                const pageRemaining = RESULTS_WANTED - saved;
                                const pageToSave = nextVehicles.slice(0, pageRemaining);

                                for (const vehicle of pageToSave) {
                                    await Actor.pushData({
                                        ...vehicle,
                                        scraped_at: new Date().toISOString(),
                                        source: 'carfax.com',
                                        extraction_method: 'MobX',
                                    });
                                    saved++;
                                    if (saved >= RESULTS_WANTED) break;
                                }

                                log.info(`Saved ${saved}/${RESULTS_WANTED} vehicles`);
                            } else {
                                break;
                            }

                            const canContinue = await page.evaluate(() => {
                                const btn = document.querySelector('button.pagination_pages_nav:not([disabled])');
                                return btn?.textContent?.includes('Next');
                            });

                            if (!canContinue || saved >= RESULTS_WANTED) break;

                            await page.click('button.pagination_pages_nav:last-of-type');
                            await page.waitForTimeout(3000);
                            await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => { });
                            currentPage++;
                        }
                    }
                }
            },

            async failedRequestHandler({ request }, error) {
                log.error(`Request failed: ${request.url}`, { error: error.message });
            },
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { pageNo: 1 } })));
        log.info(`Finished. Total saved: ${saved} vehicles`);

    } finally {
        await Actor.exit();
    }
}

main().catch(err => {
    console.error('Actor failed:', err);
    process.exit(1);
});
