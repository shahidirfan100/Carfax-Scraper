import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { readFile } from 'node:fs/promises';
import { firefox } from 'playwright';

await Actor.init();

const LISTING_HINT_KEYS = ['vin', 'listPrice', 'currentPrice', 'vehicleUrl', 'make', 'model', 'year'];
const CARFAX_REFERRER = 'https://www.carfax.com/cars-for-sale';
const IS_AT_HOME = process.env.APIFY_IS_AT_HOME === '1';

const USER_AGENTS = {
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    mobile_web: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    mobile_app: 'CARFAX/6.65.0 okhttp/4.12.0 Android/14',
};

const isBlank = (value) => value === null || value === undefined || value === '';
const safeJsonParse = (value) => {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
};

const sleep = (millis) => new Promise((resolve) => setTimeout(resolve, millis));

function parseJsonObjectInput(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return fallback;

    const parsed = safeJsonParse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
}

function normalizeVin(value) {
    if (!value) return undefined;
    const upper = String(value).toUpperCase().trim();
    return upper.length === 17 ? upper : undefined;
}

function buildHelixVehicleUrl(vin) {
    return `https://helix.carfax.com/search/v2/vehicles/${vin}`;
}

function getHeaderProfiles(profile) {
    if (!profile || profile === 'auto') return ['firefox', 'chrome', 'mobile_web', 'mobile_app'];
    return [profile];
}

function buildHeaders(profileName, targetUrl, customHeaders = {}) {
    const isJsonTarget = /helix\.carfax\.com|\/search\/v2/i.test(targetUrl);

    const shared = {
        Accept: isJsonTarget ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: CARFAX_REFERRER,
        Origin: 'https://www.carfax.com',
    };

    const profileHeaders = {
        firefox: {
            ...shared,
            'User-Agent': USER_AGENTS.firefox,
        },
        chrome: {
            ...shared,
            'User-Agent': USER_AGENTS.chrome,
            'sec-ch-ua': '"Chromium";v="147", "Google Chrome";v="147", "Not-A.Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-site': isJsonTarget ? 'same-site' : 'none',
            'sec-fetch-mode': isJsonTarget ? 'cors' : 'navigate',
            'sec-fetch-dest': isJsonTarget ? 'empty' : 'document',
        },
        mobile_web: {
            ...shared,
            'User-Agent': USER_AGENTS.mobile_web,
        },
        mobile_app: {
            Accept: 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': USER_AGENTS.mobile_app,
            'X-Requested-With': 'com.carfax.consumer',
        },
    };

    return {
        ...(profileHeaders[profileName] || profileHeaders.firefox),
        ...customHeaders,
    };
}

function responseLooksBlocked(statusCode, text = '') {
    if (statusCode === 403 || statusCode === 429) return true;
    return /request blocked|datadome|captcha|cloudfront|interstitial/i.test(text);
}

