## What does Carfax Used Cars Scraper do?

Carfax Used Cars Scraper collects used vehicle listings from Carfax.com and saves them as a clean, structured dataset. Give it a Carfax search URL, a make and model, or a set of filters such as year, price, mileage, and ZIP code, and it returns vehicle details including price, mileage, VIN, engine, transmission, drive type, dealer information, and vehicle history indicators. It is built for used car market research, inventory monitoring, price comparison, and automotive data pipelines.

## Why use Carfax Used Cars Scraper?

- **Structured vehicle data** - Turn Carfax search results into ready-to-use records instead of copying listings by hand.
- **Flexible search** - Start from any Carfax search URL, or search by make, model, location, and filters.
- **Rich, decision-ready fields** - Capture pricing, mileage, dealer details, colors, specs, images, and history flags in one run.
- **Fast and reliable** - Results are saved in batches as they are found, and the Actor manages retries and recovery on its own.
- **Automation ready** - Export to JSON, CSV, Excel, or XML, or send results to Google Sheets, webhooks, Make, Zapier, or your own API.
- **Schedule friendly** - Run on demand or on a schedule to keep a fresh picture of available inventory.

## What data can you extract from Carfax?

| Field | Description |
|-------|-------------|
| `title` | Full vehicle title, such as 2024 Ford F-150 XLT |
| `price` | Listed price in USD |
| `list_price` | Original or list price when published |
| `one_price` | One-price value or price comparison when shown |
| `mileage` | Odometer reading |
| `vin` | Vehicle Identification Number |
| `year` | Model year |
| `make` | Vehicle make |
| `model` | Vehicle model |
| `trim` | Trim level |
| `body_type` | Body style, such as Pickup or SUV |
| `vehicle_condition` | Condition label, such as Used |
| `exterior_color` | Exterior color |
| `interior_color` | Interior color |
| `engine` | Engine description |
| `transmission` | Transmission type |
| `drivetype` | Drive configuration, such as FWD, AWD, or 4WD |
| `mpg_city` | Estimated city fuel economy |
| `mpg_highway` | Estimated highway fuel economy |
| `dealer_name` | Selling dealer name |
| `dealer_city` | Dealer city |
| `dealer_state` | Dealer state |
| `dealer_zip` | Dealer ZIP code |
| `dealer_phone` | Dealer phone number |
| `distance_to_dealer` | Approximate distance when available |
| `badge` | Deal or value badge, such as Great Value |
| `one_owner` | One-owner history indicator |
| `no_accidents` | No-accident history indicator |
| `service_records` | Service history indicator |
| `image_url` | Primary listing image URL |
| `images` | Additional listing image URLs |
| `monthly_payment_estimate` | Estimated monthly financing values |
| `price_history` | Historical price change entries |
| `top_options` | Highlighted features and options |
| `other_options` | Additional features and options |
| `url` | Direct link to the vehicle listing |
| `source` | Source website, `carfax.com` |
| `scraped_at` | ISO timestamp for when the record was collected |

## How to use Carfax Used Cars Scraper

1. Open the Actor on Apify Store.
2. Enter a Carfax search URL, or provide a make and model with optional filters.
3. Set the maximum number of vehicles and, if needed, the page limit.
4. Run the Actor.
5. Download the dataset, or connect it to a spreadsheet, webhook, or workflow.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | No | `https://www.carfax.com/Used-Pickups_bt6` | A Carfax search URL. A custom URL takes priority over filters |
| `location` | String | No | - | ZIP code or location to search near; used with make and model |
| `make` | String | No | - | Vehicle make, such as Ford or Toyota |
| `model` | String | No | - | Vehicle model, such as F-150 or Camry |
| `year_min` | Integer | No | - | Minimum model year |
| `year_max` | Integer | No | - | Maximum model year |
| `price_min` | Integer | No | - | Minimum price in USD |
| `price_max` | Integer | No | - | Maximum price in USD |
| `mileage_max` | Integer | No | - | Maximum mileage |
| `results_wanted` | Integer | No | `20` | Maximum number of vehicles to save |
| `max_pages` | Integer | No | `10` | Safety cap on the number of result pages to visit |
| `proxyConfiguration` | Object | No | Disabled | Optional Apify Proxy settings. Unblocker is recommended when enabled |

## Usage Examples

### Collect vehicles from a search URL

Collect listings from a Carfax category page:

```json
{
  "startUrl": "https://www.carfax.com/Used-Pickups_bt6",
  "results_wanted": 50
}
```

