# Carfax Used Cars Scraper

Extract comprehensive used car listings from Carfax.com with detailed vehicle information, Carfax history reports, and pricing data.

---

## Features

- **Complete Vehicle Data** - Scrape title, price, mileage, VIN, engine specs, transmission, and drive type
- **Carfax Reports** - Extract damage and accident history directly from listings
- **Flexible Filtering** - Search by make, model, year range, price range, mileage, and location
- **Custom Start URLs** - Provide any Carfax search URL to scrape specific results
- **Pagination Handling** - Automatically navigates through multiple pages of results
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
| `proxyConfiguration` | object | Proxy settings |

---

## Output Data

Each scraped vehicle includes the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Full vehicle title (Year Make Model Trim) |
| `price` | integer | Listed price in USD |
| `currency` | string | Currency code (USD) |
| `mileage` | integer | Odometer reading |
| `vin` | string | Vehicle Identification Number |
| `location` | string | Dealer location |
| `image_url` | string | Primary vehicle image URL |
| `drive_type` | string | Drive configuration (FWD, AWD, 4WD) |
| `engine` | string | Engine specifications |
| `transmission` | string | Transmission type |
| `damage_report` | string | Carfax accident/damage history |
| `url` | string | Direct link to vehicle listing |
| `scraped_at` | string | Timestamp of data extraction |
| `source` | string | Source website (carfax.com) |

---

## Usage Examples

### Search by Start URL

```json
{
  "startUrl": "https://www.carfax.com/Used-Pickups_bt6",
  "results_wanted": 50
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
  "currency": "USD",
  "mileage": 12500,
  "vin": "1FTFW1E87NFA12345",
  "location": "Columbus, GA",
  "image_url": "https://carfax-img.vast.com/carfax/...",
  "drive_type": "Four-Wheel Drive",
  "engine": "6 Cyl",
  "transmission": "Automatic",
  "damage_report": "No Accident or Damage Reported",
  "url": "https://www.carfax.com/vehicle/1FTFW1E87NFA12345",
  "scraped_at": "2026-01-21T13:30:00.000Z",
  "source": "carfax.com"
}
```

---

## Tips for Best Results

1. **Use Residential Proxies** - Carfax has anti-bot protection; residential proxies provide the best success rate
2. **Start with Default Settings** - The default `results_wanted: 20` is optimized for quick runs
3. **Use Start URLs for Specific Searches** - Pre-configure complex filters on Carfax.com and use the resulting URL
4. **Monitor Rate Limits** - For large scraping jobs, consider running multiple smaller batches

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

**Q: Can I scrape specific dealer inventory?**
A: Yes, find the dealer's Carfax page URL and use it as the `startUrl`.

**Q: How often is the data updated?**
A: The scraper extracts live data from Carfax. Run it regularly to get the latest listings.

---

## Legal Notice

This scraper is provided for educational and research purposes. Users are responsible for ensuring their use complies with Carfax's Terms of Service and all applicable laws. The scraper should be used responsibly and ethically.