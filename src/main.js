// Carfax Used Cars Scraper - Production Ready
// Primary: MobX state extraction | Fallback: API interception | Last resort: DOM parsing
import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
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
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 50;

        // Build start URL from parameters if not provided
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

        // Configure proxy with fallback - fix for NS_ERROR_PROXY_CONNECTION_REFUSED
        let proxyConf = undefined;
        if (proxyConfiguration) {
            try {
                proxyConf = await Actor.createProxyConfiguration(proxyConfiguration);
                log.info('Proxy configuration created successfully');
            } catch (e) {
                log.warning(`Proxy configuration failed: ${e.message}. Running without proxy.`);
                proxyConf = undefined;
            }
        }

        let saved = 0;
        let interceptedApiData = [];

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
                distance_to_dealer: item.distanceToDealer || null,
                image_url: item.primaryImageUrl || item.imageUrl || item.images?.[0] || null,
                url: item.vehicleUrl || item.url || item.detailPageUrl || null,
                stock_number: item.stockNumber || null,
                dealer_name: item.dealerName || item.seller?.name || null,
            };
        }

        // Extract from API response
        function extractFromApiResponse(data) {
            const vehicles = [];
            try {
                const listings = data?.listings || data?.searchResults?.listings || data?.vehicles || data?.results || [];
                for (const item of listings) {
                    vehicles.push(normalizeVehicle(item));
                }
            } catch (e) {
                log.debug('Failed to parse API response', { error: e.message });
            }
            return vehicles;
        }

        const crawler = new PlaywrightCrawler({
            launchContext: {
                launcher: firefox,
                launchOptions: {
                    headless: true,
                },
            },
            // Only use proxy if configured successfully
            ...(proxyConf && { proxyConfiguration: proxyConf }),
            maxConcurrency: 2,
            maxRequestRetries: 3,
            navigationTimeoutSecs: 60,
            requestHandlerTimeoutSecs: 90,
            useSessionPool: true,

            preNavigationHooks: [
                async ({ page }) => {
                    // Reset intercepted data for each request
                    interceptedApiData = [];

                    // Intercept API responses
                    page.on('response', async (response) => {
                        const url = response.url();
                        if (url.includes('/api/ubs/search') || url.includes('/api/') && url.includes('search')) {
                            try {
                                const contentType = response.headers()['content-type'] || '';
                                if (contentType.includes('application/json')) {
                                    const data = await response.json();
                                    const vehicles = extractFromApiResponse(data);
                                    if (vehicles.length > 0) {
                                        log.info(`Intercepted ${vehicles.length} vehicles from API`);
                                        interceptedApiData.push(...vehicles);
                                    }
                                }
                            } catch (e) {
                                // Ignore response parsing errors
                            }
                        }
                    });

                    // Block only heavy resources, keep essential ones
                    await page.route('**/*', (route) => {
                        const type = route.request().resourceType();
                        const url = route.request().url();

                        // Block analytics and ads
                        if (url.includes('google-analytics') ||
                            url.includes('googletagmanager') ||
                            url.includes('facebook.net') ||
                            url.includes('doubleclick') ||
                            url.includes('hotjar')) {
                            return route.abort();
                        }

                        // Block fonts and media
                        if (['media', 'font'].includes(type)) {
                            return route.abort();
                        }

                        return route.continue();
                    });
                },
            ],

            requestHandler: async ({ page, request }) => {
                const pageNo = request.userData?.pageNo || 1;
                log.info(`Processing page ${pageNo}: ${request.url}`);

                // Wait for page to fully load
                await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });

                // Small delay to ensure MobX state is populated
                await page.waitForTimeout(2000);

                let vehicles = [];
                let source = 'unknown';

                // PRIORITY 1: Extract from MobX state (fastest & most reliable)
                try {
                    vehicles = await page.evaluate(() => {
                        const mobxState = window.__MOBX_STATE__;
                        if (!mobxState) return [];

                        // Try SearchRequestStore first
                        const searchStore = mobxState.SearchRequestStore;
                        if (searchStore?.results?.listings) {
                            return searchStore.results.listings;
                        }

                        // Alternative paths
                        if (searchStore?.searchResults?.listings) {
                            return searchStore.searchResults.listings;
                        }

                        // Search all stores for listings
                        for (const key of Object.keys(mobxState)) {
                            const store = mobxState[key];
                            if (store?.results?.listings) return store.results.listings;
                            if (store?.listings) return store.listings;
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

                // PRIORITY 2: Use intercepted API data
                if (vehicles.length === 0 && interceptedApiData.length > 0) {
                    vehicles = interceptedApiData;
                    source = 'API';
                    log.info(`Using ${vehicles.length} vehicles from intercepted API`);
                }

                // PRIORITY 3: Extract from JSON-LD (structured data)
                if (vehicles.length === 0) {
                    try {
                        vehicles = await page.evaluate(() => {
                            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                            const results = [];

                            for (const script of scripts) {
                                try {
                                    const data = JSON.parse(script.textContent);
                                    const items = data['@graph'] || [data];

                                    for (const item of items) {
                                        if (item['@type'] === 'Vehicle' || item['@type'] === 'Car') {
                                            results.push({
                                                title: item.name || null,
                                                price: item.offers?.price || null,
                                                mileage: item.mileageFromOdometer || null,
                                                vin: item.vehicleIdentificationNumber || null,
                                                url: item.url || null,
                                            });
                                        }
                                    }
                                } catch (e) { }
                            }
                            return results;
                        });

                        if (vehicles.length > 0) {
                            source = 'JSON-LD';
                            log.info(`Extracted ${vehicles.length} vehicles from JSON-LD`);
                        }
                    } catch (e) {
                        log.debug('JSON-LD extraction failed', { error: e.message });
                    }
                }

                // PRIORITY 4: DOM parsing (slowest, last resort)
                if (vehicles.length === 0) {
                    try {
                        vehicles = await page.evaluate(() => {
                            const cards = document.querySelectorAll('.srp-grid-list-item, div[id^="listing_"], [data-testid="listing-card"]');
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

                // No data found - debug
                if (vehicles.length === 0) {
                    log.warning('No vehicles found on page');

                    // Save debug screenshot to KV store
                    try {
                        const kvStore = await Actor.openKeyValueStore();
                        const screenshot = await page.screenshot({ fullPage: true });
                        await kvStore.setValue(`debug-page-${pageNo}-${Date.now()}`, screenshot, { contentType: 'image/png' });
                        log.info('Debug screenshot saved to key-value store');
                    } catch (e) { }

                    return;
                }

                log.info(`Found ${vehicles.length} vehicles (source: ${source})`);

                // Save vehicles up to results_wanted
                const remaining = RESULTS_WANTED - saved;
                const toSave = vehicles.slice(0, Math.max(0, remaining));

                for (const vehicle of toSave) {
                    await Dataset.pushData({
                        ...vehicle,
                        currency: vehicle.currency || 'USD',
                        scraped_at: new Date().toISOString(),
                        source: 'carfax.com',
                        extraction_method: source,
                    });
                    saved++;

                    if (saved >= RESULTS_WANTED) break;
                }

                log.info(`Saved ${saved}/${RESULTS_WANTED} vehicles`);

                // Handle pagination if more results needed
                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    const hasNextButton = await page.evaluate(() => {
                        const nextBtn = document.querySelector('button.pagination_pages_nav:not([disabled])');
                        return nextBtn && nextBtn.textContent.includes('Next');
                    });

                    if (hasNextButton) {
                        await page.click('button.pagination_pages_nav:last-of-type');
                        await page.waitForTimeout(2000);
                        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

                        // Process next page inline
                        let currentPage = pageNo + 1;

                        while (saved < RESULTS_WANTED && currentPage <= MAX_PAGES) {
                            await page.waitForTimeout(1500);

                            // Extract from next page
                            let nextVehicles = await page.evaluate(() => {
                                const mobxState = window.__MOBX_STATE__;
                                if (mobxState?.SearchRequestStore?.results?.listings) {
                                    return mobxState.SearchRequestStore.results.listings;
                                }
                                return [];
                            });

                            if (nextVehicles.length > 0) {
                                nextVehicles = nextVehicles.map(normalizeVehicle);
                            } else if (interceptedApiData.length > 0) {
                                nextVehicles = interceptedApiData;
                            }

                            if (nextVehicles.length === 0) {
                                log.info('No more vehicles found, stopping pagination');
                                break;
                            }

                            log.info(`Page ${currentPage}: Found ${nextVehicles.length} vehicles`);

                            const pageRemaining = RESULTS_WANTED - saved;
                            const pageToSave = nextVehicles.slice(0, Math.max(0, pageRemaining));

                            for (const vehicle of pageToSave) {
                                await Dataset.pushData({
                                    ...vehicle,
                                    currency: vehicle.currency || 'USD',
                                    scraped_at: new Date().toISOString(),
                                    source: 'carfax.com',
                                    extraction_method: source,
                                });
                                saved++;

                                if (saved >= RESULTS_WANTED) break;
                            }

                            log.info(`Saved ${saved}/${RESULTS_WANTED} vehicles`);

                            // Check for next page
                            const canContinue = await page.evaluate(() => {
                                const nextBtn = document.querySelector('button.pagination_pages_nav:not([disabled])');
                                return nextBtn && nextBtn.textContent.includes('Next');
                            });

                            if (!canContinue || saved >= RESULTS_WANTED) break;

                            await page.click('button.pagination_pages_nav:last-of-type');
                            await page.waitForTimeout(2000);
                            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
                            currentPage++;
                        }
                    }
                }
            },

            failedRequestHandler: async ({ request }, error) => {
                const errorMsg = error.message || '';

                if (errorMsg.includes('NS_ERROR_PROXY_CONNECTION_REFUSED')) {
                    log.error(`Proxy connection refused for ${request.url}. Try running without proxy or check proxy configuration.`);
                } else if (errorMsg.includes('403')) {
                    log.warning(`Blocked (403): ${request.url}`);
                } else {
                    log.error(`Failed: ${request.url}`, { error: errorMsg });
                }
            },
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} vehicles total.`);

    } finally {
        await Actor.exit();
    }
}

main().catch(err => {
    console.error('Actor failed:', err);
    process.exit(1);
});
