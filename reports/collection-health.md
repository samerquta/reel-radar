# REEL RADAR — Collection Health & Data Completeness Report

- **Generated At (UTC):** `2026-10-27T20:12:52.512Z`
- **Research Period:** `2021-04-09 to 2026-10-27`
- **Total Tracked Accounts:** 412 (Active: 9, Candidate: 403, Excluded: 0)
- **Total Stored Reels:** 439

## 1. Metric & Metadata Completeness

| Field | Missing Count | Completeness % | Notes |
| :--- | :--- | :--- | :--- |
| Views / Plays | 0 / 439 | 100.0% | Required for outlier ratio |
| Likes | 18 / 439 | 95.9% | Used for engagement rate |
| Shares | 34 / 439 | 92.3% | Optional separate virality signal |
| Published Timestamp | 0 / 439 | 100.0% | Required for recency decay |
| Spoken Transcript | 439 / 439 | 0.0% | Optional; never inferred when absent |

## 2. Stale Active Accounts (>7 Days Since Last Scan)

- `@anthropicai` (https://www.instagram.com/anthropicai/) — Last scanned: `Never`

## 3. Recent Research Runs & Provider Failures

| Run ID | Provider | Mode | Status | Started At | Discovered | Inserted | Updated | Errors |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `d687bcd2` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-27T20:12:48.282Z` | 0 | 0 | 0 | 0 |
| `2c4e1c82` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-27T20:11:13.808Z` | 30 | 29 | 1 | 0 |
| `ca0315e1` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-27T20:10:47.537Z` | 30 | 30 | 0 | 0 |
| `3ab47966` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-27T19:34:28.126Z` | 27 | 27 | 0 | 0 |
| `fc72feca` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-27T19:28:56.072Z` | 30 | 6 | 24 | 0 |
| `4d7c3e48` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-27T19:26:45.646Z` | 30 | 28 | 2 | 0 |
| `e0dabcce` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-24T00:47:50.425Z` | 30 | 30 | 0 | 0 |
| `16fac86a` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-24T00:47:12.833Z` | 60 | 60 | 0 | 0 |
| `5384c5d8` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-24T00:44:05.344Z` | 30 | 30 | 0 | 0 |
| `01d26957` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-24T00:29:54.342Z` | 30 | 30 | 0 | 0 |
| `d176e696` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-24T00:29:50.783Z` | 0 | 0 | 0 | 0 |
| `db4bab30` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-24T00:29:45.903Z` | 0 | 0 | 0 | 0 |
| `41d8c2c2` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-24T00:28:45.576Z` | 30 | 30 | 0 | 0 |
| `8cfb7930` | `apify/instagram-reel-scraper` | `competitor_monitoring` | **failed** | `2026-10-24T00:04:00.116Z` | 0 | 0 | 0 | 1 |
| `c157e6d4` | `apify/instagram-reel-scraper` | `competitor_monitoring` | **completed** | `2026-10-24T00:03:35.374Z` | 8 | 8 | 0 | 0 |
| `d150dcf9` | `apify/instagram-hashtag-scraper` | `viral_discovery` | **completed** | `2026-10-24T00:03:00.023Z` | 115 | 115 | 0 | 0 |
| `1894429e` | `apify/instagram-reel-scraper` | `competitor_monitoring` | **completed** | `2026-10-23T23:59:52.527Z` | 16 | 16 | 0 | 0 |

### Recorded Provider Error Details:

- Run `8cfb7930` [provider_collection] Target=`anthropicai`: Missing required identifier (id/shortCode: null) or creator username (anthropicai). (Transient: false)