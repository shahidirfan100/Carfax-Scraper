// Carfax Used Cars Scraper - PlaywrightCrawler implementation
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

        const crawler = new PlaywrightCrawler({
            launchContext: {
                launcher: firefox,
                launchOptions: {
                    headless: true,
                },
                userAgent: getRandomUserAgent(),
            },
            proxyConfiguration: proxyConf,
            maxConcurrency: 3,
            maxRequestRetries: 3,
            navigationTimeoutSecs: 60,
            requestHandlerTimeoutSecs: 90,
            useSessionPool: true,

            // Block heavy resources for performance
            preNavigationHooks: [
                async ({ page }) => {
                    await page.route('**/*', (route) => {
                        const type = route.request().resourceType();
                        const url = route.request().url();

                        // Block images, fonts, media, and trackers to speed up
                        if (['image', 'font', 'media'].includes(type) ||
                            url.includes('google-analytics') ||
                            url.includes('googletagmanager') ||
                            url.includes('facebook') ||
                            url.includes('doubleclick') ||
                            url.includes('adsense')) {
                            return route.abort();
                        }
                        return route.continue();
                    });
                },
            ],

            requestHandler: async ({ page, request }) => {
                const pageNo = request.userData?.pageNo || 1;
                
                log.info(`Processing page ${pageNo}: ${request.url}`);

                // Wait for listings to load
                try {
                    await page.waitForSelector('header.srp-list-item__header', { timeout: 15000 });
                } catch {
                    log.warning(`Listings not found on ${request.url}`);
                    return;
                }

                // Scroll to trigger lazy loading
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(1500);

                // Get page content for JSON-LD extraction
                const content = await page.content();
                
                // Try JSON-LD extraction first (Priority 1)
                let vehicles = extractFromJsonLd(content);
                
                // Fallback to DOM extraction if no JSON-LD found
                if (vehicles.length === 0) {
                    vehicles = await page.evaluate(() => {
                        const cards = document.querySelectorAll('.srp-grid-list-item, div[id^="listing_"]');
                        return Array.from(cards).map(card => {
                            const titleEl = card.querySelector('h3.srp-list-item-basic-info-model, h3');
                            const linkEl = card.querySelector('.srp-list-item__header a, header a');
                            const priceEl = card.querySelector('.srp-list-item__price, [class*="price"]');
                            const infoEl = card.querySelector('span.srp-grid-list-item__mileage-address');
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

                log.info(`Found ${vehicles.length} vehicles on page ${pageNo}`);

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
                    // Check for next button
                    const hasNextButton = await page.evaluate(() => {
                        const nextBtn = document.querySelector('button.pagination_pages_nav:not([disabled])');
                        return nextBtn && nextBtn.textContent.includes('Next');
                    });

                    if (hasNextButton) {
                        // Click next and wait for content update
                        await page.click('button.pagination_pages_nav:last-of-type');
                        await page.waitForTimeout(2000);
                        
                        // Wait for new listings to load
                        try {
                            await page.waitForFunction(() => {
                                const listings = document.querySelectorAll('header.srp-list-item__header');
                                return listings.length > 0;
                            }, { timeout: 10000 });
                        } catch {
                            log.info('No more pages available');
                            return;
                        }

                        // Recursively process the next page
                        currentPage++;
                        
                        // Get new content after pagination
                        const newContent = await page.content();
                        let newVehicles = extractFromJsonLd(newContent);
                        
                        if (newVehicles.length === 0) {
                            newVehicles = await page.evaluate(() => {
                                const cards = document.querySelectorAll('.srp-grid-list-item, div[id^="listing_"]');
                                return Array.from(cards).map(card => {
                                    const titleEl = card.querySelector('h3.srp-list-item-basic-info-model, h3');
                                    const linkEl = card.querySelector('.srp-list-item__header a, header a');
                                    const priceEl = card.querySelector('.srp-list-item__price, [class*="price"]');
                                    const infoEl = card.querySelector('span.srp-grid-list-item__mileage-address');
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
                            const canContinue = await page.evaluate(() => {
                                const nextBtn = document.querySelector('button.pagination_pages_nav:not([disabled])');
                                return nextBtn && nextBtn.textContent.includes('Next');
                            });

                            if (!canContinue) {
                                log.info('No more pages available');
                                break;
                            }

                            await page.click('button.pagination_pages_nav:last-of-type');
                            await page.waitForTimeout(2000);
                            currentPage++;

                            const pageContent = await page.content();
                            let pageVehicles = extractFromJsonLd(pageContent);
                            
                            if (pageVehicles.length === 0) {
                                pageVehicles = await page.evaluate(() => {
                                    const cards = document.querySelectorAll('.srp-grid-list-item, div[id^="listing_"]');
                                    return Array.from(cards).map(card => {
                                        const titleEl = card.querySelector('h3.srp-list-item-basic-info-model, h3');
                                        const linkEl = card.querySelector('.srp-list-item__header a, header a');
                                        const priceEl = card.querySelector('.srp-list-item__price, [class*="price"]');
                                        const infoEl = card.querySelector('span.srp-grid-list-item__mileage-address');
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

            failedRequestHandler: async ({ request }, error) => {
                if (error.message?.includes('403')) {
                    log.warning(`Blocked (403): ${request.url} - skipping`);
                } else {
                    log.error(`Failed: ${request.url}`, { error: error.message });
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
