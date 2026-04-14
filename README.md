# Carfax Used Cars Scraper

Extract comprehensive used car listings from Carfax.com with detailed vehicle information, Carfax history reports, and pricing data.

---

## Features

- **Complete Vehicle Data** - Scrape title, price, mileage, VIN, engine specs, transmission, and drive type
- **Vehicle History Signals** - Capture one-owner, no-accident, and service-record indicators when available
- **Flexible Filtering** - Search by make, model, year range, price range, mileage, and location
- **Custom Start URLs** - Provide any Carfax search URL to scrape specific results
- **Pagination Handling** - Automatically navigates through multiple pages of results
- **Clean Output Quality** - Removes duplicate entries and omits empty fields from exported records
- **Transport Selection** - Switch between direct HTTP, Apify Proxy HTTP, custom request APIs, and Firefox browser fallback
- **Residential Proxy Support** - Built-in proxy configuration for reliable scraping

---

## Use Cases

| Use Case | Description |
|----------|-------------|
| **Market Research** | Analyze used car pricing trends by make, model, and region |
| **Price Comparison** | Compare vehicle prices across different dealers and locations |
| **Inventory Monitoring** | Track available inventory for specific vehicle types |
| **Lead Generation** | Build dealer and vehicle databases for automotive businesses |
| **Data Analytics** | Aggregate vehicle data for machine learning and analysis |

---

## Input Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `startUrl` | string | A specific Carfax search URL to scrape |
| `vin` | string | Optional VIN for direct detail lookup |
| `make` | string | Vehicle make (e.g., "Ford", "Toyota") |
| `model` | string | Vehicle model (e.g., "F-150", "Camry") |
| `year_min` | integer | Minimum model year filter |
| `year_max` | integer | Maximum model year filter |
| `price_min` | integer | Minimum price in USD |
| `price_max` | integer | Maximum price in USD |
| `mileage_max` | integer | Maximum mileage filter |
| `location` | string | Location or ZIP code |
| `results_wanted` | integer | Maximum vehicles to collect (default: 20) |
| `max_pages` | integer | Maximum pages to visit (default: 10) |
| `requestTransport` | string | Request strategy: auto, direct HTTP, Apify Proxy HTTP, custom request API, or Firefox only |
| `headerProfile` | string | Header profile: auto, Firefox, Chrome, mobile web, or mobile app |
| `customHeadersJson` | string | Optional JSON object merged into outbound target headers |
| `requestApiUrlTemplate` | string | Optional external request API URL with `{url}` placeholder or target URL parameter |
| `requestApiMethod` | string | Method for the custom request API call (`GET` or `POST`) |
| `requestApiUrlParam` | string | Field name used when the custom request API expects a target URL parameter |
| `requestApiHeadersJson` | string | Optional JSON object of headers sent to the custom request API |
| `useBrowserFallback` | boolean | Whether to retry with Firefox if HTTP methods do not return vehicle data |
| `requestTimeoutSecs` | integer | Per-request timeout in seconds |
| `requestDelayMillis` | integer | Delay between detail requests to reduce rate limiting |
| `proxyConfiguration` | object | Proxy settings |

---

## Output Data

Each scraped vehicle includes the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Full vehicle title (Year Make Model Trim) |
| `price` | integer | Listed price in USD |
| `currency` | string | Currency code (USD) |
| `list_price` | integer | Original listing price when present |
| `one_price` | integer | One-price value when provided |
| `mileage` | integer | Odometer reading |
| `body_type` | string | Vehicle body style |
| `vehicle_condition` | string | Condition label (for example, Used) |
| `vin` | string | Vehicle Identification Number |
| `dealer_city` | string | Dealer city |
| `dealer_state` | string | Dealer state |
| `dealer_zip` | string | Dealer ZIP code |
| `dealer_phone` | string | Dealer phone number |
| `image_url` | string | Primary vehicle image URL |
| `images` | array | Additional listing image URLs |
| `drivetype` | string | Drive configuration (FWD, AWD, 4WD) |
| `engine` | string | Engine specifications |
| `transmission` | string | Transmission type |
| `exterior_color` | string | Exterior color |
| `interior_color` | string | Interior color |
| `mpg_city` | integer | Estimated city MPG |
| `mpg_highway` | integer | Estimated highway MPG |
| `one_owner` | boolean | One-owner indicator |
| `no_accidents` | boolean | No-accident indicator |
| `service_records` | boolean | Service records indicator |
| `monthly_payment_estimate` | object | Estimated financing values |
| `price_history` | array | Historical price change entries |
| `top_options` | array | Top listed options/features |
| `other_options` | array | Additional listed options/features |
| `url` | string | Direct link to vehicle listing |
| `scraped_at` | string | Timestamp of data extraction |
| `source` | string | Source website (carfax.com) |
| `extraction_method` | string | Internal extraction source label |

