import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { Actor } from 'apify';

import { collectRecordsAndTargets, main, resolveTransportConfig } from '../src/main.js';
import { autoProfileRotation, DEFAULT_START_URL, fetchWithRecovery, getHeaderProfiles, HttpSessions, isBlocked, newProxyUrl, retryDelay, validateTarget } from '../src/transport.js';

const logger = { debug() {}, warning() {} };
const vehicle = (vin = '1HGCM82633A004352') => ({ vin, year: 2021, make: 'Honda', model: 'Accord', listPrice: 21000, mileage: 30000, noAccidents: false });

test('503 and 429 recover within budget and honor Retry-After', async () => {
    const responses = [
        { statusCode: 503, headers: {} },
        { statusCode: 429, headers: { 'retry-after': '2' } },
        { statusCode: 200, headers: {} },
    ];
    const waits = [];
    let retired = 0;
    const result = await fetchWithRecovery(async () => responses.shift(), {
        log: logger, retire: () => retired++, wait: async (ms) => waits.push(ms),
    });
    assert.equal(result.statusCode, 200);
    assert.equal(retired, 1);
    assert.equal(waits[1], 2000);
    assert.equal(retryDelay('300', 0), 10000);
});

test('permanent 404 is not retried and network errors exhaust three attempts', async () => {
    let calls = 0;
    const options = { log: logger, retire() {}, wait: async () => {} };
    assert.equal((await fetchWithRecovery(async () => { calls++; return { statusCode: 404 }; }, options)).statusCode, 404);
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(fetchWithRecovery(async () => { calls++; throw new Error('connection reset'); }, options), /3 attempts/);
    assert.equal(calls, 3);
});

test('challenge detection accepts normal pages containing a DataDome script', () => {
    assert.equal(isBlocked(200, '<script src="datadome.js"></script><h1>Cars</h1>'), false);
    assert.equal(isBlocked(200, '<title>Access denied</title>'), true);
    assert.equal(isBlocked(403, 'cars'), true);
});

test('vehicle mapping handles nested envelopes and rejects filter metadata', () => {
    const { records } = collectRecordsAndTargets({ json: { data: { inventory: [vehicle()], filters: { make: 'Honda' } } } }, 'test');
    assert.equal(records.length > 0, true);
    assert.ok(records.every((record) => record.vin));
    assert.equal(records[0].price, 21000);
    assert.equal(records[0].no_accidents, false);
    assert.equal(collectRecordsAndTargets({ json: { make: 'Honda', model: 'Accord' } }, 'test').records.length, 0);
});

test('Unblocker has no session; Residential uses a fresh identity', async () => {
    const seen = [];
    const proxy = { groups: ['UNBLOCKER'], newUrl: async (...args) => { seen.push(args); return 'url'; } };
    await newProxyUrl(proxy);
    assert.deepEqual(seen[0], []);
    proxy.groups = ['RESIDENTIAL'];
    await newProxyUrl(proxy);
    await newProxyUrl(proxy);
    assert.notEqual(seen[1][0], seen[2][0]);
});

test('auto header rotation is a bounded, deduplicated set of installed profiles', () => {
    const rotation = autoProfileRotation();
    assert.ok(rotation.includes('chrome'));
    assert.equal(new Set(rotation).size, rotation.length);
    assert.ok(rotation.length >= 2 && rotation.length <= 4);
    assert.deepEqual(getHeaderProfiles('firefox'), ['firefox']);
    assert.deepEqual(getHeaderProfiles('mobile_app'), ['mobile_app']);
    assert.deepEqual(getHeaderProfiles('auto'), rotation);
});

test('target URL validation rejects external hosts, credentials and invalid schemes', () => {
    assert.equal(validateTarget(' https://www.carfax.com/Used-SUVs_bt8?priceMax=15000 '), 'https://www.carfax.com/Used-SUVs_bt8?priceMax=15000');
    for (const url of ['http://www.carfax.com/', 'https://evil.example/', 'https://user:pass@www.carfax.com/']) assert.throws(() => validateTarget(url));
});

test('Impit session retains landing-page cookies and reuses the client', async () => {
    const server = createServer((req, res) => {
        if (req.url === '/bootstrap') res.setHeader('set-cookie', 'session=fresh; Path=/; HttpOnly');
        res.end(req.headers.cookie || '');
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const sessions = new HttpSessions({ requestTransport: 'direct_http', requestTimeoutSecs: 5 });
        const client = await sessions.get('chrome');
        assert.equal(await sessions.get('chrome'), client);
        const base = `http://127.0.0.1:${server.address().port}`;
        await (await client.fetch(`${base}/bootstrap`)).text();
        assert.equal(await (await client.fetch(`${base}/api`)).text(), 'session=fresh');
        sessions.retire('chrome');
        assert.notEqual(await sessions.get('chrome'), client);
    } finally { await new Promise((resolve) => { server.close(resolve); }); }
});

test('actor uses selected input mode, deduplicates batches, caps results and fails on invalid payload', async () => {
    const original = { getInput: Actor.getInput, pushData: Actor.pushData, exit: Actor.exit };
    let input;
    let rows = [];
    const exits = [];
    const requests = [];
    let malformed = false;
    const server = createServer((req, res) => {
        requests.push(new URL(req.url, 'http://localhost').searchParams.get('url'));
        res.setHeader('content-type', 'application/json');
        res.end(malformed ? '{"unexpected":"schema changed"}' : JSON.stringify({ data: { vehicles: [vehicle(), vehicle(), vehicle('1HGCM82633A004353')] } }));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const config = { proxyConfiguration: { useApifyProxy: false }, results_wanted: 1 };
    const savedEnv = { url: process.env.CARFAX_REQUEST_API_URL };
    process.env.CARFAX_REQUEST_API_URL = `http://127.0.0.1:${server.address().port}/fetch`;
    Actor.getInput = async () => input;
    Actor.pushData = async (batch) => rows.push(...batch);
    Actor.exit = async (options) => exits.push(options?.exitCode || 0);
    try {
        input = { ...config, startUrl: 'https://www.carfax.com/Used-SUVs_bt8' };
        await main();
        assert.equal(rows.length, 1);
        assert.equal(requests.at(-1), input.startUrl);
        input = { ...config, startUrl: DEFAULT_START_URL, make: 'Honda', model: 'Accord', location: '10001' };
        await main();
        assert.equal(requests.at(-1), 'https://helix.carfax.com/search/v2/vehicles?make=Honda&model=Accord&zip=10001&vehicleCondition=USED&rows=100&sort=BEST&page=1');
        input = { ...config };
        await main();
        assert.equal(requests.at(-1), DEFAULT_START_URL);
        rows = [];
        malformed = true;
        await main();
        assert.equal(exits.at(-1), 1);
        assert.equal(rows.length, 0);
        input = { ...config, results_wanted: 0 };
        await main();
        assert.equal(exits.at(-1), 1);
    } finally {
        Object.assign(Actor, original);
        if (savedEnv.url === undefined) delete process.env.CARFAX_REQUEST_API_URL;
        else process.env.CARFAX_REQUEST_API_URL = savedEnv.url;
        await new Promise((resolve) => { server.close(resolve); });
    }
});

test('default transport leaves a caller disabled proxy disabled', () => {
    assert.equal(resolveTransportConfig({ proxyConfiguration: { useApifyProxy: false } }).requestTransport, 'direct_http');
});
