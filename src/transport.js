import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';

export const DEFAULT_START_URL = 'https://www.carfax.com/Used-Pickups_bt6';
export const PROFILE_ALIASES = { chrome: 'chrome', firefox: 'firefox', mobile_web: 'ios18', mobile_app: 'okhttp4' };

let cachedImpitProfiles;
// Derive the supported profile set from the installed release so new impit
// versions self-heal without a hardcoded, stale list.
function installedImpitProfiles() {
    if (cachedImpitProfiles) return cachedImpitProfiles;
    const fallback = ['chrome', 'firefox'];
    try {
        const types = readFileSync(new URL('../node_modules/impit/index.d.ts', import.meta.url), 'utf8');
        const union = types.match(/export type Browser\s*=([\s\S]*?);/)?.[1] ?? '';
        const found = [...union.matchAll(/'([^']+)'/g)].map((match) => match[1]);
        cachedImpitProfiles = found.length ? found : fallback;
    } catch {
        cachedImpitProfiles = fallback;
    }
    return cachedImpitProfiles;
}

const profileVersion = (name) => Number(String(name).replace(/\D/g, '')) || 0;

// Bounded rotation across current, coherent TLS fingerprints. Newest profiles
// for each engine go first so a blocked fingerprint is retired and replaced.
export function autoProfileRotation() {
    const installed = installedImpitProfiles();
    const newest = (prefix) => installed
        .filter((name) => name.startsWith(prefix) && /\d$/.test(name))
        .sort((left, right) => profileVersion(right) - profileVersion(left))[0];
    const ordered = ['chrome', newest('chrome'), 'firefox', newest('firefox')];
    const rotation = [...new Set(ordered)].filter((name) => name && installed.includes(name));
    return rotation.length ? rotation : ['chrome', 'firefox'];
}

export function getHeaderProfiles(profile) {
    if (!profile || profile === 'auto') return autoProfileRotation();
    return [profile];
}

export function safeTarget(value) {
    try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
    } catch { return 'configured target'; }
}

export function validateTarget(value) {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'https:' || !['www.carfax.com', 'carfax.com', 'helix.carfax.com'].includes(url.hostname)
        || url.username || url.password) throw new Error('Use an HTTPS Carfax URL without credentials');
    url.hash = '';
    return url.toString();
}

export function isBlocked(status, text = '') {
    return [401, 403, 429].includes(status)
        || /<title>[^<]*(?:access denied|robot|captcha|blocked)|geo\.captcha-delivery\.com|please (?:enable js|verify you are human)|"url"\s*:\s*"https:\/\/[^"\s]*captcha-delivery/i.test(text);
}

export function retryDelay(value, attempt, now = Date.now()) {
    let parsed = Number.NaN;
    if (value !== undefined && value !== null && value !== '') {
        const seconds = Number(value);
        parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    }
    return Math.min(10000, Math.max(0, Number.isFinite(parsed) ? parsed : 500 * (2 ** attempt) + Math.random() * 250));
}

export async function readDiscovery(log) {
    // Read the known request flow before diagnosing or rotating a failed session.
    const contents = await readFile(new URL('../API_DISCOVERY.md', import.meta.url), 'utf8');
    if (!contents.trim()) throw new Error('API_DISCOVERY.md is empty');
    log.debug('Read API_DISCOVERY.md before request recovery');
    return contents;
}

export async function newProxyUrl(proxyConfiguration) {
    if (!proxyConfiguration) return undefined;
    const unblocker = proxyConfiguration.groups?.includes('UNBLOCKER');
    return unblocker
        ? proxyConfiguration.newUrl()
        : proxyConfiguration.newUrl(`carfax_${randomUUID().replaceAll('-', '')}`);
}

export class HttpSessions {
    constructor(config, proxyConfiguration) {
        this.config = config;
        this.proxyConfiguration = proxyConfiguration;
        this.sessions = new Map();
    }

    retire(profile) { this.sessions.delete(profile); }

    async get(profile) {
        if (!this.sessions.has(profile)) {
            const unblocker = this.proxyConfiguration?.groups?.includes('UNBLOCKER');
            const proxyUrl = this.config.requestTransport === 'apify_proxy_http'
                ? await newProxyUrl(this.proxyConfiguration) : undefined;
            this.sessions.set(profile, new Impit({
                browser: PROFILE_ALIASES[profile] || profile,
                timeout: this.config.requestTimeoutSecs * 1000,
                ...(!unblocker && { cookieJar: new CookieJar() }),
                ...(proxyUrl && { proxyUrl }),
                // Unblocker routes through a managed proxy that presents its own
                // certificate; scope the exception to this explicit path only.
                ...(unblocker && { ignoreTlsErrors: true }),
            }));
        }
        return this.sessions.get(profile);
    }
}

export async function fetchWithRecovery(operation, { log, retire, wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) }) {
    for (let attempt = 0; attempt < 3; attempt++) {
        let response;
        try {
            response = await operation();
        } catch (error) {
            await readDiscovery(log);
            if (attempt === 2) throw new Error('Request transport failed after 3 attempts', { cause: error });
            await retire();
            log.warning(`Temporary transport failure; retry ${attempt + 1}/2`);
            await wait(retryDelay(undefined, attempt));
            continue;
        }
        if (response.statusCode !== 429 && response.statusCode < 500) return response;
        await readDiscovery(log);
        if (attempt === 2) return response;
        log.warning(`HTTP ${response.statusCode}; retry ${attempt + 1}/2`);
        await wait(retryDelay(response.headers['retry-after'], attempt));
        // 429 keeps the session and honors Retry-After. A broken proxy needs fresh state.
        if (response.statusCode >= 500) await retire();
    }
    throw new Error('Request retry budget exhausted');
}