function unwrapResponsePayload(bodyText, headers) {
    const contentType = String(headers['content-type'] || '').toLowerCase();

    if (contentType.includes('json') || /^[\[{]/.test(bodyText.trim())) {
        const parsed = safeJsonParse(bodyText);
        if (parsed !== undefined) {
            if (parsed && typeof parsed === 'object') {
                for (const key of ['body', 'html', 'content']) {
                    if (typeof parsed[key] === 'string') {
                        return {
                            contentType: String(parsed.contentType || parsed.mimeType || 'text/html').toLowerCase(),
                            text: parsed[key],
                            json: safeJsonParse(parsed[key]),
                        };
                    }
                }

                for (const key of ['data', 'result', 'response']) {
                    if (parsed[key] && typeof parsed[key] === 'object') {
                        return {
                            contentType: 'application/json',
                            text: JSON.stringify(parsed[key]),
                            json: parsed[key],
                        };
                    }
                }
            }

            return {
                contentType: 'application/json',
                text: bodyText,
                json: parsed,
            };
        }
    }

    return {
        contentType,
        text: bodyText,
        json: undefined,
    };
}

function extractVehicleRefsFromText(text) {
    const vins = new Set();
    const detailUrls = new Set();

    for (const match of text.matchAll(/helix\.carfax\.com\/search\/v2\/vehicles\/([A-HJ-NPR-Z0-9]{17})/gi)) {
        const vin = normalizeVin(match[1]);
        if (!vin) continue;
        vins.add(vin);
        detailUrls.add(buildHelixVehicleUrl(vin));
    }

    for (const match of text.matchAll(/(?:https?:\/\/www\.carfax\.com)?\/vehicle\/([A-HJ-NPR-Z0-9]{17})/gi)) {
        const vin = normalizeVin(match[1]);
        if (!vin) continue;
        vins.add(vin);
        detailUrls.add(buildHelixVehicleUrl(vin));
    }

    for (const match of text.matchAll(/"vin"\s*:\s*"([A-HJ-NPR-Z0-9]{17})"/gi)) {
        const vin = normalizeVin(match[1]);
        if (!vin) continue;
        vins.add(vin);
        detailUrls.add(buildHelixVehicleUrl(vin));
    }

    for (const vin of vins) {
        detailUrls.add(buildHelixVehicleUrl(vin));
    }

    return {
        vins,
        detailUrls,
    };
}

function extractEmbeddedPayloadsFromHtml(html) {
    const payloads = [];

    const nextDataMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch?.[1]) {
        const parsed = safeJsonParse(nextDataMatch[1]);
        if (parsed) payloads.push(parsed);
    }

    for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        const parsed = safeJsonParse(match[1]);
        if (parsed) payloads.push(parsed);
    }

    const assignmentPatterns = [
        /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/gi,
        /window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});/gi,
        /window\.__MOBX_STATE__\s*=\s*({[\s\S]*?});/gi,
    ];

    for (const pattern of assignmentPatterns) {
        for (const match of html.matchAll(pattern)) {
            const parsed = safeJsonParse(match[1]);
            if (parsed) payloads.push(parsed);
        }
    }

    return payloads;
}

function cleanValue(value) {
    if (Array.isArray(value)) {
        const cleaned = value.map(cleanValue).filter((item) => !isBlank(item));
        return cleaned.length ? cleaned : undefined;
    }

    if (value && typeof value === 'object') {
        const output = {};
        for (const [key, nested] of Object.entries(value)) {
            const cleaned = cleanValue(nested);
            if (!isBlank(cleaned)) output[key] = cleaned;
        }
        return Object.keys(output).length ? output : undefined;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length ? trimmed : undefined;
    }

    return value;
}

function looksLikeVehicle(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    return LISTING_HINT_KEYS.some((key) => key in item);
}

function collectVehicleCandidates(payload) {
    const candidates = [];
    const visited = new WeakSet();

    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (visited.has(node)) return;
        visited.add(node);

        if (Array.isArray(node)) {
            if (node.length > 0 && node.every((entry) => looksLikeVehicle(entry))) {
                candidates.push(...node);
                return;
            }
            for (const entry of node) walk(entry);
            return;
        }

        if (looksLikeVehicle(node)) {
            candidates.push(node);
        }

        const likelyCollections = ['listings', 'vehicles', 'results', 'items', 'searchResults', 'inventory'];
        for (const key of likelyCollections) {
            if (Array.isArray(node[key])) {
                for (const item of node[key]) {
                    if (looksLikeVehicle(item)) candidates.push(item);
                }
            }
        }

        for (const nested of Object.values(node)) {
            walk(nested);
        }
    };

    walk(payload);
    return candidates;
}

