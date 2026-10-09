import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';

import { collectRecordsAndTargets } from '../src/main.js';
import { DEFAULT_START_URL, isBlocked, safeTarget } from '../src/transport.js';

// Derive the full profile set from the installed release, rather than a stale list.
const types = await readFile(new URL('../node_modules/impit/index.d.ts', import.meta.url), 'utf8');
const union = types.match(/export type Browser\s*=([\s\S]*?);/)[1];
const installedProfiles = [...union.matchAll(/'([^']+)'/g)].map((match) => match[1]);

// Optional subset so a single working profile can be rechecked quickly.
const requested = (process.env.CARFAX_PROBE_PROFILES || '')
    .split(',')
    .map((profile) => profile.trim())
    .filter(Boolean);
const profiles = requested.length ? requested : installedProfiles;

const target = process.env.CARFAX_PROBE_URL || DEFAULT_START_URL;
const proxyUrl = process.env.CARFAX_PROBE_PROXY_URL?.trim() || undefined;
const context = proxyUrl ? 'proxy HTTP' : 'local direct HTTP, no proxy';

const results = [];
for (const profile of profiles) {
    const started = Date.now();
    const client = new Impit({ browser: profile, cookieJar: new CookieJar(), timeout: 10000, ...(proxyUrl && { proxyUrl }) });
    try {
        const response = await client.fetch(target);
        const text = await response.text();
        const blocked = isBlocked(response.status, text);
        let json;
        try { json = JSON.parse(text); } catch { /* HTML is a supported source. */ }
        const { records } = collectRecordsAndTargets({ text, json }, `probe_${profile}`);
        results.push({
            profile,
            status: response.status,
            contentType: response.headers.get('content-type'),
            blocked,
            records: records.length,
            usable: response.ok && !blocked && records.length > 0,
            elapsedMillis: Date.now() - started,
        });
    } catch (error) {
        results.push({ profile, usable: false, error: error.name, elapsedMillis: Date.now() - started });
    }
    process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
}
await mkdir('qa-artifacts', { recursive: true });
await writeFile('qa-artifacts/impit-profiles.json', JSON.stringify({
    testedAt: new Date().toISOString(), target: safeTarget(target), context, results,
}, null, 2));
process.stdout.write(`Profiles tested: ${results.length}; usable: ${results.filter((result) => result.usable).length}\n`);
