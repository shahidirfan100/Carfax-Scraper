## API Discovery

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