function mapVehicle(item, extractionMethod) {
    const mileageValue = typeof item.mileage === 'object' ? item.mileage?.value : item.mileage;
    const title = item.title || item.vehicleTitle || `${item.year || ''} ${item.make || ''} ${item.model || ''} ${item.trim || ''}`.trim();

    const record = {
        vin: item.vin,
        title,
        year: item.year,
        make: item.make,
        model: item.model,
        trim: item.trim,
        body_type: item.bodyType,
        vehicle_condition: item.vehicleCondition,
        price: item.currentPrice ?? item.listPrice ?? item.price,
        list_price: item.listPrice,
        one_price: item.onePrice,
        currency: item.currency || 'USD',
        mileage: mileageValue,
        mileage_label: typeof item.mileage === 'object' ? item.mileage?.label : undefined,
        badge: item.badge,
        stock_number: item.stockNumber,
        image_url: item.primaryImageUrl || item.primaryImage,
        images: item.images,
        url: item.vehicleUrl || item.url,
        dealer_name: item.dealerName,
        dealer_city: item.dealerCity,
        dealer_state: item.dealerState,
        dealer_zip: item.dealerZip,
        dealer_phone: item.dealerPhone,
        distance_to_dealer: item.distanceToDealer,
        exterior_color: item.exteriorColor || item.color,
        interior_color: item.interiorColor,
        engine: item.engine || item.engineData,
        transmission: item.transmission,
        drivetype: item.drivetype || item.driveType,
        mpg_city: item.mpgCity,
        mpg_highway: item.mpgHighway,
        one_owner: item.oneOwner,
        no_accidents: item.noAccidents,
        service_records: item.serviceRecords,
        monthly_payment_estimate: item.monthlyPaymentEstimate,
        price_history: item.priceHistory,
        top_options: item.topOptions,
        other_options: item.otherOptions,
        scraped_at: new Date().toISOString(),
        source: 'carfax.com',
        extraction_method: extractionMethod,
    };

    return cleanValue(record) || undefined;
}

function getUniqueKey(record) {
    return record?.vin || record?.url || `${record?.title || ''}|${record?.dealer_name || ''}|${record?.price || ''}`;
}

function isHelixResponse(url, contentType) {
    if (!url.includes('helix.carfax.com')) return false;
    if (!url.includes('/search/v2')) return false;
    return contentType.includes('json');
}

async function pushUniqueRecords(records, state, tag) {
    const batch = [];

    for (const record of records) {
        if (state.saved >= state.resultsWanted) break;
        const key = getUniqueKey(record);
        if (!key || state.seenKeys.has(key)) continue;
        state.seenKeys.add(key);
        batch.push(record);
        state.saved++;
    }

    if (batch.length) {
        await Actor.pushData(batch);
        log.info(`Saved ${batch.length} records from ${tag}. Total: ${state.saved}/${state.resultsWanted}`);
    }
}

function collectRecordsAndTargets(payload, extractionMethod) {
    const records = [];
    const detailTargets = new Set();

    if (payload.json !== undefined) {
        const candidates = collectVehicleCandidates(payload.json);
        for (const candidate of candidates) {
            const mapped = mapVehicle(candidate, extractionMethod);
            if (mapped) records.push(mapped);
        }

        const refsFromJson = extractVehicleRefsFromText(JSON.stringify(payload.json));
        for (const detailTarget of refsFromJson.detailUrls) detailTargets.add(detailTarget);
    }

    if (payload.text) {
        const embeddedPayloads = extractEmbeddedPayloadsFromHtml(payload.text);
        for (const embedded of embeddedPayloads) {
            const embeddedCandidates = collectVehicleCandidates(embedded);
            for (const candidate of embeddedCandidates) {
                const mapped = mapVehicle(candidate, `${extractionMethod}_embedded`);
                if (mapped) records.push(mapped);
            }
        }

        const refs = extractVehicleRefsFromText(payload.text);
        for (const detailTarget of refs.detailUrls) detailTargets.add(detailTarget);
    }

    return { records, detailTargets };
}

function resolveTransportConfig(input) {
    const envRequestApiUrl = process.env.CARFAX_REQUEST_API_URL?.trim();
    const envRequestApiHeaders = process.env.CARFAX_REQUEST_API_HEADERS?.trim();
    const envCustomHeaders = process.env.CARFAX_CUSTOM_HEADERS_JSON?.trim();

    let requestTransport = input.requestTransport || 'auto';
    const requestApiUrlTemplate = input.requestApiUrlTemplate?.trim() || (!IS_AT_HOME ? envRequestApiUrl : '');

    if (requestTransport === 'auto') {
        if (!IS_AT_HOME && requestApiUrlTemplate) {
            requestTransport = 'custom_request_api';
        } else if (IS_AT_HOME) {
            requestTransport = 'apify_proxy_http';
        } else {
            requestTransport = 'direct_http';
        }
    }

    return {
        requestTransport,
        headerProfiles: getHeaderProfiles(input.headerProfile || 'auto'),
        customHeaders: parseJsonObjectInput(input.customHeadersJson || envCustomHeaders, {}),
        requestApiUrlTemplate,
        requestApiMethod: (input.requestApiMethod || 'GET').toUpperCase(),
        requestApiUrlParam: input.requestApiUrlParam || 'url',
        requestApiHeaders: parseJsonObjectInput(input.requestApiHeadersJson || envRequestApiHeaders, {}),
        useBrowserFallback: input.useBrowserFallback !== false,
        requestTimeoutSecs: Number.isFinite(+input.requestTimeoutSecs) ? Math.max(5, +input.requestTimeoutSecs) : 45,
        requestDelayMillis: Number.isFinite(+input.requestDelayMillis) ? Math.max(0, +input.requestDelayMillis) : 350,
        browserUserAgent: USER_AGENTS[(input.headerProfile && input.headerProfile !== 'auto') ? input.headerProfile : 'firefox'],
    };
}