---

## Usage Examples

### Search by Start URL

```json
{
  "startUrl": "https://www.carfax.com/Used-Pickups_bt6",
  "results_wanted": 50
}
```

### Use a Custom Request API Locally

```json
{
  "startUrl": "https://www.carfax.com/Used-Pickups_bt6",
  "requestTransport": "custom_request_api",
  "requestApiUrlTemplate": "https://your-request-api.example.com/fetch?url={url}",
  "requestApiHeadersJson": "{\"Authorization\":\"Bearer YOUR_TOKEN\"}",
  "headerProfile": "auto",
  "results_wanted": 20
}
```

### Direct VIN Lookup

```json
{
  "vin": "3GKALTEV5KL310415",
  "requestTransport": "apify_proxy_http",
  "headerProfile": "firefox",
  "results_wanted": 1
}
```

### Search by Make and Model

```json
{
  "make": "Ford",
  "model": "F-150",
  "year_min": 2020,
  "year_max": 2024,
  "price_max": 50000,
  "results_wanted": 100
}
```

### Search by Location and Price Range

```json
{
  "make": "Toyota",
  "location": "90210",
  "price_min": 20000,
  "price_max": 35000,
  "mileage_max": 50000,
  "results_wanted": 75
}
```

---

## Sample Output

```json
{
  "title": "2024 Ford F-150 XLT",
  "price": 45990,
  "list_price": 46490,
  "currency": "USD",
  "mileage": 12500,
  "body_type": "Pickup",
  "vin": "1FTFW1E87NFA12345",
  "dealer_city": "Columbus",
  "dealer_state": "GA",
  "dealer_zip": "31901",
  "dealer_phone": "7065550101",
  "image_url": "https://carfax-img.vast.com/carfax/...",
  "images": [
    "https://carfax-img.vast.com/carfax/.../1/344x258",
    "https://carfax-img.vast.com/carfax/.../2/344x258"
  ],
  "drivetype": "Four-Wheel Drive",
  "engine": "6 Cyl",
  "transmission": "Automatic",
  "exterior_color": "Blue",
  "interior_color": "Black",
  "one_owner": true,
  "no_accidents": true,
  "service_records": true,
  "monthly_payment_estimate": {
    "monthlyPayment": 712.18,
    "interestRate": 7.1,
    "termInMonths": 60
  },
  "top_options": ["Tow Package", "Heated Seats"],
  "url": "https://www.carfax.com/vehicle/1FTFW1E87NFA12345",
  "scraped_at": "2026-01-21T13:30:00.000Z",
  "source": "carfax.com",
  "extraction_method": "helix_api"
}
```

---

## Tips for Best Results

1. **Use Residential Proxies** - Carfax has anti-bot protection; residential proxies provide the best success rate
2. **Start with Default Settings** - The default `results_wanted: 20` is optimized for quick runs
3. **Use Start URLs for Specific Searches** - Pre-configure complex filters on Carfax.com and use the resulting URL
4. **Use a Custom Request API Locally** - If direct local requests are blocked, provide your own request API URL in the input or set `CARFAX_REQUEST_API_URL` in the shell before running
5. **Monitor Rate Limits** - Increase `requestDelayMillis` or reduce `results_wanted` when Helix detail requests begin returning `429`

---

## Integrations

Connect your scraped data to other services:

- **Google Sheets** - Export vehicle listings for analysis
- **Slack** - Get notifications when new vehicles match your criteria
- **Zapier** - Automate workflows with scraped data
- **Webhooks** - Send data to your own APIs in real-time
- **Amazon S3** - Store large datasets in cloud storage

---

## FAQ

**Q: How many vehicles can I scrape?**
A: You can scrape thousands of vehicles by adjusting `results_wanted`. For very large jobs, consider using multiple runs.

**Q: Why do I need residential proxies?**
A: Carfax employs anti-bot protection that blocks datacenter IPs. Residential proxies simulate real user traffic.

**Q: Can I use my own request API instead of Apify Proxy?**
A: Yes. Set `requestTransport` to `custom_request_api` and provide `requestApiUrlTemplate` plus any required API headers. For local shell runs you can also set `CARFAX_REQUEST_API_URL` and `CARFAX_REQUEST_API_HEADERS` environment variables.

**Q: Can I scrape specific dealer inventory?**
A: Yes, find the dealer's Carfax page URL and use it as the `startUrl`.

**Q: How often is the data updated?**
A: The scraper extracts live data from Carfax. Run it regularly to get the latest listings.

---

## Legal Notice

This scraper is provided for educational and research purposes. Users are responsible for ensuring their use complies with Carfax's Terms of Service and all applicable laws. The scraper should be used responsibly and ethically.