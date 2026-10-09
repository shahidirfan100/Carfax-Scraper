## API Discovery

### Current evidence and recovery contract (2026-10-09)

Read this file before every failure investigation. The older discovery notes below are historical, not proof of current target access.

- Baseline: local `got-scraping` with Chrome headers returned HTTP 403 for `https://www.carfax.com/Used-Pickups_bt6`. The old actor exited 0 with zero records. This is a failure, not a successful QA run.
- Impit 0.14.5: all 23 supported profiles were enumerated from the installed `Browser` type and tested against that same category URL without a proxy on 2026-10-09. Every profile returned HTTP 403 with zero vehicle records, so the local network is IP-blocked and the TLS profile alone is not the deciding factor here. Set `CARFAX_PROBE_PROXY_URL` to rerun the full matrix through a proxy, and `CARFAX_PROBE_PROFILES` to recheck one profile. The JSON matrix is in local `qa-artifacts/impit-profiles.json`; rerun `npm run probe:profiles` to refresh it.
- Listing API verified on 2026-10-09: `GET https://helix.carfax.com/search/v2/vehicles` returns JSON vehicle records over plain HTTP and supports `make`, `model`, `zip`, `yearMin`, `yearMax`, `priceMin`, `priceMax`, `mileageMax`, `vehicleCondition=USED`, `sort=BEST`, `rows` (100 works) and `page` (page 2 returns different VINs). This is the primary listing source for make/model/filter searches and satisfies large `results_wanted` limits without a browser. The `{vin}` path form remains the per-vehicle detail reference. Aggregates/recommendations live on `helix.carfax.com/rnr/api/vehicles/v3/aggregates/get/by/key` and the page recipe on `helix.carfax.com/recipe/v2/onPage/{slug}`; these are not required for listing extraction.
- Runtime HTTP uses Impit's own profile headers and a cookie jar per profile/proxy identity. Endpoint origin/referer and caller headers are preserved. The automatic rotation is derived at runtime from the installed impit release, ordered as newest Chrome then newest Firefox, and de-duplicated to at most four fingerprints. A blocked fingerprint is retired and replaced by the next one, so a profile that starts failing is dropped without a code change. Mobile aliases map to `ios18` and `okhttp4` only when selected explicitly.
- Network failures, HTTP 429 and 5xx get at most three attempts. Retry-After is capped at ten seconds. Permanent 4xx are not retried. Blocks retire the profile/session before the next strategy.
- The browser fallback was removed on 2026-10-09 once HTTP-only extraction was verified for all search modes. The actor is HTTP-only (impit); no Playwright or Patchright dependency remains, and the base image is the lightweight `apify/actor-node`. Category and other `www.carfax.com` URLs yield the server-rendered first page; make/model/location/filter searches page the listing API up to `results_wanted`.
- HTTP keeps one cookie jar per profile/proxy identity. Residential sessions rotate per attempt; Unblocker receives no session ID and HTTP cookie persistence is disabled for that group. The caller's selected proxy object is passed to Apify unchanged; groups are never silently escalated.
- Zero vehicle records cause a nonzero exit. Non-empty batches are saved immediately. When fewer than `results_wanted` are collected, the actor logs a warning rather than failing. The record mapper and dataset field names are preserved; filter metadata without a VIN or vehicle URL/title is rejected.
- Ten local recovery/input/output tests pass. These checks do not establish live Carfax access on their own.
- Proxy matrix verified on 2026-10-09 (actor `just_martin/carfax-scraper-resilience-qa`): the listing/search API and category SSR extraction both return 200 with **no proxy**, RESIDENTIAL, and UNBLOCKER. Browser-based recovery is only verified with UNBLOCKER; without a proxy or with RESIDENTIAL the browser receives a DataDome challenge. Because HTTP extraction covers normal runs, the proxy is now disabled by default and enabled by user choice.
- Cloud verification on 2026-10-09 (actor `just_martin/carfax-scraper-resilience-qa`, Apify Proxy RESIDENTIAL):
  - HTTP profiles: `chrome` reached 200 on one run and 403 on a later run; `chrome151`, `mobile_web` (`ios18`) and `mobile_app` (`okhttp4`) reached 200; `firefox` returned 403. The automatic rotation handled the flaky `chrome` block by retiring it and succeeding on `chrome151` in the same run (20/20 records).
  - A browser fallback (since removed) was challenged by DataDome with RESIDENTIAL; with UNBLOCKER it worked only after scoping a TLS exception to that group. HTTP-only extraction does not need that path.
  - Default prefilled run (startUrl `Used-Pickups_bt6`, `results_wanted` 20) finished Succeeded with a non-empty dataset in about two seconds.
  - HTTP-only verification on 2026-10-09: make/model search paged the listing API to 200/200 in about five seconds with no proxy; location and filter searches returned the requested records.

