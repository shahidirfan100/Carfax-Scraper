import { pathToFileURL } from 'node:url';

import { Actor, log } from 'apify';

import { DEFAULT_START_URL, fetchWithRecovery, getHeaderProfiles, HttpSessions, isBlocked, readDiscovery, validateTarget } from './transport.js';

const CARFAX_REFERRER = 'https://www.carfax.com/cars-for-sale';
const IS_AT_HOME = process.env.APIFY_IS_AT_HOME === '1';

const isBlank = (value) => value === null || value === undefined || value === '';
const safeJsonParse = (value) => {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
};

const sleep = (millis) => new Promise((resolve) => { setTimeout(resolve, millis); });

// Keep failure diagnostics useful without leaking proxy credentials.
function safeError(error) {
    const name = error?.name || 'Error';
    const message = String(error?.message || 'no message')
        .replace(/\/\/[^@/]+@/g, '//***@')
        .replace(/https?:\/\/\S+/g, '[url]')
        .replace(/\s+/g, ' ');
    return `${name}: ${message}`.slice(0, 300);
}

function parseJsonObjectInput(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') throw new Error('Header configuration must be a JSON object');

    const parsed = safeJsonParse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Header configuration must be a JSON object');
    return parsed;
}

function normalizeVin(value) {
    if (!value) return undefined;
    const upper = String(value).toUpperCase().trim();
    return /^[A-HJ-NPR-Z0-9]{17}$/.test(upper) ? upper : undefined;
}

function buildHelixVehicleUrl(vin) {
    return `https://helix.carfax.com/search/v2/vehicles/${vin}`;
}

const SEARCH_API_PATH = '/search/v2/vehicles';

// The listing JSON API accepts make/model/location filters and pages with `page`.
function isSearchApiUrl(value) {
    try {
        const url = new URL(value);
        return url.hostname === 'helix.carfax.com' && url.pathname === SEARCH_API_PATH;
    } catch {
        return false;
    }
}

function withPage(url, page) {
    const parsed = new URL(url);
    parsed.searchParams.set('page', String(page));
    return parsed.toString();
}

function buildSearchApiUrl(filters) {
    const params = new URLSearchParams();
    if (filters.make) params.set('make', String(filters.make).trim());
    if (filters.model) params.set('model', String(filters.model).trim());
    if (filters.location) params.set('zip', String(filters.location).trim());
    if (filters.year_min) params.set('yearMin', filters.year_min);
    if (filters.year_max) params.set('yearMax', filters.year_max);
    if (filters.price_min !== undefined) params.set('priceMin', filters.price_min);
    if (filters.price_max !== undefined) params.set('priceMax', filters.price_max);
    if (filters.mileage_max !== undefined) params.set('mileageMax', filters.mileage_max);
    params.set('vehicleCondition', 'USED');
    params.set('rows', '100');
    params.set('sort', 'BEST');
    params.set('page', '1');
    return `https://helix.carfax.com${SEARCH_API_PATH}?${params}`;
}

function buildHeaders(targetUrl, customHeaders = {}) {
    const headers = new Headers(customHeaders);
    if (new URL(targetUrl).hostname === 'helix.carfax.com') {
        if (!headers.has('origin')) headers.set('origin', 'https://www.carfax.com');
        if (!headers.has('referer')) headers.set('referer', CARFAX_REFERRER);
    }
    return Object.fromEntries(headers);
}

