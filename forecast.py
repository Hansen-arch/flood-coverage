"""Pull the GloFAS river discharge forecast and pair it with the observation record.

This is the prediction half of the product. It answers a different question from
analyze.py:

  analyze.py  - if a flood rises, is there a look inside the rise?
  forecast.py - a forecast tells you when the peak will be. Can a look confirm it?

The forecast is GloFAS v4, reached through the Open-Meteo flood API, which needs
no key. Two honest constraints are recorded with every number:

1. GloFAS models **river discharge only**. It does not forecast flash flooding,
   coastal flooding, or inundation extent, and a 5 km grid does not resolve a
   catchment the size of the Ahr.
2. A single sample at the basin centroid lands on a headwater cell, not the
   river. The Po centroid returns 1.8 m3/s; the main stem 12 km away returns
   1124 m3/s. So each basin is sampled on a 3x3 grid and the cell with the
   highest median discharge over the 60 day window is kept. That rule is
   stated in the payload so the choice is checkable, not hidden.

stdlib only.
"""

from __future__ import annotations

import json
import os
import statistics as st
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://flood-api.open-meteo.com/v1/flood"
OUT = "data/forecast.json"
GRID = 3           # 3x3 sample points per basin box
PAST_DAYS = 30     # baseline window
FORECAST_DAYS = 30 # GloFAS horizon exposed by the API
CONFIRM_HALF_H = 24  # a look within +/- this many hours confirms a forecast peak


def sample_points(bbox: list[float], n: int = GRID) -> list[tuple[float, float]]:
    w, s, e, north = bbox
    pts = []
    for i in range(n):
        for j in range(n):
            lon = w + (e - w) * (i + 0.5) / n
            lat = s + (north - s) * (j + 0.5) / n
            pts.append((round(lat, 4), round(lon, 4)))
    return pts


def fetch_grid(pts: list[tuple[float, float]]) -> list[dict]:
    """One request for every point. The API returns a list when given many."""
    lats = ",".join(str(p[0]) for p in pts)
    lons = ",".join(str(p[1]) for p in pts)
    url = (
        f"{API}?latitude={lats}&longitude={lons}"
        f"&daily=river_discharge,river_discharge_max"
        f"&forecast_days={FORECAST_DAYS}&past_days={PAST_DAYS}"
    )
    req = urllib.request.Request(
        url, headers={"User-Agent": "flood-knowledge-state/0.1 (portfolio demo)"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    return data if isinstance(data, list) else [data]


def summarise(basin: dict) -> dict:
    """Fetch, pick the main-stem cell, and reduce to the numbers the page shows."""
    pts = sample_points(basin["bbox"])
    try:
        locations = fetch_grid(pts)
    except (urllib.error.URLError, TimeoutError) as exc:
        return {"id": basin["id"], "ok": False, "error": str(exc)}

    best = None
    for loc in locations:
        daily = loc.get("daily") or {}
        vals = daily.get("river_discharge") or []
        clean = [v for v in vals if v is not None]
        if len(clean) < 10:
            continue
        med = st.median(clean)
        if best is None or med > best["median"]:
            best = {
                "median": med,
                "loc": loc,
                "values": vals,
                "times": daily.get("time") or [],
            }

    if best is None:
        return {"id": basin["id"], "ok": False, "error": "no discharge values returned"}

    times = best["times"]
    values = best["values"]
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    split = times.index(today) if today in times else PAST_DAYS

    past = [v for v in values[:split] if v is not None]
    fc_times = times[split : split + FORECAST_DAYS]
    fc_vals = values[split : split + FORECAST_DAYS]

    pairs = [(t, v) for t, v in zip(fc_times, fc_vals) if v is not None]
    if not pairs:
        return {"id": basin["id"], "ok": False, "error": "empty forecast window"}

    peak_t, peak_v = max(pairs, key=lambda p: p[1])
    current = pairs[0][1]
    baseline = st.median(past) if past else None

    return {
        "id": basin["id"],
        "ok": True,
        "cell": [round(best["loc"]["latitude"], 3), round(best["loc"]["longitude"], 3)],
        "cell_elevation_m": best["loc"].get("elevation"),
        "grid_points_sampled": len(pts),
        "horizon_days": len(pairs),
        "current_m3s": round(current, 1),
        "peak_m3s": round(peak_v, 1),
        "peak_date": peak_t,
        "baseline_median_m3s": round(baseline, 1) if baseline else None,
        "peak_vs_baseline": round(peak_v / baseline, 2) if baseline else None,
        # Past 30 days dim, next 30 days bright: one series the page can draw.
        "series": [
            {"d": t, "q": (round(v, 1) if v is not None else None)}
            for t, v in zip(times, values)
        ],
        "split_index": split,
    }


def main() -> None:
    from basins import BASINS

    os.makedirs("data", exist_ok=True)
    rows = [summarise(b) for b in BASINS]

    payload = {
        "source": "GloFAS v4 river discharge, via the Open-Meteo flood API",
        "issued_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "horizon_days": FORECAST_DAYS,
        "past_days": PAST_DAYS,
        "confirm_half_window_h": CONFIRM_HALF_H,
        "sample_rule": (
            f"{GRID}x{GRID} points per basin box; the cell with the highest median "
            "discharge over the 60 day window is kept"
        ),
        "limits": (
            "River discharge only. No flash flood, coastal flood or inundation extent, "
            "and a 5 km grid does not resolve small steep catchments."
        ),
        "basins": rows,
    }

    with open(OUT, "w") as f:
        json.dump(payload, f, indent=1)

    for r in rows:
        if r.get("ok"):
            print(
                f"  {r['id']:9s} cell {r['cell']}  now {r['current_m3s']:>8.1f}  "
                f"peak {r['peak_m3s']:>8.1f} on {r['peak_date']}  "
                f"x{r['peak_vs_baseline']} recent median"
            )
        else:
            print(f"  {r['id']:9s} FAILED: {r.get('error')}")
    print(f"wrote {OUT}")


def payload() -> dict:
    """Serve the stored forecast, adding the confirmation probability.

    The confirmation number is not a forecast property. It comes from the
    acquisition record: the share of randomly timed peaks with a Sentinel-1 look
    within the confirmation window.
    """
    from analyze import _times, load, observe_probability

    with open(OUT) as f:
        data = json.load(f)

    acq = {b["id"]: b for b in load()["basins"]}
    for row in data["basins"]:
        basin = acq.get(row["id"])
        if not row.get("ok") or basin is None:
            row["confirm_p"] = None
            continue
        ts = _times(basin)
        window_h = 2 * data["confirm_half_window_h"]
        row["confirm_p"] = round(observe_probability(ts, window_h), 3)

    return data


if __name__ == "__main__":
    main()