async function fetchThroughTransport(targetUrl, profileName, transportConfig, proxyConfiguration) {
    const targetHeaders = buildHeaders(profileName, targetUrl, transportConfig.customHeaders);
    let requestUrl = targetUrl;
    const options = {
        method: 'GET',
        headers: targetHeaders,
        timeout: { request: transportConfig.requestTimeoutSecs * 1000 },
        responseType: 'text',
        throwHttpErrors: false,
        retry: { limit: 0 },
        https: { rejectUnauthorized: false },
    };

    if (transportConfig.requestTransport === 'custom_request_api') {
        requestUrl = transportConfig.requestApiUrlTemplate;
        options.method = transportConfig.requestApiMethod;
        options.headers = transportConfig.requestApiHeaders;

        if (!requestUrl) {
            throw new Error('requestApiUrlTemplate is required for custom_request_api transport');
        }

        if (requestUrl.includes('{url}')) {
            requestUrl = requestUrl.replaceAll('{url}', encodeURIComponent(targetUrl));
        } else if (options.method === 'GET') {
            const apiUrl = new URL(requestUrl);
            apiUrl.searchParams.set(transportConfig.requestApiUrlParam, targetUrl);
            requestUrl = apiUrl.toString();
        } else {
            options.json = {
                [transportConfig.requestApiUrlParam]: targetUrl,
                headers: targetHeaders,
            };
        }
    } else if (transportConfig.requestTransport === 'apify_proxy_http' && proxyConfiguration) {
        options.proxyUrl = await proxyConfiguration.newUrl();
    }

    const response = await gotScraping({ url: requestUrl, ...options });
    const bodyText = typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? '');

    return {
        statusCode: response.statusCode || 0,
        headers: response.headers || {},
        bodyText,
        requestUrl,
    };
}

async function tryHttpRequestVariants(targetUrl, transportConfig, proxyConfiguration) {
    let lastResult;

    for (const profileName of transportConfig.headerProfiles) {
        const response = await fetchThroughTransport(targetUrl, profileName, transportConfig, proxyConfiguration);
        const payload = unwrapResponsePayload(response.bodyText, response.headers);
        const blocked = responseLooksBlocked(response.statusCode, payload.text);

        log.info(`HTTP ${profileName} -> ${response.statusCode} for ${targetUrl}`);

        lastResult = {
            ...response,
            ...payload,
            usedProfile: profileName,
            blocked,
        };

        if (!blocked && response.statusCode >= 200 && response.statusCode < 300) {
            return lastResult;
        }
    }

    return lastResult;
}

function parsePlaywrightProxy(proxyUrl) {
    if (!proxyUrl) return undefined;
    const parsed = new URL(proxyUrl);
    return {
        server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    };
}

