# 02 — Reference architecture and tradeoffs

*Status: design note. Numbers are estimates unless marked "verified"; see
`01-latency-and-data-landscape.md` for source facts.*

## Forces

| Force | Reality for this project |
|---|---|
| Cadence | 1 min (community sensors) to 24 h (model runs); nothing needs sub-second |
| Cardinality | 10³–10⁵ stations, each a few metrics → 10⁶–10⁸ rows/day at 1-min polling |
| Geometry | point time series (primary), plus rasters for satellite layers |
| Read pattern | heavily read-skewed: map boot = "latest everywhere in viewport"; drill-down = one series |
| Team | small; ops time is the scarcest resource |
| Cost profile | egress and raster processing dominate, not storage |
| Trust | a wrong number is worse than a missing number; every value needs provenance |

## Reference architecture

```
  ┌──────────── sources ────────────┐
  │ REST APIs · bulk files · STAC    │
  │ · S3 buckets · MQTT (own sensors)│
  └───────────────┬─────────────────┘
                  │  per-source adapters (own cadence, cursor, rate limit, QC)
                  ▼
        ┌───────────────────┐
        │  scheduler        │  cron/APScheduler/Celery-beat — NOT Kafka
        └─────────┬─────────┘
                  ▼
   ┌──────────────────────────────┐
   │ raw landing (object storage) │  immutable, compressed, checksummed
   │ + ingest_runs ledger         │  one row per attempt: source, cursor, counts, error
   └──────────────┬───────────────┘
                  ▼
   ┌──────────────────────────────┐
   │ normalize · validate · QC    │  units, timestamp semantics, dedupe, flags
   └──────────────┬───────────────┘
                  ▼
   ┌──────────────────────────────┐        ┌────────────────────┐
   │ Postgres                     │        │ object storage     │
   │  · Timescale hypertables     │        │  COG rasters       │
   │  · PostGIS geoms             │        │  PMTiles / MVT     │
   │  · latest_value (denormalized)│       │  derived indices   │
   │  · continuous aggregates     │        └─────────┬──────────┘
   └──────────────┬───────────────┘                  │
                  ▼                                  ▼
   ┌──────────────────────────────────────────────────────────┐
   │ API: /stations (bbox → latest) · /series · /layers/meta  │
   │ freshness contract on every response · ETag · CDN         │
   └──────────────┬───────────────────────────────────────────┘
                  ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Web: MapLibre GL JS + deck.gl · poll latest (30–60 s)    │
   │      SSE for alerts · per-layer freshness indicators      │
   └──────────────────────────────────────────────────────────┘

   cross-cutting: per-source health metrics → internal Grafana board
```

## Decision 1 — Ingest: scheduler, not stream

**Recommendation: scheduled pull + idempotent upsert.**

Every public source in the landscape is pull-based with cadence ≥1 min. A
broker adds a cluster, schema registry, consumer offsets and a new failure mode,
and removes nothing. Concretely:

- At 1-min polling with 5,000 stations you produce ~7 M rows/day. That is a
  `COPY`/`INSERT … ON CONFLICT` workload, not a stream-processing workload.
- Upsert keyed on `(station_id, metric, observed_at)` gives free idempotency and
  retry safety, which a naive stream consumer does not.
- Backfill is a first-class need (new station, late files, revisions). A
  scheduler does it in a loop; a stream pipeline needs a separate backfill path.

**Adopt streaming only when** you own high-frequency sensors (MQTT → ingest
gateway), or several independent consumers need the same event feed. Then
introduce a bus at the *edge*, keep the store idempotent, and treat the bus as
an optimisation rather than the source of truth.

Operational guards:

- advisory lock per source so concurrent runs cannot double-write
- explicit cursor (`last_success_at`) per adapter, separate from "now"
- exponential backoff + `Retry-After` respect; never hammer a 429
- run ledger so a silent failure is visible

## Decision 2 — Storage: one Postgres until it hurts

| Option | Strength | Cost | Verdict |
|---|---|---|---|
| **Postgres + Timescale + PostGIS** | one system for time series, spatial, JSONB provenance, joins against metadata | single-node scale ceiling; tuning required | **Default.** Covers 10³–10⁵ stations comfortably. |
| **ClickHouse** | excellent columnar compression and scan speed at high cardinality | second system; weaker point-update/upsert ergonomics; PostGIS joins awkward | Only past ~10⁸ rows/day or heavy ad-hoc analytics. |
| **DuckDB + Parquet** | superb for batch analytics and reprocessing | not a concurrent-write transactional store | Use *alongside* Postgres for offline analysis, not instead. |
| **Object storage only** | cheapest, infinite | no queries without an engine | For raw payloads and rasters, not the serving layer. |

Schema sketch:

```sql
-- one row per (station, metric, time); Timescale hypertable
CREATE TABLE measurement (
  station_id   bigint      NOT NULL,
  metric       text        NOT NULL,   -- 'pm25', 'no2', 'discharge'
  observed_at  timestamptz NOT NULL,
  value        double precision,
  units        text        NOT NULL,
  qc_flag      smallint    NOT NULL DEFAULT 0,  -- 0 good, 1 suspect, 2 bad
  source_id    smallint    NOT NULL,
  product      text        NOT NULL,   -- 'NRTI' vs 'OFFL' vs 'AQS'
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (station_id, metric, observed_at, source_id, product)
);
SELECT create_hypertable('measurement', 'observed_at');

-- map boot must not scan history
CREATE TABLE latest_value (
  station_id bigint, metric text, value double precision,
  observed_at timestamptz, qc_flag smallint, source_id smallint,
  PRIMARY KEY (station_id, metric)
);
```

Retention, as a starting point (measure before trusting):