### Search by make and model

Collect Ford F-150 listings with a model year and price range:

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

### Search by location and filters

Collect Toyota vehicles near a ZIP code within a price and mileage range:

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

### Use a proxy for larger or repeated runs

Enable Apify Proxy and choose the Unblocker group when you need the highest reliability:

```json
{
  "startUrl": "https://www.carfax.com/Used-Pickups_bt6",
  "results_wanted": 200,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["UNBLOCKER"]
  }
}
```

## Sample Output

```json
{
  "vin": "1FTFW1E87NFA12345",
  "title": "2024 Ford F-150 XLT",
  "year": 2024,
  "make": "Ford",
  "model": "F-150",
  "trim": "XLT",
  "body_type": "Pickup",
  "vehicle_condition": "USED",
  "price": 45990,
  "list_price": 46490,
  "currency": "USD",
  "mileage": 12500,
  "mileage_label": "12,500",
  "badge": "GREAT",
  "stock_number": "N6T388A",
  "image_url": "https://carfax-img.vast.com/carfax/.../1/344x258",
  "url": "https://www.carfax.com/vehicle/1FTFW1E87NFA12345",
  "dealer_name": "Example Motors",
  "dealer_city": "Columbus",
  "dealer_state": "GA",
  "dealer_zip": "31901",
  "dealer_phone": "7065550101",
  "distance_to_dealer": 0,
  "exterior_color": "Blue",
  "interior_color": "Black",
  "engine": "6 Cyl",
  "transmission": "Automatic",
  "drivetype": "Four-Wheel Drive",
  "mpg_city": 18,
  "mpg_highway": 24,
  "one_owner": true,
  "no_accidents": true,
  "service_records": true,
  "top_options": ["Tow Package", "Heated Seats"],
  "scraped_at": "2026-01-21T13:30:00.000Z",
  "source": "carfax.com"
}
```

## Tips for Best Results

- **Start with the defaults** - The default result limit is a quick way to confirm the Actor works before larger runs.
- **Use a search URL for exact results** - Pre-set complex filters on Carfax.com, then use the resulting URL as `startUrl`.
- **Use make and model for broad searches** - Filter searches return many results quickly and page through automatically.
- **Keep the proxy disabled until you need it** - Most runs finish without a proxy; enable Apify Proxy with the Unblocker group if you run into blocks or need greater reliability.
- **Raise limits for bigger jobs** - Increase `results_wanted` and, if needed, `max_pages` to collect more vehicles per run.
- **Check a few records first** - Some fields are empty when Carfax does not publish them, so review several results before assuming a problem.

## Integrations

- **Google Sheets** - Send vehicle listings to a shared spreadsheet for analysis.
- **Webhooks** - Trigger downstream systems when a run finishes.
- **Make and Zapier** - Connect results to no-code automations.
- **API** - Read datasets programmatically from your own tools.
- **Exports** - Download results as JSON, CSV, Excel, XML, and other supported formats.

## Frequently Asked Questions

### How many vehicles can I collect in one run?

You can collect thousands by raising `results_wanted`. For very large jobs, split the work across multiple runs or schedules to stay within proxy and rate limits.

### Can I export the data to CSV or Excel?

Yes. Apify datasets can be downloaded as CSV, Excel, JSON, XML, and other supported formats, and connected to Google Sheets or an API.

### Can I search by make, model, and location?

Yes. Provide `make`, `model`, and `location`, and optionally add year, price, and mileage filters. A custom `startUrl` takes priority over filters.

### Do I need a proxy?

No. No proxy is used by default, and most searches complete without one. If requests are blocked, enable Apify Proxy with the Unblocker group for the highest reliability.

### Can I run this Actor on a schedule?

Yes. Use Apify schedules to run the Actor hourly, daily, weekly, or at another interval to keep your dataset current.

### Why are some fields empty?

Some fields are only present when Carfax publishes that information, such as dealer phone numbers, financing estimates, or history flags. Check multiple records before assuming a problem.

### Is it legal to scrape Carfax?

This Actor is intended for collecting publicly available listing information. You are responsible for complying with Carfax terms of service, applicable laws, and privacy requirements.

## Support

For issues, missing fields, or feature requests, use the Issues tab on the Actor page and include your input and a short description of what you expected.

## Legal Notice

This Actor is provided for legitimate collection of publicly available information. Users are responsible for ensuring their use complies with Carfax terms of service and all applicable laws.