async function runHttpDiscovery(startTargets, transportConfig, proxyConfiguration, state) {
    const pending = [...startTargets];

    while (pending.length && state.saved < state.resultsWanted) {
        const targetUrl = pending.shift();
        if (!targetUrl || state.visitedTargets.has(targetUrl)) continue;
        state.visitedTargets.add(targetUrl);

        if (transportConfig.requestDelayMillis > 0 && state.visitedTargets.size > 1) {
            await sleep(transportConfig.requestDelayMillis);
        }

        const response = await tryHttpRequestVariants(targetUrl, transportConfig, proxyConfiguration).catch((error) => {
            log.warning(`HTTP request failed for ${targetUrl}: ${error.message}`);
            return undefined;
        });

        if (!response) continue;

        const extractionMethod = targetUrl.includes('helix.carfax.com')
            ? `helix_http_${response.usedProfile}`
            : `http_${response.usedProfile}`;

        const { records, detailTargets } = collectRecordsAndTargets(response, extractionMethod);
        await pushUniqueRecords(records, state, extractionMethod);

        for (const detailTarget of detailTargets) {
            if (!state.visitedTargets.has(detailTarget)) pending.push(detailTarget);
        }
    }
}

async function runBrowserFallback(startTargets, transportConfig, proxyConfiguration, maxPages, state) {
    const browserVisitedTargets = new Set();
    let proxy;
    if (proxyConfiguration && (IS_AT_HOME || transportConfig.requestTransport === 'apify_proxy_http')) {
        proxy = parsePlaywrightProxy(await proxyConfiguration.newUrl());
    }

    const browser = await firefox.launch({
        headless: true,
        proxy,
    });

    const context = await browser.newContext({
        locale: 'en-US',
        userAgent: transportConfig.browserUserAgent,
        viewport: { width: 1440, height: 900 },
    });

    await context.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        const reqUrl = route.request().url();
        if (['image', 'media', 'font'].includes(resourceType)) return route.abort();
        if (reqUrl.includes('google-analytics') || reqUrl.includes('googletagmanager') || reqUrl.includes('doubleclick')) {
            return route.abort();
        }
        return route.continue();
    });

    const pending = [...startTargets];

    try {
        while (pending.length && state.saved < state.resultsWanted) {
            const targetUrl = pending.shift();
            if (!targetUrl || browserVisitedTargets.has(targetUrl)) continue;
            browserVisitedTargets.add(targetUrl);

            const page = await context.newPage();
            const apiRecords = [];
            let processedCount = 0;

            const flushCapturedRecords = async (tag) => {
                const pendingRecords = apiRecords.slice(processedCount);
                processedCount = apiRecords.length;
                await pushUniqueRecords(pendingRecords, state, tag);
            };

            const onResponse = async (response) => {
                try {
                    const responseUrl = response.url();
                    const contentType = (response.headers()['content-type'] || '').toLowerCase();
                    if (!isHelixResponse(responseUrl, contentType)) return;

                    const payload = await response.json();
                    const candidates = collectVehicleCandidates(payload);
                    for (const candidate of candidates) {
                        const mapped = mapVehicle(candidate, 'browser_helix_api');
                        if (mapped) apiRecords.push(mapped);
                    }
                } catch (error) {
                    log.debug('Browser response parse failed', { message: error.message });
                }
            };

            page.on('response', onResponse);

            try {
                const response = await page.goto(targetUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: transportConfig.requestTimeoutSecs * 1000,
                }).catch(() => undefined);

                const statusCode = response?.status() || 0;
                log.info(`Browser navigation -> ${statusCode} for ${targetUrl}`);

                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                await flushCapturedRecords('browser initial responses');

                const html = await page.content();
                const { records, detailTargets } = collectRecordsAndTargets({ text: html, contentType: 'text/html' }, 'browser_html');
                await pushUniqueRecords(records, state, 'browser html');
                for (const detailTarget of detailTargets) {
                    if (!browserVisitedTargets.has(detailTarget)) pending.push(detailTarget);
                }

                if (!/helix\.carfax\.com\/search\/v2\/vehicles|\/vehicle\//i.test(targetUrl)) {
                    let pageNumber = 1;
                    while (state.saved < state.resultsWanted && pageNumber < maxPages) {
                        const hasNext = await page.evaluate(() => {
                            const buttons = Array.from(document.querySelectorAll('button.pagination_pages_nav:not([disabled])'));
                            return buttons.some((button) => /next/i.test(button.textContent || ''));
                        }).catch(() => false);

                        if (!hasNext) break;

                        const clicked = await page.evaluate(() => {
                            const buttons = Array.from(document.querySelectorAll('button.pagination_pages_nav:not([disabled])'));
                            const nextBtn = buttons.find((button) => /next/i.test(button.textContent || ''));
                            if (!nextBtn) return false;
                            nextBtn.click();
                            return true;
                        }).catch(() => false);

                        if (!clicked) break;

                        pageNumber += 1;
                        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                        await page.waitForTimeout(1500);
                        await flushCapturedRecords(`browser page ${pageNumber} responses`);

                        const nextHtml = await page.content();
                        const nextPayload = collectRecordsAndTargets({ text: nextHtml, contentType: 'text/html' }, `browser_html_page_${pageNumber}`);
                        await pushUniqueRecords(nextPayload.records, state, `browser page ${pageNumber} html`);
                        for (const detailTarget of nextPayload.detailTargets) {
                            if (!browserVisitedTargets.has(detailTarget)) pending.push(detailTarget);
                        }
                    }
                }
            } finally {
                page.removeListener('response', onResponse);
                await page.close().catch(() => {});
            }
        }
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