| Layer | Keep | Why |
|---|---|---|
| raw payloads | 90 days | debugging and re-derivation |
| raw measurements | 90 days | typical interrogation window |
| hourly aggregates | 3 years | trend and seasonality |
| daily aggregates | indefinitely | long-term baseline |

**Aggregate trap (verified):** TimescaleDB continuous aggregates do not refresh
the current incomplete bucket by default, and since v2.13 real-time aggregates
are disabled by default. So a naive hourly rollup makes "today" look empty or
stale. Either enable `timescaledb.materialized_only = false`, or query the raw
tail explicitly and label it provisional. Do not let an empty chart imply "no
pollution".

## Decision 3 — Raster serving: never render per request

Per-request raster processing (mosaic, reproject, colormap) is the single most
common cause of slow, expensive environmental dashboards.

| Approach | When | Notes |
|---|---|---|
| **COG + HTTP range requests** | you need pixel values at a point, or a few bands | overviews make zoom cheap; works from any CDN |
| **PMTiles / pre-tiled raster** | fixed visual layers, many viewers | one file, no tile server, range-request friendly |
| **Vector tiles from PostGIS** | point/line data that must stay interactive | `ST_AsMVT`, cache aggressively |
| **External processing API** (Sentinel Hub, Earth Engine) | heavy on-demand analytics you do not want to operate | per-request cost and vendor coupling; good escape hatch |

Rule: **anything visible by default is precomputed.** Dynamic computation is
only for explicit user actions (draw an AOI, change the index), where a spinner
is acceptable.

## Decision 4 — API contract

The freshness contract is the product differentiator, so give it a shape:

```http
GET /api/stations?bbox=-1.5,50.6,0.3,51.7&metric=pm25
→ 200
{
  "data": [ { "id": 1234, "lon": -0.12, "lat": 51.50,
              "value": 12.4, "units": "µg/m³",
              "observed_at": "2026-11-07T13:40:00Z",
              "qc_flag": 0 } ],
  "meta": {
    "layer": "aq.pm25.regulatory",
    "source": "airnow",
    "observed_at_range": ["2026-11-07T12:55:00Z", "2026-11-07T13:40:00Z"],
    "stale_after": "2026-11-07T14:40:00Z",
    "valid_fraction": 0.94,
    "preliminary": true
  }
}
```

`/api/layers` returns the registry: for each layer, expected cadence, last
success, next expected, and licence/attribution string. The client renders
"stale" from this, rather than inventing it.

Also: `ETag` + `Cache-Control: public, max-age=30, stale-while-revalidate=300`.
Clamp `bbox` area and point counts; an unbounded bbox query is a DoS you wrote
yourself.

## Decision 5 — Frontend

| Need | Choice | Reason |
|---|---|---|
| Base map | **MapLibre GL JS** | BSD-3 fork of Mapbox GL JS after the 2020 licence change; no API key, self-hostable style |
| 10²–10⁵ points | **deck.gl** `ScatterplotLayer` / `HeatmapLayer` over MapLibre | GPU aggregation, keeps the main thread free |
| Dense static layers | MVT via MapLibre vector source | small payloads, server-side simplification |
| Charts | a lightweight chart lib + downsampled series | never ship 90 days of minute data to a browser |
| Live updates | poll every 30–60 s; SSE only for alerts | matches source cadence; SSE is cheap to add later |

Anti-patterns: re-fetching the whole dataset on each tick (send deltas keyed by
`(id, observed_at)`); a single global "Last updated" clock (see doc 01);
animating a marker to imply movement the data does not have.

**Not recommended for the main view:** Grafana (it is an ops dashboard, its map
panel is weak, and it cannot express per-layer freshness), generic BI tools.
Both are excellent for the *internal* health board.

## Decision 6 — Deployment

**Single VM + Docker Compose** (Postgres/Timescale+PostGIS, API, worker,
scheduler, Caddy/nginx). Reasons: the workload is one database and a few Python
processes; Kubernetes would add more operational surface than the system has
components. Docker 29.1.3, Node 24.21, GDAL 3.11.4 and Python 3.12 are already
present on the target machine.

Move to managed Postgres (with PostGIS + Timescale extensions) before moving to
an orchestrator. Scale reads with a replica and a CDN before sharding.

## Failure modes worth designing for now

| Failure | Symptom | Mitigation |
|---|---|---|
| **Silent source failure** | map looks fine, data is 6 h old | `stale_after` per layer; alert when exceeded; show a banner |
| **Clock/timezone semantics** | values shifted by an hour; DST duplicates | store UTC only; record whether `observed_at` is period start or end |
| **Duplicate ingest** | double-counted averages | natural-key primary key + `ON CONFLICT DO NOTHING` |
| **NRT → science-quality revision** | history changes under users | separate `product` in the key; never overwrite |
| **Rate-limit ban** | total loss of one source | per-source token bucket below the published limit; exponential backoff |
| **Raster request storm** | latency cliff at zoom-out | pre-tiled layers, bbox/zoom clamps, CDN |
| **Schema drift upstream** | nulls, wrong units | validate against a contract; fail loudly into the run ledger |

## Observability — monitor the monitor

Emit, per source and per layer: `last_success_at`, `last_observed_at`, rows
written, run duration, error class, rate-limit remaining. Alert on
`now - last_success_at > 2 × cadence`.

The most valuable single metric: **`now - max(observed_at)` per layer.** It
detects upstream outages, broken parsers and stalled schedulers with one number.

## What not to build

- A message bus, before you own sensors or have a second consumer.
- An authentication system, before the map is correct.
- Dynamic raster processing for default views.
- A generic "connector framework". Write the 3 adapters you need.
- Machine learning on day one; a persistence baseline and a percentile band
  catch most real incidents.
