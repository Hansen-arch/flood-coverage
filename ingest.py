"""Ingest Sentinel-1 acquisition metadata from a public STAC API.

We want acquisition *times*, not pixels. One STAC search per basin, paginated,
deduplicated to distinct overpasses.

stdlib only - no requests, no pandas - so it runs on any interpreter here.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
COLLECTION = "sentinel-1-grd"
DATETIME = "2025-11-01T00:00:00Z/2026-11-01T00:00:00Z"
OUT = "data/acquisitions.json"
PAGE_LIMIT = 500
MAX_PAGES = 40


def stac_search(bbox, extra_body=None):
    """Yield every item for a bbox, following the next-page links."""
    body = {
        "collections": [COLLECTION],
        "bbox": bbox,
        "datetime": DATETIME,
        "limit": PAGE_LIMIT,
    }
    if extra_body:
        body.update(extra_body)

    url = STAC
    items = []
    pages = 0
    while url and pages < MAX_PAGES:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "User-Agent": "flood-knowledge-state/0.1 (portfolio demo)",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=90) as r:
            payload = json.load(r)
        items.extend(payload.get("features", []))
        pages += 1

        nxt = None
        for link in payload.get("links", []):
            if link.get("rel") == "next":
                nxt = link.get("href")
                break
        if not nxt:
            break
        # Subsequent pages carry their own body/params; the next href is a full
        # search URL, so POST it with an empty body.
        url, body = nxt, {}
    return items, pages


MERGE_SECONDS = 600  # products this close in time are the same acquisition


def dedupe_overpasses(items):
    """Collapse products to distinct overpasses.

    VV and VH ship as separate products from one acquisition, ~1 minute apart,
    so time-keying on the minute is too tight. Cluster on platform plus a
    tolerance window instead: ascending and descending passes are ~12 h apart,
    so a 10-minute window cannot merge two genuinely distinct looks.
    """
    rows = []
    for it in items:
        props = it.get("properties", {})
        raw = props.get("datetime") or props.get("start_datetime")
        if not raw:
            continue
        platform = props.get("platform") or props.get("sar:platform") or "unknown"
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        rows.append(
            {
                "ts": ts,
                "platform": platform,
                "orbit": props.get("sat:orbit_state"),
                "polarisations": props.get("sar:polarizations"),
                "item_id": it.get("id"),
                "raw": raw,
            }
        )
    rows.sort(key=lambda r: r["ts"])

    merged = []
    for r in rows:
        if merged:
            last = merged[-1]
            same = (
                last["platform"] == r["platform"]
                and (r["ts"] - last["ts"]).total_seconds() <= MERGE_SECONDS
            )
            if same:
                last["products"] += 1
                if r["polarisations"]:
                    pols = set(last["polarisations"] or []) | set(r["polarisations"])
                    last["polarisations"] = sorted(pols)
                continue
        merged.append(
            {
                "datetime": r["raw"],
                "ts": r["ts"],
                "platform": r["platform"],
                "orbit": r["orbit"],
                "polarisations": r["polarisations"],
                "item_id": r["item_id"],
                "products": 1,
            }
        )

    for m in merged:
        m.pop("ts")
    return merged


def main():
    from basins import BASINS

    os.makedirs("data", exist_ok=True)
    out = {"collection": COLLECTION, "datetime": DATETIME, "basins": []}

    for b in BASINS:
        sys.stderr.write(f"querying {b['id']} {b['bbox']} ...\n")
        try:
            items, pages = stac_search(b["bbox"])
        except urllib.error.URLError as exc:
            sys.stderr.write(f"  FAILED: {exc}\n")
            items, pages = [], 0
        looks = dedupe_overpasses(items)
        sys.stderr.write(
            f"  {len(items)} products / {pages} pages -> {len(looks)} overpasses\n"
        )
        out["basins"].append(
            {
                "id": b["id"],
                "short": b.get("short", b["name"]),
                "name": b["name"],
                "country": b["country"],
                "bbox": b["bbox"],
                "response": b["response"],
                "rise_hours": b["rise_hours"],
                "rise_source": b["rise_source"],
                "products": len(items),
                "overpasses": looks,
            }
        )

    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    sys.stderr.write(f"wrote {OUT}\n")


if __name__ == "__main__":
    main()
