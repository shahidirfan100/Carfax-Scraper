// Carfax Used Cars Scraper - Production Ready with Anti-Bot Bypass
// Strategy: CheerioCrawler with got-scraping (fingerprint rotation) -> Playwright fallback
import { Actor, log } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, Dataset } from 'crawlee';
import { firefox } from 'playwright';

await Actor.init();

// User agents pool for rotation
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

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
            use_browser = false, // Force browser mode if needed
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

        log.info(`Starting scraper with URLs: ${initial.join(', ')}`);

        // Configure proxy - only use if explicitly provided with residential
        let proxyConf = undefined;
        if (proxyConfiguration && proxyConfiguration.useApifyProxy) {
            try {
                proxyConf = await Actor.createProxyConfiguration(proxyConfiguration);
                log.info('Proxy configuration created');
            } catch (e) {
                log.warning(`Proxy setup failed: ${e.message}. Running without proxy.`);
            }
        }

        let saved = 0;

        // Normalize vehicle data
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
            };
        }

        // Extract MobX state from HTML (server-rendered)
        function extractMobxFromHtml(html) {
            // Look for __MOBX_STATE__ in script tags
            const mobxMatch = html.match(/window\.__MOBX_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/);
            if (mobxMatch) {
                try {
                    const state = JSON.parse(mobxMatch[1]);
                    const listings = state?.SearchRequestStore?.results?.listings ||
                        state?.SearchRequestStore?.searchResults?.listings || [];
                    return listings.map(normalizeVehicle);
                } catch (e) {
                    log.debug('Failed to parse MobX state from HTML');
                }
            }
            return [];
        }

        // Extract from JSON-LD
        function extractJsonLd($) {
            const vehicles = [];
            $('script[type="application/ld+json"]').each((_, script) => {
                try {
                    const data = JSON.parse($(script).html());
                    const items = data['@graph'] || [data];
                    for (const item of items) {
                        if (item['@type'] === 'Vehicle' || item['@type'] === 'Car') {
                            vehicles.push({
                                title: item.name || null,
                                price: item.offers?.price || null,
                                mileage: item.mileageFromOdometer || null,
                                vin: item.vehicleIdentificationNumber || null,
                                url: item.url || null,
                                currency: item.offers?.priceCurrency || 'USD',
                            });
                        }
                    }
                } catch (e) { }
            });
            return vehicles;
        }

        // Extract from DOM
        function extractFromDom($) {
            const vehicles = [];
            $('.srp-grid-list-item, div[id^="listing_"]').each((_, card) => {
                const $card = $(card);
                const title = $card.find('h3.srp-list-item-basic-info-model, h3').first().text().trim();
                const url = $card.find('.srp-list-item__header a, header a').first().attr('href');
                const priceText = $card.find('.srp-list-item__price, [class*="price"]').first().text().trim();
                const infoText = $card.find('span.srp-grid-list-item__mileage-address').first().text().trim();

                const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) : null;
                const [mileageStr] = infoText.split('|').map(s => s?.trim() || '');
                const mileage = mileageStr ? parseInt(mileageStr.replace(/[^0-9]/g, ''), 10) : null;

                if (title) {
                    vehicles.push({ title, url, price, mileage, currency: 'USD' });
                }
            });
            return vehicles;
        }

        // ============================================
        // APPROACH 1: Try CheerioCrawler first (fast, cheap)
        // ============================================
        log.info('Attempting CheerioCrawler with fingerprint rotation...');

        let cheerioSuccess = false;

        const cheerioCrawler = new CheerioCrawler({
            // Use got-scraping with browser-like fingerprints
            useSessionPool: true,
            persistCookiesPerSession: true,
            sessionPoolOptions: {
                maxPoolSize: 10,
            },
            // No proxy for Cheerio - datacenter IPs get blocked
            maxConcurrency: 1,
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 60,

            // Add browser-like headers
            preNavigationHooks: [
                async ({ request }) => {
                    request.headers = {
                        ...request.headers,
                        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Cache-Control': 'no-cache',
                        'Pragma': 'no-cache',
                        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                        'Sec-Ch-Ua-Mobile': '?0',
                        'Sec-Ch-Ua-Platform': '"Windows"',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'none',
                        'Sec-Fetch-User': '?1',
                        'Upgrade-Insecure-Requests': '1',
                    };
                },
            ],

            async requestHandler({ $, request, body }) {
                log.info(`CheerioCrawler processing: ${request.url}`);

                const html = body.toString();
                let vehicles = [];
                let source = 'unknown';

                // Check if we got blocked (DataDome/Captcha page)
                if (html.includes('datadome') || html.includes('captcha') ||
                    html.includes('Access Denied') || html.length < 5000) {
                    log.warning('CheerioCrawler: Got blocked or captcha page');
                    throw new Error('Blocked by anti-bot');
                }

                // Try MobX extraction from server-rendered HTML
                vehicles = extractMobxFromHtml(html);
                if (vehicles.length > 0) {
                    source = 'MobX-SSR';
                    log.info(`Extracted ${vehicles.length} vehicles from server-rendered MobX`);
                }

                // Try JSON-LD
                if (vehicles.length === 0) {
                    vehicles = extractJsonLd($);
                    if (vehicles.length > 0) {
                        source = 'JSON-LD';
                        log.info(`Extracted ${vehicles.length} vehicles from JSON-LD`);
                    }
                }

                // Try DOM parsing
                if (vehicles.length === 0) {
                    vehicles = extractFromDom($);
                    if (vehicles.length > 0) {
                        source = 'DOM';
                        log.info(`Extracted ${vehicles.length} vehicles from DOM`);
                    }
                }

                if (vehicles.length === 0) {
                    log.warning('CheerioCrawler: No vehicles found, will try Playwright');
                    throw new Error('No vehicles found');
                }

                cheerioSuccess = true;

                // Save vehicles
                const remaining = RESULTS_WANTED - saved;
                const toSave = vehicles.slice(0, Math.max(0, remaining));

                for (const vehicle of toSave) {
                    await Dataset.pushData({
                        ...vehicle,
                        scraped_at: new Date().toISOString(),
                        source: 'carfax.com',
                        extraction_method: source,
                    });
                    saved++;
                    if (saved >= RESULTS_WANTED) break;
                }

                log.info(`CheerioCrawler: Saved ${saved}/${RESULTS_WANTED} vehicles`);
            },

            async failedRequestHandler({ request }, error) {
                log.warning(`CheerioCrawler failed: ${error.message}`);
            },
        });

        try {
            await cheerioCrawler.run(initial.map(u => ({ url: u, userData: { pageNo: 1 } })));
        } catch (e) {
            log.warning(`CheerioCrawler error: ${e.message}`);
        }

        // ============================================
        // APPROACH 2: Playwright fallback (if needed)
        // ============================================
        if (saved < RESULTS_WANTED && (!cheerioSuccess || use_browser)) {
            log.info('Falling back to PlaywrightCrawler...');

            const playwrightCrawler = new PlaywrightCrawler({
                launchContext: {
                    launcher: firefox,
                    launchOptions: {
                        headless: true,
                        args: ['--disable-blink-features=AutomationControlled'],
                    },
                },
                // Only use proxy if configured (residential recommended)
                ...(proxyConf && { proxyConfiguration: proxyConf }),
                maxConcurrency: 1,
                maxRequestRetries: 3,
                navigationTimeoutSecs: 90,
                requestHandlerTimeoutSecs: 120,
                useSessionPool: true,

                preNavigationHooks: [
                    async ({ page }) => {
                        // Anti-detection
                        await page.addInitScript(() => {
                            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                            Object.defineProperty(navigator, 'plugins', {
                                get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Native Client' }],
                            });
                            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                            window.chrome = { runtime: {} };
                        });

                        // Block trackers
                        await page.route('**/*', (route) => {
                            const url = route.request().url();
                            if (url.includes('google-analytics') || url.includes('googletagmanager') ||
                                url.includes('facebook.net') || url.includes('doubleclick')) {
                                return route.abort();
                            }
                            return route.continue();
                        });
                    },
                ],

                async requestHandler({ page, request }) {
                    log.info(`PlaywrightCrawler processing: ${request.url}`);

                    // Wait for page load
                    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => { });
                    await page.waitForTimeout(3000);

                    let vehicles = [];
                    let source = 'unknown';

                    // Try MobX extraction
                    try {
                        vehicles = await page.evaluate(() => {
                            const state = window.__MOBX_STATE__;
                            if (!state) return [];
                            const listings = state.SearchRequestStore?.results?.listings || [];
                            return listings;
                        });

                        if (vehicles.length > 0) {
                            source = 'MobX';
                            vehicles = vehicles.map(normalizeVehicle);
                            log.info(`Extracted ${vehicles.length} vehicles from MobX`);
                        }
                    } catch (e) {
                        log.debug('MobX extraction failed');
                    }

                    // DOM fallback
                    if (vehicles.length === 0) {
                        vehicles = await page.evaluate(() => {
                            return Array.from(document.querySelectorAll('.srp-grid-list-item, div[id^="listing_"]'))
                                .map(card => ({
                                    title: card.querySelector('h3')?.textContent?.trim() || null,
                                    url: card.querySelector('header a')?.href || null,
                                    price: parseInt(card.querySelector('[class*="price"]')?.textContent?.replace(/[^0-9]/g, '') || '0', 10) || null,
                                }))
                                .filter(v => v.title);
                        });
                        if (vehicles.length > 0) {
                            source = 'DOM';
                            log.info(`Extracted ${vehicles.length} vehicles from DOM`);
                        }
                    }

                    if (vehicles.length === 0) {
                        // Debug screenshot
                        const kvStore = await Actor.openKeyValueStore();
                        const screenshot = await page.screenshot({ fullPage: true });
                        await kvStore.setValue(`debug-${Date.now()}`, screenshot, { contentType: 'image/png' });
                        log.warning('No vehicles found, debug screenshot saved');
                        return;
                    }

                    // Save vehicles
                    const remaining = RESULTS_WANTED - saved;
                    const toSave = vehicles.slice(0, Math.max(0, remaining));

                    for (const vehicle of toSave) {
                        await Dataset.pushData({
                            ...vehicle,
                            currency: 'USD',
                            scraped_at: new Date().toISOString(),
                            source: 'carfax.com',
                            extraction_method: source,
                        });
                        saved++;
                        if (saved >= RESULTS_WANTED) break;
                    }

                    log.info(`PlaywrightCrawler: Saved ${saved}/${RESULTS_WANTED} vehicles`);

                    // Handle pagination
                    while (saved < RESULTS_WANTED) {
                        const hasNext = await page.evaluate(() => {
                            const btn = document.querySelector('button.pagination_pages_nav:not([disabled])');
                            return btn?.textContent?.includes('Next');
                        });

                        if (!hasNext) break;

                        await page.click('button.pagination_pages_nav:last-of-type');
                        await page.waitForTimeout(3000);
                        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

                        const nextVehicles = await page.evaluate(() => {
                            const state = window.__MOBX_STATE__;
                            return state?.SearchRequestStore?.results?.listings || [];
                        });

                        if (nextVehicles.length === 0) break;

                        const remaining = RESULTS_WANTED - saved;
                        const toSave = nextVehicles.slice(0, remaining).map(normalizeVehicle);

                        for (const vehicle of toSave) {
                            await Dataset.pushData({
                                ...vehicle,
                                scraped_at: new Date().toISOString(),
                                source: 'carfax.com',
                                extraction_method: 'MobX',
                            });
                            saved++;
                            if (saved >= RESULTS_WANTED) break;
                        }

                        log.info(`Pagination: Saved ${saved}/${RESULTS_WANTED} vehicles`);
                    }
                },

                async failedRequestHandler({ request }, error) {
                    log.error(`PlaywrightCrawler failed: ${request.url}`, { error: error.message });
                },
            });

            await playwrightCrawler.run(initial.map(u => ({ url: u, userData: { pageNo: 1 } })));
        }

        log.info(`Finished. Total saved: ${saved} vehicles`);

    } finally {
        await Actor.exit();
    }
}

main().catch(err => {
    console.error('Actor failed:', err);
    process.exit(1);
});
