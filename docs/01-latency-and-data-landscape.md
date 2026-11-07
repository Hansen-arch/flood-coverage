# 01 — Latency and the data landscape

*Status: research note. All timings below are nominal figures published by the data
provider, not measurements of this system. Verified 2026-11-07.*

## The framing question

"Near realtime" is not a property of a dashboard. It is a property of each
individual source. Three consequences follow, and they shape every later
decision:

1. A dashboard is only as fresh as its **slowest displayed layer**, unless it
   exposes freshness per layer.
2. Users judge freshness by the **age of the observation**, not by when your
   server last talked to an API.
3. Public environmental data is **pull-based and coarse**, so this is
   overwhelmingly a scheduling-and-provenance problem, not a streaming problem.

## Two clocks that get conflated

| Clock | Definition | Who quotes it |
|---|---|---|
| **Processing latency** | acquisition → product available for download | vendors, mission specs |
| **Observation age** | now → newest *usable* observation at this point | what the user actually sees |

Observation age is the one that matters:

```
observation_age = processing_latency
                + time since last usable overpass
                + collector interval
                + cache TTL
```

The middle term is the trap. For optical satellites it is set by revisit,
**cloud cover**, daylight, off-nadir angle and QC rejection — and in cloudy
regions it dwarfs processing latency by one to two orders of magnitude. A
Sentinel-2 L2A scene processed in under 3 hours over a persistently cloudy
region can still mean the newest usable pixels at a given point are weeks old.

**Design consequence:** every layer carries

```json
{ "observed_at": "...", "ingested_at": "...", "valid_fraction": 0.62,
  "next_expected_at": "...", "source_version": "..." }
```

and the UI displays `observed_at`. A tile captioned "updated 3 hours ago" when
the underlying pixels are 20 days old is not a small inaccuracy; it is the
product being wrong.

## Tier model

Tiers are about *delivery cadence*, not quality. A Tier 3 model output can be
more trustworthy than a Tier 0 sensor.

| Tier | Typical age | Mechanism | Examples |
|---|---|---|---|
| **0 — live push** | seconds | direct broadcast / websocket / MQTT | GOES mesoscale (30–60 s), FIRMS URT (<60 s, US/Canada only), your own sensors |
| **1 — frequent poll** | 1–60 min | REST poll or file drop | PurpleAir (2-min averaging), AirNow (:25/:55 past hour), USGS telemetry |
| **2 — LEO NRT** | 1–3 h | mission ground segment | Sentinel-2 NRT, Sentinel-5P NRTI, Sentinel-3 AOD NRT, FIRMS global NRT |
| **3 — forecast / daily model** | 6–24 h | scheduled model run | CAMS (00/12 UTC), numerical weather prediction |
| **4 — science quality** | days–months | reprocessing, QA, archive | Sentinel-5P OFFL, FIRMS archive replacement, EPA AQS, Landsat standard products |

### Verified source catalog

| Source | What you get | Native cadence | Nominal latency | Access | Notes |
|---|---|---|---|---|---|
| **GOES-16/18 ABI** | imagery, fire/hotspot, aerosol, cloud | Mode 6: full disk 10 min, CONUS 5 min, mesoscale 1 min (30 s on one domain) | seconds after scan | AWS S3 (open), NOAA CLASS | Fastest *raster* tier available publicly. CONUS/PACUS only. |
| **NASA FIRMS — URT** | thermal anomaly points | continuous | **<60 s** after overpass | FIRMS API / WFS | US & Canada only. Removed once NRT arrives, or after 6 h. |
| **NASA FIRMS — NRT** | MODIS 1 km, VIIRS 375 m fire points | ~4 overpasses/day/sensor | **≤3 h globally** | FIRMS API, CSV, SHP, WMS | Thermal *anomaly*, not a confirmed fire — `Type` field flags volcanoes and industrial sources. |
| **PurpleAir** | PM1/2.5/10, T/RH/P, AQI | 2-min averaging | minutes | REST, API key, metered in "points" | 35,000+ sensors. Query at ≥1/min; use `modified_since` to avoid re-pulling. |
| **Sensor.Community** | PM, T/RH/P | ~5 min *(secondary source, unverified)* | minutes | open REST, no key | Citizen science; heterogeneous hardware and siting. |
| **EPA AirNow** | AQI observations + forecasts | observations updated hourly; bulk files refreshed twice per hour (:25/:55) | sub-hourly | API (key) + `files.airnowtech.org` bulk `.dat` | **Preliminary, not regulatory.** Explicitly must be labelled as such. AQS is the validated archive. |
| **OpenAQ v3** | aggregated global station data | as-reported (hourly typical) | inherits upstream | REST, key, free tier 60/min & 2,000/h | Attribution required. `/latest` endpoints for map boot. |
| **USGS Water Data** | streamflow, gage height, temp, conductance | fixed 15-min collection | "within minutes" where telemetry works; delayed otherwise | `api.waterdata.usgs.gov` (`/continuous`, `/latest-continuous`) | Provisional until reviewed. Legacy `waterservices /iv` still documented. |
| **Sentinel-2 L2A** | 10/20/60 m surface reflectance | ≤5 days global reuse (mission requirement, 2 satellites) | **RT ≤100 min; NRT 100 min–3 h; NTC 3–24 h** | CDSE STAC, S3, Earth Search | Latency figures are the *mission requirement*, not measured operational performance. |
| **Sentinel-5P TROPOMI** | NO2, SO2, O3, CO, CH4, aerosol index | daily global coverage | **NRTI ≤3 h**; OFFL *a few days*; RPRO reprocessed | CDSE, NASA GES DISC | NRT granules are 5-min chunks; NASA archives NRT for only ~10 days — you must persist what you need. |
| **Sentinel-3 SLSTR AOD** | aerosol optical depth, 9.5 km | daily | **≤3 h (NRT)** | CDSE STAC | Useful as an independent check on model AOD. |
| **CAMS global** | 50+ species, 7 aerosol types, met fields | **2 runs/day (00 & 12 UTC)**, hourly surface fields, 6-hourly analyses | ~hours after run | ADS / CDS API, FTP | 5-day horizon, ~40 km. Analysis is a *model estimate*, not an observation. |
| **Sentinel-1 SAR** | C-band backscatter (floods, ships, deformation) | 6–12 day revisit | NRT ≤3 h* | CDSE, ASF | Sees through cloud and at night — the only optical-independent option. |

