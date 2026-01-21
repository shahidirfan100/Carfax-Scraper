// Carfax Used Cars Scraper - PlaywrightCrawler implementation with Anti-Bot Stealth
import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { firefox } from 'playwright';

await Actor.init();

// User agent rotation for stealth
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0',
];
const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Random delay helper for human-like behavior
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

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

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        let currentPage = 1;

        // Store for intercepted API data
        let interceptedVehicles = [];

        // Extract vehicles from JSON-LD structured data
        function extractFromJsonLd(content) {
            const vehicles = [];
            const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
            let match;

            while ((match = jsonLdRegex.exec(content)) !== null) {
                try {
                    const data = JSON.parse(match[1]);
                    const items = data['@graph'] || [data];

                    for (const item of items) {
                        if (item['@type'] === 'Vehicle') {
                            vehicles.push({
                                title: item.name || null,
                                price: item.offers?.price || null,
                                currency: item.offers?.priceCurrency || 'USD',
                                mileage: item.mileageFromOdometer || null,
                                vin: item.vehicleIdentificationNumber || null,
                                image_url: item.image || null,
                                drive_type: item.driveWheelConfiguration || null,
                                engine: item.vehicleEngine || null,
                                transmission: item.vehicleTransmission || null,
                                damage_report: item.knownVehicleDamages || null,
                                url: item.url || null,
                            });
                        }
                    }
                } catch (e) {
                    // Ignore parsing errors
                }
            }
            return vehicles;
        }

        // Extract vehicles from intercepted API response
        function extractFromApiResponse(data) {
            const vehicles = [];
            try {
                const listings = data?.listings || data?.searchResults || data?.vehicles || [];
                for (const item of listings) {
                    vehicles.push({
                        title: item.title || item.name || `${item.year} ${item.make} ${item.model}` || null,
                        price: item.price || item.listPrice || item.askingPrice || null,
                        currency: 'USD',
                        mileage: item.mileage || item.odometer || null,
                        vin: item.vin || null,
                        image_url: item.imageUrl || item.primaryImage || item.images?.[0] || null,
                        drive_type: item.driveType || item.drivetrain || null,
                        engine: item.engine || item.engineDescription || null,
                        transmission: item.transmission || null,
                        location: item.location || item.dealerCity || null,
                        dealer_name: item.dealerName || item.seller?.name || null,
                        url: item.url || item.detailPageUrl || null,
                    });
                }
            } catch (e) {
                log.warning('Failed to parse API response', { error: e.message });
            }
            return vehicles;
        }

        // Human-like mouse movement simulation
        async function simulateHumanBehavior(page) {
            try {
                // Random mouse movements
                const viewport = page.viewportSize() || { width: 1920, height: 1080 };
                for (let i = 0; i < 3; i++) {
                    const x = randomDelay(100, viewport.width - 100);
                    const y = randomDelay(100, viewport.height - 100);
                    await page.mouse.move(x, y, { steps: randomDelay(5, 15) });
                    await page.waitForTimeout(randomDelay(100, 300));
                }

                // Gradual scroll down
                const scrollSteps = randomDelay(3, 6);
                for (let i = 0; i < scrollSteps; i++) {
                    await page.evaluate((step) => {
                        window.scrollBy(0, window.innerHeight * 0.3);
                    }, i);
                    await page.waitForTimeout(randomDelay(300, 600));
                }

                // Brief pause like a human reading
                await page.waitForTimeout(randomDelay(1000, 2000));
            } catch (e) {
                log.debug('Human behavior simulation failed', { error: e.message });
            }
        }

        const crawler = new PlaywrightCrawler({
            launchContext: {
                launcher: firefox,
                launchOptions: {
                    headless: true,
                    args: [
                        '--disable-blink-features=AutomationControlled',
                    ],
                },
                userAgent: getRandomUserAgent(),
            },
            proxyConfiguration: proxyConf,
            maxConcurrency: 2,  // Reduced for stealth
            maxRequestRetries: 3,
            navigationTimeoutSecs: 90,  // Increased from 60
            requestHandlerTimeoutSecs: 120,  // Increased from 90
            useSessionPool: true,

            // Enhanced stealth and API interception in preNavigationHooks
            preNavigationHooks: [
                async ({ page }) => {
                    // Reset intercepted data
                    interceptedVehicles = [];

                    // API Interception - Monitor for search API responses
                    page.on('response', async (response) => {
                        const url = response.url();
                        if (url.includes('/api/') && (url.includes('search') || url.includes('listings') || url.includes('vehicles'))) {
                            try {
                                const contentType = response.headers()['content-type'] || '';
                                if (contentType.includes('application/json')) {
                                    const data = await response.json();
                                    const vehicles = extractFromApiResponse(data);
                                    if (vehicles.length > 0) {
                                        log.info(`Intercepted ${vehicles.length} vehicles from API: ${url}`);
                                        interceptedVehicles.push(...vehicles);
                                    }
                                }
                            } catch (e) {
                                // Silently ignore response parsing errors
                            }
                        }
                    });

                    // Inject anti-detection scripts BEFORE page loads
                    await page.addInitScript(() => {
                        // Remove webdriver property
                        Object.defineProperty(navigator, 'webdriver', {
                            get: () => undefined,
                        });

                        // Override plugins to look like a real browser
                        Object.defineProperty(navigator, 'plugins', {
                            get: () => [
                                { name: 'Chrome PDF Plugin' },
                                { name: 'Chrome PDF Viewer' },
                                { name: 'Native Client' },
                            ],
                        });

                        // Override languages
                        Object.defineProperty(navigator, 'languages', {
                            get: () => ['en-US', 'en'],
                        });

                        // Add realistic screen properties
                        Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
                        Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
                        Object.defineProperty(screen, 'width', { get: () => 1920 });
                        Object.defineProperty(screen, 'height', { get: () => 1080 });
                        Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
                        Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

                        // Override permissions API
                        const originalQuery = window.navigator.permissions?.query;
                        if (originalQuery) {
                            window.navigator.permissions.query = (parameters) => (
                                parameters.name === 'notifications' ?
                                    Promise.resolve({ state: Notification.permission }) :
                                    originalQuery(parameters)
                            );
                        }

                        // Mock chrome runtime for some detection scripts
                        window.chrome = {
                            runtime: {},
                        };
                    });

                    // Block trackers but keep essential resources
                    await page.route('**/*', (route) => {
                        const type = route.request().resourceType();
                        const url = route.request().url();

                        // Block only tracking/analytics - keep images for stealth (blocked images look suspicious)
                        if (url.includes('google-analytics') ||
                            url.includes('googletagmanager') ||
                            url.includes('facebook.net') ||
                            url.includes('doubleclick') ||
                            url.includes('adsense') ||
                            url.includes('hotjar') ||
                            url.includes('segment.io')) {
                            return route.abort();
                        }

                        // Block large media files but not images
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

                // Add random initial delay for human-like behavior
                await page.waitForTimeout(randomDelay(2000, 4000));

                // Simulate human behavior before extraction
                await simulateHumanBehavior(page);

                // Wait for listings to load with increased timeout
                let listingsFound = false;
                try {
                    await page.waitForSelector('header.srp-list-item__header', { timeout: 30000 });
                    listingsFound = true;
                } catch {
                    // Try alternative selectors
                    try {
                        await page.waitForSelector('[data-testid="listing-card"], .srp-grid-list-item, div[id^="listing_"]', { timeout: 15000 });
                        listingsFound = true;
                    } catch {
                        log.warning(`Listings not found with DOM selectors on ${request.url}`);
                    }
                }

                // If no DOM listings found, check if we have intercepted API data
                if (!listingsFound && interceptedVehicles.length === 0) {
                    // Debug: Save screenshot and page content for debugging
                    log.warning('No listings found via DOM or API interception');

                    try {
                        const kvStore = await Actor.openKeyValueStore();
                        const screenshot = await page.screenshot({ fullPage: true });
                        await kvStore.setValue(`debug-screenshot-page-${pageNo}`, screenshot, { contentType: 'image/png' });

                        const pageContent = await page.content();
                        const truncatedContent = pageContent.substring(0, 50000);
                        await kvStore.setValue(`debug-html-page-${pageNo}`, truncatedContent, { contentType: 'text/html' });

                        log.info('Saved debug screenshot and HTML to key-value store');

                        // Check if page shows a block message
                        if (pageContent.includes('datadome') || pageContent.includes('captcha') || pageContent.includes('blocked')) {
                            log.error('Detected anti-bot block page - consider using residential proxies');
                        }
                    } catch (e) {
                        log.warning('Failed to save debug info', { error: e.message });
                    }

                    return;
                }

                // Get page content for JSON-LD extraction
                const content = await page.content();

                // Priority 1: Use intercepted API data if available
                let vehicles = interceptedVehicles.length > 0 ? interceptedVehicles : [];

                // Priority 2: Try JSON-LD extraction
                if (vehicles.length === 0) {
                    vehicles = extractFromJsonLd(content);
                }

                // Priority 3: Fallback to DOM extraction
                if (vehicles.length === 0) {
                    vehicles = await page.evaluate(() => {
                        const cards = document.querySelectorAll('.srp-grid-list-item, div[id^="listing_"], [data-testid="listing-card"]');
                        return Array.from(cards).map(card => {
                            const titleEl = card.querySelector('h3.srp-list-item-basic-info-model, h3, [data-testid="listing-title"]');
                            const linkEl = card.querySelector('.srp-list-item__header a, header a, a[href*="/vehicle/"]');
                            const priceEl = card.querySelector('.srp-list-item__price, [class*="price"], [data-testid="listing-price"]');
                            const infoEl = card.querySelector('span.srp-grid-list-item__mileage-address, [data-testid="listing-mileage"]');
                            const imgEl = card.querySelector('figure.srp-list-item__image-anchor img, img');

                            // Parse mileage and location from info span
                            const infoText = infoEl ? infoEl.textContent.trim() : '';
                            const [mileageStr, locationStr] = infoText.split('|').map(s => s?.trim() || '');
                            const mileage = mileageStr ? parseInt(mileageStr.replace(/[^0-9]/g, ''), 10) : null;

                            // Parse price
                            const priceText = priceEl ? priceEl.textContent.trim() : '';
                            const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) : null;

                            return {
                                title: titleEl ? titleEl.textContent.trim() : null,
                                price: price,
                                currency: 'USD',
                                mileage: mileage,
                                location: locationStr || null,
                                image_url: imgEl ? imgEl.src : null,
                                url: linkEl ? linkEl.href : null,
                            };
                        }).filter(v => v.title);
                    });
                }

                log.info(`Found ${vehicles.length} vehicles on page ${pageNo} (source: ${interceptedVehicles.length > 0 ? 'API' : 'DOM/JSON-LD'})`);

                // Save vehicles up to results_wanted
                const remaining = RESULTS_WANTED - saved;
                const toSave = vehicles.slice(0, Math.max(0, remaining));

                for (const vehicle of toSave) {
                    await Dataset.pushData({
                        ...vehicle,
                        scraped_at: new Date().toISOString(),
                        source: 'carfax.com',
                    });
                    saved++;

                    if (saved >= RESULTS_WANTED) break;
                }

                log.info(`Saved ${saved}/${RESULTS_WANTED} vehicles`);

                // Handle pagination if more results needed
                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                    // Add delay before pagination for human-like behavior
                    await page.waitForTimeout(randomDelay(2000, 4000));

                    // Check for next button
                    const hasNextButton = await page.evaluate(() => {
                        const nextBtn = document.querySelector('button.pagination_pages_nav:not([disabled])');
                        return nextBtn && nextBtn.textContent.includes('Next');
                    });

                    if (hasNextButton) {
                        // Click next and wait for content update
                        await page.click('button.pagination_pages_nav:last-of-type');
                        await page.waitForTimeout(randomDelay(2500, 4000));

                        // Wait for network to settle
                        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

                        // Wait for new listings to load
                        try {
                            await page.waitForFunction(() => {
                                const listings = document.querySelectorAll('header.srp-list-item__header');
                                return listings.length > 0;
                            }, { timeout: 15000 });
                        } catch {
                            log.info('No more pages available');
                            return;
                        }

                        // Simulate human behavior on new page
                        await simulateHumanBehavior(page);

                        // Recursively process the next page
                        currentPage++;

                        // Get new content after pagination
                        const newContent = await page.content();
                        let newVehicles = interceptedVehicles.length > 0 ? [...interceptedVehicles] : extractFromJsonLd(newContent);

                        if (newVehicles.length === 0) {
                            newVehicles = await page.evaluate(() => {
                                const cards = document.querySelectorAll('.srp-grid-list-item, div[id^="listing_"], [data-testid="listing-card"]');
                                return Array.from(cards).map(card => {
                                    const titleEl = card.querySelector('h3.srp-list-item-basic-info-model, h3, [data-testid="listing-title"]');
                                    const linkEl = card.querySelector('.srp-list-item__header a, header a, a[href*="/vehicle/"]');
                                    const priceEl = card.querySelector('.srp-list-item__price, [class*="price"], [data-testid="listing-price"]');
                                    const infoEl = card.querySelector('span.srp-grid-list-item__mileage-address, [data-testid="listing-mileage"]');
                                    const imgEl = card.querySelector('figure.srp-list-item__image-anchor img, img');

                                    const infoText = infoEl ? infoEl.textContent.trim() : '';
                                    const [mileageStr, locationStr] = infoText.split('|').map(s => s?.trim() || '');
                                    const mileage = mileageStr ? parseInt(mileageStr.replace(/[^0-9]/g, ''), 10) : null;

                                    const priceText = priceEl ? priceEl.textContent.trim() : '';
                                    const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) : null;

                                    return {
                                        title: titleEl ? titleEl.textContent.trim() : null,
                                        price: price,
                                        currency: 'USD',
                                        mileage: mileage,
                                        location: locationStr || null,
                                        image_url: imgEl ? imgEl.src : null,
                                        url: linkEl ? linkEl.href : null,
                                    };
                                }).filter(v => v.title);
                            });
                        }

                        log.info(`Found ${newVehicles.length} vehicles on page ${currentPage}`);

                        const newRemaining = RESULTS_WANTED - saved;
                        const newToSave = newVehicles.slice(0, Math.max(0, newRemaining));

                        for (const vehicle of newToSave) {
                            await Dataset.pushData({
                                ...vehicle,
                                scraped_at: new Date().toISOString(),
                                source: 'carfax.com',
                            });
                            saved++;

                            if (saved >= RESULTS_WANTED) break;
                        }

                        // Continue pagination if needed
                        while (saved < RESULTS_WANTED && currentPage < MAX_PAGES) {
                            // Human-like delay between pages
                            await page.waitForTimeout(randomDelay(3000, 5000));

                            const canContinue = await page.evaluate(() => {
                                const nextBtn = document.querySelector('button.pagination_pages_nav:not([disabled])');
                                return nextBtn && nextBtn.textContent.includes('Next');
                            });

                            if (!canContinue) {
                                log.info('No more pages available');
                                break;
                            }

                            await page.click('button.pagination_pages_nav:last-of-type');
                            await page.waitForTimeout(randomDelay(2500, 4000));
                            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

                            currentPage++;

                            // Simulate human behavior
                            await simulateHumanBehavior(page);

                            const pageContent = await page.content();
                            let pageVehicles = interceptedVehicles.length > 0 ? [...interceptedVehicles] : extractFromJsonLd(pageContent);

                            if (pageVehicles.length === 0) {
                                pageVehicles = await page.evaluate(() => {
                                    const cards = document.querySelectorAll('.srp-grid-list-item, div[id^="listing_"], [data-testid="listing-card"]');
                                    return Array.from(cards).map(card => {
                                        const titleEl = card.querySelector('h3.srp-list-item-basic-info-model, h3, [data-testid="listing-title"]');
                                        const linkEl = card.querySelector('.srp-list-item__header a, header a, a[href*="/vehicle/"]');
                                        const priceEl = card.querySelector('.srp-list-item__price, [class*="price"], [data-testid="listing-price"]');
                                        const infoEl = card.querySelector('span.srp-grid-list-item__mileage-address, [data-testid="listing-mileage"]');
                                        const imgEl = card.querySelector('figure.srp-list-item__image-anchor img, img');

                                        const infoText = infoEl ? infoEl.textContent.trim() : '';
                                        const [mileageStr, locationStr] = infoText.split('|').map(s => s?.trim() || '');
                                        const mileage = mileageStr ? parseInt(mileageStr.replace(/[^0-9]/g, ''), 10) : null;

                                        const priceText = priceEl ? priceEl.textContent.trim() : '';
                                        const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) : null;

                                        return {
                                            title: titleEl ? titleEl.textContent.trim() : null,
                                            price: price,
                                            currency: 'USD',
                                            mileage: mileage,
                                            location: locationStr || null,
                                            image_url: imgEl ? imgEl.src : null,
                                            url: linkEl ? linkEl.href : null,
                                        };
                                    }).filter(v => v.title);
                                });
                            }

                            log.info(`Found ${pageVehicles.length} vehicles on page ${currentPage}`);

                            const pageRemaining = RESULTS_WANTED - saved;
                            const pageToSave = pageVehicles.slice(0, Math.max(0, pageRemaining));

                            for (const vehicle of pageToSave) {
                                await Dataset.pushData({
                                    ...vehicle,
                                    scraped_at: new Date().toISOString(),
                                    source: 'carfax.com',
                                });
                                saved++;

                                if (saved >= RESULTS_WANTED) break;
                            }
                        }
                    }
                }
            },

            failedRequestHandler: async ({ request, page }, error) => {
                if (error.message?.includes('403')) {
                    log.warning(`Blocked (403): ${request.url} - consider residential proxies`);
                } else {
                    log.error(`Failed: ${request.url}`, { error: error.message });
                }

                // Save debug screenshot on failure
                try {
                    if (page) {
                        const kvStore = await Actor.openKeyValueStore();
                        const screenshot = await page.screenshot({ fullPage: true });
                        await kvStore.setValue(`failed-screenshot-${Date.now()}`, screenshot, { contentType: 'image/png' });
                    }
                } catch (e) {
                    // Ignore screenshot errors
                }
            },
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} vehicles`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