Acceptance: lint and schema validation, bounded recovery tests, exact result limits/deduplication, URL/filter/VIN/default isolation, and a fresh cloud run with real non-empty output. Passing the first checks alone does not establish Apify Store QA success.

### 1. Existing actor audit
Current actor (`src/main.js`) extracted vehicle data mainly from in-page MobX state (`window.__MOBX_STATE__`) and DOM fallback.

Current extracted fields:
- `vin`
- `title`
- `year`
- `make`
- `model`
- `trim`
- `price`
- `currency`
- `mileage`
- `mileage_label`
- `badge`
- `image_url`
- `url`
- `dealer_name`
- `distance_to_dealer`
- `stock_number`
- `scraped_at`
- `source`
- `extraction_method`

Missing/underused fields available in richer listing payloads:
- financing (`monthlyPaymentEstimate`)
- dealer metadata (`dealerCity`, `dealerState`, `dealerZip`, `dealerPhone`)
- history flags (`oneOwner`, `noAccidents`, `serviceRecords`)
- feature arrays (`topOptions`, `otherOptions`, `images`)
- price history (`priceHistory`)

### 2. URLScan discovery
- Domain search used: `https://urlscan.io/api/v1/search/?q=domain:carfax.com`
- Result parsing identified only blocked traces (DataDome interstitial)
- Public scan submission attempt to `https://urlscan.io/api/v1/scan/` returned `401 Unauthorized` in this environment

Conclusion: URLScan provided insufficient actionable API request coverage for listing pages in this environment.

### 3. Parallel JSON source checks
- Legacy generic route `https://www.carfax.com/Used-Cars` is not a reliable search entry point and returns an error page in wrapper-based fetches.
- Valid category/listing entry points include routes such as:
  - `https://www.carfax.com/Used-Pickups_bt6`
  - `https://www.carfax.com/Used-SUVs_bt8`
  - `https://www.carfax.com/Used-Cars-Under-10000_f6`
- Direct Carfax and Helix API calls from local environment still returned `403` due anti-bot protection even after testing Firefox, Chrome, mobile web, and mobile app style headers.
- Public references confirm CARFAX data endpoints on `helix.carfax.com`, including:
  - `https://helix.carfax.com/search/v2/vehicles/{vin}` (vehicle detail JSON)

### 3A. Header profile findings
- Direct local requests with Firefox-style headers: blocked (`403`)
- Direct local requests with Chrome-style headers: blocked (`403`)
- Direct local requests with mobile web headers: blocked (`403`)
- Direct local requests with mobile app headers: blocked (`403`)

Conclusion: headers alone are insufficient in this environment.

### 3B. Custom request API findings
- The actor's custom request API path was validated with a stand-in wrapper service.
- A wrapper service can successfully fetch listing/category pages and expose discoverable VIN/detail references.
- To be useful for production extraction, the custom request API must return either real HTML, raw JSON, or a JSON envelope containing `html`, `body`, `content`, `data`, `result`, or `response`.
- Wrapper services that return markdown-only summaries or error pages will not yield full vehicle records.

### 4. Selected API
- Endpoint family: `https://helix.carfax.com/search/v2/*`
- Method: `GET`
- Auth: No explicit token, but anti-bot checks require browser-acquired session/cookies in many environments
- Pagination: Server-side paging exists for search/listing payloads; actor additionally controls pagination via result pages
- Fields available: rich vehicle/dealer/price/history fields (>25 unique keys per record in known payload samples)
- Fields currently missing in actor: financing/dealer/history/options arrays and nested details

Field count comparison:
- Existing normalized output: ~16 primary listing fields
- Selected API payload availability: >25 direct fields (+ nested objects/arrays)

### 5. Candidate ranking
- URLScan-discovered DataDome interstitial endpoint: rejected (not listing data)
- Helix `search/v2` JSON family: selected

Score (`search/v2` family):
- Returns JSON directly: +30
- >15 unique fields: +25
- No explicit auth key: +20
- Pagination support: +15
- Extends current fields: +10
- Total: 100

### 6. Why browser fallback is required
Direct HTTP requests to selected Helix endpoints are blocked in local environment (`403`) unless a capable upstream request API or cloud proxy context is used.
Per updater flow, implementation uses Playwright Firefox only to establish valid runtime context, then extracts from API JSON responses (not DOM-first scraping).

### 7. Implementation decision
- Extend input schema with request transport selection, custom request API inputs, header profile selection, VIN lookup, timeout, and pacing controls
- Prefer valid listing/category pages such as `Used-Pickups_bt6` over the legacy `Used-Cars` default
- Support HTTP-first extraction through direct HTTP, Apify Proxy HTTP, or a user-provided request API
- Keep Firefox browser fallback for cases where HTTP transport still fails
- Capture and parse `helix.carfax.com/search/v2/*` JSON responses when available
- Deduplicate by VIN/URL and strip null/empty fields before dataset push