\* Sentinel-1's "NRT ≤3 h" is the Copernicus programme-wide timeliness definition
as documented by a reseller, not a mission-spec figure. Treat it as approximate.

### Not yet verified — do not design against these without checking

- **Landsat 8/9 C2 L2** latency and access path.
- **Open-Meteo / commercial weather APIs** — free-tier licensing is
  non-commercial for several; verify before public display.
- **Sensor.Community** cadence is from a third-party client library, not the
  operator's docs.
- **Commercial sensor APIs** (PurpleAir paid tiers, Tomorrow.io, Ambee, etc.) —
  pricing and redistribution terms change; read the current contract.

## Latency budget arithmetic

Worked example for an AirNow-based layer:

```
source update cadence        ~60 min (hourly observations, files at :25/:55)
collector poll interval       5 min          → +0…5 min
parse + validate + upsert    5 s
CDN / API cache TTL          60 s           → +1 min
client poll interval         60 s           → +0…1 min
--------------------------------------------------
worst-case observation age   ~67 min
```

So a "live air quality" map is normally showing data **about an hour old**, and
up to roughly 75 minutes old in the worst case. That is fine — but the UI must
say "as of 14:00" rather than "live".

Rules of thumb:

- Poll at **half the source cadence** (Nyquist-style) so you do not systematically
  miss updates; going faster only burns rate limit.
- Keep total *pipeline* latency under ~10% of source cadence; below that,
  optimisation is invisible.
- Publish the budget. If the number is embarrassing, the source choice is wrong,
  not the caption.

## Quality caveats that will bite

| Caveat | Why it matters | Mitigation |
|---|---|---|
| **Low-cost PM sensors are biased** | PurpleAir-class sensors respond to humidity and particle composition differently from reference monitors; raw values are not comparable to regulatory PM2.5 | Correct against nearby reference monitors, or present as a separate, clearly-labelled layer. Never share a colour scale with regulatory data. |
| **AirNow is preliminary** | Values are revised; AQS is the validated archive | Label "preliminary"; keep the raw payload so revisions can be reconciled. |
| **FIRMS is anomalies, not fires** | Gas flares and volcanoes register as hotspots | Filter on `Type` (0 = presumed vegetation fire) and on persistence across overpasses. |
| **NRT is replaced by science quality** | FIRMS NRT is swapped for standard products after 2–3 months (up to 5); Sentinel-5P NRT vs OFFL differ | Store `source_product` + processing version. Either keep NRT and reprocessed series separate, or accept that your history is a revision log. Do not silently overwrite. |
| **Station metadata drifts** | Sensors move, get renamed, go offline permanently | Version station metadata; never join history on a name string. |
| **Model output is not observation** | CAMS analysis looks like a measurement on a map | Render model fields differently (contour/hatch, not point symbols). |

## What this implies for the build

1. **Poll, don't stream.** Every public source above is pull-based with a
   cadence of 1 minute to 1 day. A message bus buys nothing until you own
   high-frequency sensors.
