"""Turn raw acquisition times into the numbers the demo argues with.

The central metric is not "how long between looks". It is: **if a flood of a
given rise time started at a random moment, what is the chance that any
acquisition falls inside its rise?**

We answer that empirically from the recorded acquisition times, by sliding the
rise window across the whole year in one-hour steps and counting placements that
contain at least one look. No assumption of a regular revisit period.
"""

from __future__ import annotations

import json
import statistics as st
from bisect import bisect_left
from datetime import datetime, timezone

ACQ_PATH = "data/acquisitions.json"
RISES_H = [3, 6, 12, 24, 48, 72, 168]
STEP_H = 1


def _parse(dt: str) -> datetime:
    return datetime.fromisoformat(dt.replace("Z", "+00:00"))


def load() -> dict:
    with open(ACQ_PATH) as f:
        return json.load(f)


def _times(basin) -> list[datetime]:
    return sorted(_parse(o["datetime"]) for o in basin["overpasses"])


def _gaps(ts: list[datetime]) -> list[float]:
    return [(ts[i + 1] - ts[i]).total_seconds() / 3600 for i in range(len(ts) - 1)]


def observe_probability(ts: list[datetime], rise_h: float) -> float:
    """Fraction of random event onsets with >=1 acquisition inside the rise.

    For each candidate onset t (1-hour steps across the record), the event is
    "seen during rise" if some acquisition falls in [t, t + rise_h].
    """
    if len(ts) < 2:
        return 0.0
    start, end = ts[0], ts[-1]
    total_h = (end - start).total_seconds() / 3600
    if total_h <= rise_h:
        return 1.0

    secs = [t.timestamp() for t in ts]
    step = STEP_H * 3600
    t0 = start.timestamp()
    n = int((total_h - rise_h) // STEP_H) + 1
    hit = 0
    for i in range(n):
        a = t0 + i * step
        b = a + rise_h * 3600
        j = bisect_left(secs, a)
        if j < len(secs) and secs[j] <= b:
            hit += 1
    return hit / n if n else 0.0


def _hist(gaps: list[float], edges: list[float]) -> dict:
    counts = [0] * (len(edges) - 1)
    for g in gaps:
        for i in range(len(edges) - 1):
            if edges[i] <= g < edges[i + 1]:
                counts[i] += 1
                break
        else:
            counts[-1] += 1
    return {"edges": edges, "counts": counts}


def basin_summary(basin: dict) -> dict:
    ts = _times(basin)
    gaps = _gaps(ts)
    span_days = (ts[-1] - ts[0]).total_seconds() / 86400 if len(ts) > 1 else 0
    med = st.median(gaps) if gaps else 0.0
    ordered = sorted(gaps)
    p95 = ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))] if gaps else 0.0

    # Worst gap, with dates, so the claim is checkable rather than aggregated.
    worst = {"hours": 0.0, "from": None, "to": None}
    for i, g in enumerate(gaps):
        if g > worst["hours"]:
            worst = {
                "hours": round(g, 1),
                "from": ts[i].strftime("%Y-%m-%d %H:%M"),
                "to": ts[i + 1].strftime("%Y-%m-%d %H:%M"),
            }

    hours = {}
    for t in ts:
        hours[t.hour] = hours.get(t.hour, 0) + 1

    sweep = [
        {"rise_h": r, "p": round(observe_probability(ts, r), 3)} for r in RISES_H
    ]

    return {
        "id": basin["id"],
        "short": basin.get("short", basin["name"]),
        "name": basin["name"],
        "country": basin["country"],
        "bbox": basin["bbox"],
        "response": basin["response"],
        "rise_hours": basin["rise_hours"],
        "rise_source": basin["rise_source"],
        "n_acquisitions": len(ts),
        "span_days": round(span_days),
        "per_day": round(len(ts) / span_days, 2) if span_days else 0,
        "median_gap_h": round(med, 1),
        "p95_gap_h": round(p95, 1),
        "max_gap_h": round(max(gaps), 1) if gaps else 0,
        "gaps_over_48h": sum(1 for g in gaps if g > 48),
        "gaps_over_72h": sum(1 for g in gaps if g > 72),
        "worst_gap": worst,
        # Shared edges, wide enough for an equatorial 12-day gap: one binning keeps
        # the four basins comparable instead of rebinning per basin.
        "gap_hist": _hist(gaps, [0, 12, 24, 48, 72, 120, 168, 336]),
        "clock_hours": [{"hour": h, "n": n} for h, n in sorted(hours.items())],
        "sweep": sweep,
        "own_rise_p": next(
            (s["p"] for s in sweep if s["rise_h"] == basin["rise_hours"]), None
        ),
        "timeline": [
            {
                "t": t.strftime("%Y-%m-%dT%H:%M"),
                "gap_h": round(gaps[i], 1) if i < len(gaps) else None,
            }
            for i, t in enumerate(ts)
        ],
    }


def payload() -> dict:
    raw = load()
    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "collection": raw["collection"],
        "window": raw["datetime"].replace("T00:00:00Z", ""),
        "basins": [basin_summary(b) for b in raw["basins"]],
        "rises_h": RISES_H,
    }


if __name__ == "__main__":
    print(json.dumps(payload(), indent=1)[:1200])