function unwrapResponsePayload(bodyText, headers) {
    const contentType = String(headers['content-type'] || '').toLowerCase();

    if (contentType.includes('json') || /^[{[]/.test(bodyText.trim())) {
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
    return Boolean(normalizeVin(item.vin) || ((item.vehicleUrl || item.url)
        && (item.title || item.vehicleTitle || (item.make && item.model))));
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

async function pushUniqueRecords(records, state, tag) {
    const batch = [];
    const keys = new Set();
    for (const record of records) {
        if (state.saved + batch.length >= state.resultsWanted) break;
        const key = getUniqueKey(record);
        if (!key || state.seenKeys.has(key) || keys.has(key)) continue;
        keys.add(key);
        batch.push(record);
    }
    if (batch.length) {
        await Actor.pushData(batch);
        for (const key of keys) state.seenKeys.add(key);
        Object.assign(state, { saved: state.saved + batch.length });
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

// Transport, profile rotation, timeouts and pacing are internal defaults so the
// actor needs no transport tuning input. The only override is an optional relay
// URL via environment, for developer testing where direct access is blocked.
function resolveTransportConfig(input) {
    const envRequestApiUrl = process.env.CARFAX_REQUEST_API_URL?.trim();
    const envRequestApiHeaders = process.env.CARFAX_REQUEST_API_HEADERS?.trim();
    const envCustomHeaders = process.env.CARFAX_CUSTOM_HEADERS_JSON?.trim();

    const requestApiUrlTemplate = (!IS_AT_HOME && envRequestApiUrl) || '';
    let requestTransport = 'direct_http';
    if (requestApiUrlTemplate) {
        requestTransport = 'custom_request_api';
    } else if (IS_AT_HOME && input.proxyConfiguration?.useApifyProxy !== false) {
        requestTransport = 'apify_proxy_http';
    }

    return {
        requestTransport,
        headerProfiles: getHeaderProfiles('auto'),
        customHeaders: parseJsonObjectInput(envCustomHeaders, {}),
        requestApiUrlTemplate,
        requestApiMethod: 'GET',
        requestApiUrlParam: 'url',
        requestApiHeaders: parseJsonObjectInput(envRequestApiHeaders, {}),
        requestTimeoutSecs: 45,
        requestDelayMillis: 350,
    };
}

async function fetchThroughTransport(targetUrl, profileName, transportConfig) {
    const targetHeaders = buildHeaders(targetUrl, transportConfig.customHeaders);
    let requestUrl = targetUrl;
    const options = { method: 'GET', headers: targetHeaders };

    if (transportConfig.requestTransport === 'custom_request_api') {
        requestUrl = transportConfig.requestApiUrlTemplate;
        options.method = transportConfig.requestApiMethod;
        options.headers = { ...transportConfig.requestApiHeaders };
        if (!requestUrl) throw new Error('requestApiUrlTemplate is required for custom_request_api transport');
        if (requestUrl.includes('{url}')) {
            requestUrl = requestUrl.replaceAll('{url}', encodeURIComponent(targetUrl));
        } else if (options.method === 'GET') {
            const apiUrl = new URL(requestUrl);
            apiUrl.searchParams.set(transportConfig.requestApiUrlParam, targetUrl);
            requestUrl = apiUrl.toString();
        } else {
            options.headers['content-type'] = 'application/json';
            options.body = JSON.stringify({ [transportConfig.requestApiUrlParam]: targetUrl, headers: targetHeaders });
        }
    }

    const client = await transportConfig.sessions.get(profileName);
    const response = await client.fetch(requestUrl, options);
    return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        bodyText: await response.text(),
        requestUrl,
    };
}

async function tryHttpRequestVariants(targetUrl, transportConfig) {
    let lastResult;
    for (const profileName of transportConfig.headerProfiles) {
        const response = await fetchWithRecovery(
            () => fetchThroughTransport(targetUrl, profileName, transportConfig),
            { log, retire: () => transportConfig.sessions.retire(profileName) },
        ).catch(() => undefined);
        if (!response) continue;
        const payload = unwrapResponsePayload(response.bodyText, response.headers);
        const blocked = isBlocked(response.statusCode, payload.text) || isBlocked(response.statusCode, response.bodyText);
        log.debug(`HTTP ${profileName} -> ${response.statusCode}`);
        lastResult = { ...response, ...payload, usedProfile: profileName, blocked };
        if (!blocked && response.statusCode >= 200 && response.statusCode < 300) return lastResult;
        await readDiscovery(log);
        transportConfig.sessions.retire(profileName);
        // Permanent errors do not become valid by cycling browser profiles.
        if ([400, 404, 405, 410, 422].includes(response.statusCode)) break;
    }
    return lastResult;
}

async function runHttpDiscovery(startTargets, transportConfig, state) {
    const pending = [...startTargets];

    while (pending.length && state.saved < state.resultsWanted) {
        const targetUrl = pending.shift();
        if (!targetUrl || state.visitedTargets.has(targetUrl)) continue;
        state.visitedTargets.add(targetUrl);

        if (transportConfig.requestDelayMillis > 0 && state.visitedTargets.size > 1) {
            await sleep(transportConfig.requestDelayMillis);
        }

        // The listing API pages with a `page` parameter; satisfy large limits over
        // HTTP instead of switching to the slower browser phase.
        if (isSearchApiUrl(targetUrl)) {
            let page = 1;
            while (state.saved < state.resultsWanted && page <= state.maxPages) {
                const response = await tryHttpRequestVariants(withPage(targetUrl, page), transportConfig)
                    .catch((error) => {
                        log.warning(`Search request failed (${safeError(error)})`);
                        return undefined;
                    });
                if (!response || response.blocked || response.statusCode < 200 || response.statusCode >= 300) break;
                const before = state.saved;
                const { records } = collectRecordsAndTargets(response, `search_api_${response.usedProfile}`);
                await pushUniqueRecords(records, state, `search page ${page}`);
                if (!records.length || state.saved === before) break;
                page++;
                if (transportConfig.requestDelayMillis > 0) await sleep(transportConfig.requestDelayMillis);
            }
            continue;
        }

        const response = await tryHttpRequestVariants(targetUrl, transportConfig).catch((error) => {
            log.warning(`Request failed (${safeError(error)})`);
            return undefined;
        });

        if (!response || response.blocked || response.statusCode < 200 || response.statusCode >= 300) {
            state.failedTargets.add(targetUrl);
            continue;
        }

        const extractionMethod = targetUrl.includes('helix.carfax.com')
            ? `helix_http_${response.usedProfile}`
            : `http_${response.usedProfile}`;

        const { records } = collectRecordsAndTargets(response, extractionMethod);
        if (!records.length) {
            await readDiscovery(log);
            state.failedTargets.add(targetUrl);
            log.warning('Response has no usable vehicle data; browser refresh may be required');
        }
        await pushUniqueRecords(records, state, extractionMethod);
    }
}

export async function main() {
    try {
        // Re-read the documented request flow before any request so recovery
        // decisions always start from the current API structure.
        await readDiscovery(log);
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
            proxyConfiguration: proxyConfigInput,
            results_wanted: resultsWantedRaw = 20,
            max_pages: maxPagesRaw = 10,
        } = input;

        const resultsWanted = positiveInteger(resultsWantedRaw, 'results_wanted');
        const maxPages = positiveInteger(maxPagesRaw, 'max_pages');
        const transportConfig = resolveTransportConfig(input);

        const normalizeStartUrl = (entry) => {
            if (!entry) return undefined;
            if (typeof entry === 'string') return entry;
            if (entry && typeof entry === 'object' && typeof entry.url === 'string') return entry.url;
            return undefined;
        };

        const hasFilters = [make, model, year_min, year_max, price_min, price_max, mileage_max, location]
            .some((value) => value !== undefined && value !== null && String(value).trim() !== '');

        const initial = [];
        // A custom URL wins, then filters, then the documented default URL. A
        // schema-defaulted URL must never override a caller's filter search.
        if (Array.isArray(startUrls)) {
            for (const candidate of startUrls) {
                const normalized = normalizeStartUrl(candidate);
                if (normalized) initial.push(validateTarget(normalized));
            }
        }
        for (const candidate of [url, startUrl]) {
            if (candidate?.trim() && !(hasFilters && candidate.trim() === DEFAULT_START_URL)) initial.push(validateTarget(candidate));
        }
        if (!initial.length) {
            initial.push(hasFilters
                ? buildSearchApiUrl({ make, model, year_min, year_max, price_min, price_max, mileage_max, location })
                : DEFAULT_START_URL);
        }

        const proxyInput = proxyConfigInput ?? { useApifyProxy: false };
        const shouldCreateProxy = (proxyInput.proxyUrls?.length > 0)
            || (proxyInput.useApifyProxy !== false && (IS_AT_HOME || transportConfig.requestTransport === 'apify_proxy_http'));
        const proxyConfiguration = shouldCreateProxy ? await Actor.createProxyConfiguration(proxyInput) : undefined;
        if (transportConfig.requestTransport === 'apify_proxy_http' && !proxyConfiguration) {
            throw new Error('apify_proxy_http requires an enabled proxyConfiguration');
        }
        transportConfig.sessions = new HttpSessions(transportConfig, proxyConfiguration);

        const state = {
            saved: 0,
            resultsWanted,
            maxPages,
            seenKeys: new Set(),
            visitedTargets: new Set(),
            failedTargets: new Set(),
        };

        log.info(`Starting Carfax actor | limit=${resultsWanted}`);
        log.debug(`Transport: ${transportConfig.requestTransport}; profiles: ${transportConfig.headerProfiles.join(', ')}`);

        await runHttpDiscovery(initial, transportConfig, state);

        log.info(`Finished. Total saved: ${state.saved} vehicles`);
        if (!state.saved) throw new Error('No vehicle records extracted. Review API_DISCOVERY.md and the current target/proxy response.');
        if (state.saved < resultsWanted) {
            log.warning(`Collected ${state.saved} of ${resultsWanted} requested vehicles; the source returned no more.`);
        }
    } catch (error) {
        log.error(safeError(error));
        await Actor.exit({ exitCode: 1 });
        return;
    }
    await Actor.exit();
}

function positiveInteger(value, name) {
    if (!Number.isInteger(Number(value)) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
    return Number(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await Actor.init();
    await main();
}

export { collectRecordsAndTargets, resolveTransportConfig, tryHttpRequestVariants, pushUniqueRecords };