async function main() {
    try {
        let input = (await Actor.getInput()) || {};
        if (!IS_AT_HOME && Object.keys(input).length === 0) {
            const localInput = await readFile(new URL('../INPUT.json', import.meta.url), 'utf8')
                .then((contents) => safeJsonParse(contents))
                .catch(() => undefined);

            if (localInput && typeof localInput === 'object') {
                input = localInput;
                log.info('Loaded local INPUT.json for npm start run');
            }
        }

        const {
            startUrl,
            startUrls,
            url,
            vin,
            make,
            model,
            year_min,
            year_max,
            price_min,
            price_max,
            mileage_max,
            location,
            proxyConfiguration: proxyConfigInput,
            results_wanted: resultsWantedRaw = 20,
            max_pages: maxPagesRaw = 10,
        } = input;

        const resultsWanted = Number.isFinite(+resultsWantedRaw) ? Math.max(1, +resultsWantedRaw) : 20;
        const maxPages = Number.isFinite(+maxPagesRaw) ? Math.max(1, +maxPagesRaw) : 10;
        const transportConfig = resolveTransportConfig(input);

        const buildStartUrl = () => {
            const baseUrl = 'https://www.carfax.com/';
            let path = 'Cars';

            if (make && model) {
                path = `Used-${make}-${model}`.replace(/\s+/g, '-');
            } else if (make) {
                path = `Used-${make}`.replace(/\s+/g, '-');
            } else {
                path = 'cars-for-sale';
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

        const normalizeStartUrl = (entry) => {
            if (!entry) return undefined;
            if (typeof entry === 'string') return entry;
            if (entry && typeof entry === 'object' && typeof entry.url === 'string') return entry.url;
            return undefined;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) {
            for (const candidate of startUrls) {
                const normalized = normalizeStartUrl(candidate);
                if (normalized) initial.push(normalized);
            }
        }
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl());

        const directVin = normalizeVin(vin);
        if (directVin) initial.unshift(buildHelixVehicleUrl(directVin));

        const shouldCreateProxy = IS_AT_HOME || transportConfig.requestTransport === 'apify_proxy_http';
        const proxyConfiguration = shouldCreateProxy
            ? await Actor.createProxyConfiguration(
                proxyConfigInput || {
                    useApifyProxy: true,
                    apifyProxyGroups: ['RESIDENTIAL'],
                },
            )
            : undefined;

        const state = {
            saved: 0,
            resultsWanted,
            seenKeys: new Set(),
            visitedTargets: new Set(),
        };

        log.info(`Starting Carfax API actor for URLs: ${initial.join(', ')}`);
        log.info(`Resolved request transport: ${transportConfig.requestTransport}; header profiles: ${transportConfig.headerProfiles.join(', ')}`);

        if (transportConfig.requestTransport !== 'browser_firefox') {
            await runHttpDiscovery(initial, transportConfig, proxyConfiguration, state);
        }

        if (state.saved < resultsWanted && transportConfig.useBrowserFallback) {
            log.info(`Switching to browser fallback after HTTP phase. Current total: ${state.saved}/${resultsWanted}`);
            await runBrowserFallback(initial, transportConfig, proxyConfiguration, maxPages, state);
        }

        log.info(`Finished. Total saved: ${state.saved} vehicles`);
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    console.error('Actor failed:', err);
    process.exit(1);
});