2. **One adapter per source**, each carrying its own cadence, cursor state,
   rate limit and QC rules. Do not write a generic "REST poller" — the sources
   disagree on pagination, time semantics and identity.
3. **Freshness is data**, not decoration. It belongs in the schema and the API
   contract, and it drives alerting.
4. **Provenance is mandatory.** For every stored value: source, product,
   processing version, `ingested_at`, and the raw payload (or a hash of it).
5. **Pick a domain whose cadence matches the promise.** Air quality can honestly
   claim "updated every few minutes". Vegetation indices cannot.

## Sources

All accessed 2026-11-07.

- ESA, *Sentinel-2 — ESA's Optical High-Resolution Mission for GMES
  Operational Services* (SP-1322/2), product timeliness RT/NRT/NTC and revisit
  requirements: https://sentiwiki.copernicus.eu/__attachments/a_0a9fb7c4de08a522b0f8a34b7bd1205b3a8f4188bac27db53fef268438e042c9/Sentinel-2%20ESA%E2%80%99s%20Optical%20High-Resolution%20Mission%20for%20GMES%20Operational%20Services.pdf
- NASA Earthdata, *Data Latency* (FIRMS 3 h; URT <60 s):
  https://www.earthdata.nasa.gov/learn/earth-observation-data-basics/data-latency
- NASA FIRMS, *Active Fire Data* (global ≤3 h; US/Canada real-time; NRT archive
  replacement; RT/URT expiry):
  https://firms.modaps.eosdis.nasa.gov/active_fire
- TROPOMI, *Nitrogen Dioxide* (NRTI ≤3 h, OFFL, RPRO):
  https://www.tropomi.eu/data-products/nitrogen-dioxide
- ESA, *Sentinel-5P data products* (NRT ≤3 h requirement):
  https://www.esa.int/Applications/Observing_the_Earth/Copernicus/Sentinel-5P/Data_products
- NASA GES DISC, *S5P_L2__NO2____HiR_NRT* (10-day NRT archive):
  https://www.earthdata.nasa.gov/data/catalog/ges-disc-s5p-l2-no2-hir-nrt-2
- Copernicus CDSE STAC, *Sentinel-3 SLSTR AOD (NRT)*, 9.5 km, <3 h:
  https://browser.stac.dataspace.copernicus.eu/collections/sentinel-3-sl-2-aod-nrt
- Copernicus CAMS, *Configuration for daily global analyses and forecasts*
  (00/12 UTC, 5-day, ~40 km):
  https://atmosphere.copernicus.eu/configuration-daily-global-analyses-and-forecasts
- ECMWF, *CAMS global atmospheric composition forecast data documentation*
  (hourly surface fields, 6-hourly analyses):
  https://confluence.ecmwf.int/spaces/CKB/pages/212454117
- NOAA STAR, *ABI Scan Modes* (Mode 6: 10/5/1 min):
  https://www.star.nesdis.noaa.gov/atmospheric-composition-training/satellite_data_abi_scan_modes.php
- PurpleAir, *API Use Guidelines* (2-min reporting, query ≥1/min, groups):
  https://community.purpleair.com/t/api-use-guidelines/1589
- PurpleAir, *API* (35,000+ sensors):
  https://www.purpleair.com/api
- EPA AirNow API, *FAQ* (hourly updates, caching, file cadence):
  https://docs.airnowapi.org/faq
- EPA AirNow API, *Hourly Data Fact Sheet* (bulk hourly files refreshed at :25
  and :55):
  https://docs.airnowapi.org/docs/HourlyDataFactSheet.pdf
- EPA AirNow API, *Hourly AQ Obs Fact Sheet* (observation file updated ~:35
  past the hour; a different feed from the bulk file above):
  https://docs.airnowapi.org/docs/HourlyAQObsFactSheet.pdf
- EPA AirNow API, *Data Use Guidelines* (preliminary; AQS is regulatory):
  https://docs.airnowapi.org/account/request
- OpenAQ, *Rate limits* (60/min, 2,000/h, attribution):
  https://docs.openaq.org/using-the-api/rate-limits
- OpenAQ, *Measurements* (`/latest`, aggregation endpoints):
  https://docs.openaq.org/resources/measurements
- USGS, *Water Data APIs — continuous values* (15-min, telemetry-dependent):
  https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous?f=html
- USGS Water Services, *Instantaneous Values* (15-min readings, hourly
  transmission):
  https://waterservices.usgs.gov/docs/instantaneous-values/instantaneous-values-details
- CREODIAS, *Timeliness and frequency of Sentinel products* — the "NRT <3 h"
  Copernicus timeliness definition used for Sentinel-1 (*reseller documentation,
  secondary source*):
  https://creodias.eu/cases/timeliness-and-frequency-of-sentinel-satellite-products-explained
