/* ------------------------------------------------------------------
   Read DESIGN.md first. Two rules drive this file:
   1. presence is cyan, absence is amber, and absence is always drawn;
   2. every figure comes from /api/data, nothing is smoothed or invented.
   ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const CYAN = "#4ec9ff";
const AMBER = "#f0a44a";

let DATA = null;
let FORECAST = null;
let forecastError = null;
let current = null;
let map = null;
let lastChartWidth = 0;

/* ---- small helpers ---- */

const num = (v, d = 1) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(d).replace(/\.0+$/, "");
};
const pct = (p) => `${Math.round((Number(p) || 0) * 100)}%`;
const pad2 = (n) => String(n).padStart(2, "0");
const dur = (h) => (h > 72 ? `${h / 24} days` : `${h} hours`);
const durAdj = (h) => (h > 72 ? `${h / 24}-day` : `${h}-hour`);

function basin() {
  return DATA.basins.find((b) => b.id === current);
}
// Compare like with like: the other basin sharing this response class, so the
// difference between the two curves is cadence, not hydrology.
function comparator() {
  const sel = basin();
  const others = DATA.basins.filter((b) => b.id !== sel.id);
  if (!others.length) return null;
  return others.find((b) => b.response === sel.response) || others[0];
}

/* ---- boot + states ---- */

async function boot() {
  let payload;
  try {
    const res = await fetch("/api/data");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    return failState(
      "Could not read the acquisition data",
      `The page asked /api/data for the computed statistics and got: ${err.message}.`,
      "Start the server from the project root, then run <code>python3 ingest.py</code> if the data file is missing.",
    );
  }

  DATA = payload;

  if (!DATA.basins || DATA.basins.length === 0) {
    return failState(
      "No basins in the payload",
      "The API answered, but it contains no basin records, so there is nothing to measure.",
      "Run <code>python3 ingest.py</code> to populate <code>data/acquisitions.json</code>.",
    );
  }

  // Open on Jakarta: a 6 hour rise there is caught 3% of the time, against 17% for
  // the Ahr at the same rise length, so the first screen is already the comparison.
  current = DATA.basins.some((b) => b.id === "ciliwung") ? "ciliwung" : DATA.basins[0].id;

  $("#m-collection").textContent = DATA.collection || "-";
  $("#m-window").textContent = DATA.window || "-";
  $("#m-looks").textContent = String(
    DATA.basins.reduce((sum, b) => sum + (b.n_acquisitions || 0), 0),
  );
  $("#m-built").textContent = (DATA.generated_at || "-").replace("Z", "");
  $("#foot-window").textContent = `Window ${DATA.window || "-"}`;

  buildTabs();
  renderAll();
  renderProvenance();
  initMap();
  loadForecast();

  document.body.classList.remove("is-loading");
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(onResize);
}

function failState(title, message, action) {
  const main = document.querySelector("main");
  main.innerHTML = `<div class="state-error">
    <h2>${title}</h2>
    <p>${message}</p>
    <p>${action}</p>
  </div>`;
  const foot = $(".foot");
  if (foot) foot.remove();
  document.body.classList.remove("is-loading");
}

/* ---- tabs ---- */

function buildTabs() {
  const wrap = $("#tabs");
  wrap.innerHTML = "";
  DATA.basins.forEach((b) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.dataset.id = b.id;
    btn.textContent = b.short || b.name;
    btn.title = b.name;
    btn.addEventListener("click", () => select(b.id));
    wrap.appendChild(btn);
  });

  wrap.addEventListener("keydown", (e) => {
    const btns = [...wrap.querySelectorAll("button")];
    const at = btns.indexOf(document.activeElement);
    if (at < 0) return;
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (at + 1) % btns.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (at - 1 + btns.length) % btns.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = btns.length - 1;
    if (next === null) return;
    e.preventDefault();
    btns[next].focus();
    select(btns[next].dataset.id);
  });

  syncTabs();
}

function syncTabs() {
  $("#tabs").querySelectorAll("button").forEach((btn) => {
    const on = btn.dataset.id === current;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
  });
}

function select(id) {
  if (!id || id === current) return;
  current = id;
  syncTabs();
  renderAll();
  updateMap(true);
}

/* ---- render everything ---- */

function renderAll() {
  const b = basin();
  if (!b.timeline || b.timeline.length === 0 || !b.n_acquisitions) {
    return basinEmptyState(b);
  }
  renderReading();
  renderStrip();
  renderLegend();
  renderSweep();
  renderHist();
  renderStats();
  renderClock();
  renderBlackout();
  renderTimeline();
  renderForecast();
  $("#map-caption").textContent = `${b.name}, ${b.country}`;
}

function basinEmptyState(b) {
  const host = document.querySelector(".stack");
  if (!host) return;
  host.innerHTML = `<section class="plate"><div class="state-error" style="margin:0;padding:0;max-width:56ch">
    <h2>No acquisitions in this window</h2>
    <p>${b.name} has no Sentinel-1 records inside ${DATA.window}, so there is nothing to
    measure. This is not the same as zero coverage: it means the query returned nothing,
    not that the basin was never observed.</p>
    <p>Widen the window in <code>basins.py</code>, then rerun <code>python3 ingest.py</code>.</p>
  </div></section>`;
  document.querySelector("#claim-pct").textContent = "n/a";
  document.querySelector("#claim").textContent = "No measurement available for this basin.";
  document.querySelector("#claim-pct").classList.add("is-mid");
}

/* ---- 01 the finding ---- */

function renderReading() {
  const b = basin();
  const figure = $("#claim-pct");
  const share = Math.round((b.own_rise_p || 0) * 100);

  figure.textContent = `${share}%`;
  figure.classList.toggle("is-blind", share < 30);
  figure.classList.toggle("is-mid", share >= 30 && share < 70);
  if (!reduceMotion) {
    figure.classList.remove("swap");
    void figure.offsetWidth;
    figure.classList.add("swap");
  }

  const missed = 100 - share;
  $("#claim").innerHTML =
    `A flood rising over <strong>${dur(b.rise_hours)}</strong>, starting at an ` +
    `arbitrary moment, is met by a Sentinel-1 look ` +
    `<strong class="observed">${share}%</strong> of the time. ` +
    `In the other <strong class="missed">${missed}%</strong> the rise passes ` +
    `unobserved, and the first look comes after the peak, if one comes at all.`;

  $("#metrics").textContent =
    `${b.n_acquisitions} acquisitions · ${b.per_day}/day · ` +
    `median gap ${num(b.median_gap_h)} h · 95th percentile ${num(b.p95_gap_h)} h · ` +
    `${b.gaps_over_48h} gaps over 48 h`;

  $("#rise-src").innerHTML =
    `assumed rise <b>${b.rise_hours} h</b> · ${b.rise_source || "order-of-magnitude estimate"}`;
}

function dayCounts(b) {
  const seen = new Map();
  b.timeline.forEach((p) => {
    const day = p.t.slice(0, 10);
    seen.set(day, (seen.get(day) || 0) + 1);
  });
  const first = new Date(`${b.timeline[0].t.slice(0, 10)}T00:00:00Z`);
  const last = new Date(`${b.timeline[b.timeline.length - 1].t.slice(0, 10)}T00:00:00Z`);
  const total = Math.round((last - first) / 86400000) + 1;
  const days = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(first.getTime() + i * 86400000);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, n: seen.get(key) || 0 });
  }
  return days;
}

function renderStrip() {
  const b = basin();
  const days = dayCounts(b);
  const zero = days.filter((d) => d.n === 0).length;
  const peak = Math.max(...days.map((d) => d.n), 1);

  const cells = days
    .map((d, i) => {
      if (d.n === 0) {
        return `<rect x="${i}" y="0" width="0.86" height="10" fill="${AMBER}" opacity="0.85"/>`;
      }
      const op = 0.42 + 0.58 * (d.n / peak);
      return `<rect x="${i}" y="0" width="0.86" height="10" fill="${CYAN}" opacity="${op.toFixed(2)}"/>`;
    })
    .join("");

  $("#strip").innerHTML =
    `<svg viewBox="0 0 ${days.length} 10" preserveAspectRatio="none" ` +
    `shape-rendering="crispEdges" role="img" ` +
    `aria-label="One cell per day of the record: ${days.length} days, ` +
    `${zero} with no acquisition, ${days.length - zero} with at least one.">` +
    `${cells}</svg>`;

  $("#strip-note").innerHTML =
    `<b>${zero}</b> of ${days.length} days had no acquisition at all. ` +
    `<i>Cyan</i> is a day the basin was looked at, <b>amber</b> is a day it was not. ` +
    `A flood that rose and fell on one of those ${zero} days was never seen.`;
}

/* ---- 02 the sweep, both basins ---- */

function renderLegend() {
  const sel = basin();
  const oth = comparator();
  const swatch = (dash) => {
    const extra = dash ? ` stroke-dasharray="5 4" opacity="0.45"` : "";
    return `<svg width="26" height="8" aria-hidden="true"><line x1="0" y1="4" x2="26" y2="4" ` +
      `stroke="${CYAN}" stroke-width="${dash ? 1.5 : 2.25}"${extra}/></svg>`;
  };
  $("#legend").innerHTML =
    `<span class="item">${swatch(false)}${sel.name}, ${durAdj(sel.rise_hours)} rise</span>` +
    (oth
      ? `<span class="item">${swatch(true)}${oth.name}, ${durAdj(oth.rise_hours)} rise</span>`
      : "");

  $("#sweep-fignote").textContent = !oth
    ? ""
    : oth.response === sel.response
      ? `Dashed is the other ${sel.response === "flash" ? "flash" : "slow-response"} basin, so the gap between the two lines is cadence and mission planning, not hydrology.`
      : `Dashed is the next basin in the list.`;
}

function renderSweep() {
  const host = $("#sweep-chart");
  if (!host) return;

  const sel = basin();
  const oth = comparator();
  const W = Math.max(300, Math.round(host.clientWidth || 680));
  const narrow = W < 560;
  const H = narrow ? 264 : 300;
  const ml = 42;
  const mr = 14;
  const mt = 34;
  const mb = 48;
  const pw = W - ml - mr;
  const ph = H - mt - mb;

  const allRises = sel.sweep.map((d) => d.rise_h);
  const lo = Math.log2(Math.min(...allRises)) - 0.17;
  const hi = Math.log2(Math.max(...allRises)) + 0.17;
  const X = (h) => ml + ((Math.log2(h) - lo) / (hi - lo)) * pw;
  const Y = (p) => mt + (1 - p) * ph;

  const rises = sel.sweep.map((d) => d.rise_h).sort((a, b) => a - b);
  const seriesPath = (arr) =>
    arr
      .slice()
      .sort((a, b) => a.rise_h - b.rise_h)
      .map((d, i) => `${i ? "L" : "M"}${X(d.rise_h).toFixed(1)},${Y(d.p).toFixed(1)}`)
      .join(" ");

  let grid = "";
  [0, 0.25, 0.5, 0.75, 1].forEach((p) => {
    const y = Y(p).toFixed(1);
    const cls = p === 0.5 ? "grid-mid" : "grid";
    const label = p === 1 ? "100%" : String(Math.round(p * 100));
    grid += `<line class="${cls}" x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}"/>`;
    grid += `<text class="tick" x="${ml - 9}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end">${label}</text>`;
  });

  const band =
    `<rect class="band" x="${ml}" y="${Y(0.5).toFixed(1)}" width="${pw}" ` +
    `height="${(ph / 2).toFixed(1)}"/>`;

  const hint = narrow
    ? ""
    : `<text class="hint" x="${ml + 8}" y="${(Y(0.5) + 15).toFixed(1)}" text-anchor="start">below this line, more rises are missed than caught</text>`;

  let xaxis = "";
  rises.forEach((h) => {
    const x = X(h).toFixed(1);
    xaxis += `<line class="grid" x1="${x}" y1="${mt + ph}" x2="${x}" y2="${mt + ph + 5}"/>`;
    const anchor = h === rises[0] ? "start" : h === rises[rises.length - 1] ? "end" : "middle";
    xaxis += `<text class="tick" x="${x}" y="${mt + ph + 20}" text-anchor="${anchor}">${h}</text>`;
  });
  xaxis += `<text class="tick-ax" x="${W - mr}" y="${H - 8}" text-anchor="end">rise duration, hours (log scale)</text>`;

  const selPts = sel.sweep
    .slice()
    .sort((a, b) => a.rise_h - b.rise_h)
    .map((d) => `<circle class="dot-sel" cx="${X(d.rise_h).toFixed(1)}" cy="${Y(d.p).toFixed(1)}" r="3.5"/>`)
    .join(" ");
  const othPts = oth
    ? oth.sweep
        .map(
          (d) =>
            `<circle class="dot-oth" cx="${X(d.rise_h).toFixed(1)}" cy="${Y(d.p).toFixed(1)}" r="2.75"/>`,
        )
        .join(" ")
    : "";

  const labels = sel.sweep
    .slice()
    .sort((a, b) => a.rise_h - b.rise_h)
    .map((d) => {
      const x = X(d.rise_h);
      const y = Y(d.p) - 12;
      const anchor = d.rise_h === rises[0] ? "start" : d.rise_h === rises[rises.length - 1] ? "end" : "middle";
      return `<text class="val" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}">${pct(d.p)}</text>`;
    })
    .join("");

  const ownX = X(sel.rise_hours);
  const ownP = sel.sweep.find((d) => d.rise_h === sel.rise_hours);
  const ownAnchor = ownX < ml + 60 ? "start" : ownX > W - mr - 60 ? "end" : "middle";
  const ownMark =
    `<line class="own-line" x1="${ownX.toFixed(1)}" y1="${mt - 6}" x2="${ownX.toFixed(1)}" y2="${(mt + ph).toFixed(1)}"/>` +
    `<text class="own-tag" x="${ownX.toFixed(1)}" y="${mt - 16}" text-anchor="${ownAnchor}">${sel.rise_hours} h rise</text>` +
    (ownP
      ? `<circle class="dot-own" cx="${ownX.toFixed(1)}" cy="${Y(ownP.p).toFixed(1)}" r="5.5"/>`
      : "");

  const othPath = oth ? `<path class="series-oth" d="${seriesPath(oth.sweep)}"/>` : "";

  const summary =
    `${sel.name}: ${sel.sweep.map((d) => `${pct(d.p)} at ${d.rise_h} hours`).join(", ")}. ` +
    (oth
      ? `${oth.name}: ${oth.sweep.map((d) => `${pct(d.p)} at ${d.rise_h} hours`).join(", ")}.`
      : "");

  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${summary}">` +
    `${grid}${band}${hint}${xaxis}` +
    `${othPath}<path class="series-sel" d="${seriesPath(sel.sweep)}"/>` +
    `${othPts}${selPts}${ownMark}${labels}</svg>`;

  $("#sweep-note").textContent =
    `Each line is the share of randomly timed floods of that rise length with at least ` +
    `one acquisition inside the rise. Computed by sliding the window across every day of ` +
    `the record in 1 hour steps, using the actual acquisition times. The horizontal ` +
    `axis is logarithmic, so the tested durations are spaced across the range rather ` +
    `than bunched at the short end.`;
}

/* ---- 03 gaps ---- */

function renderHist() {
  const b = basin();
  const { edges, counts } = b.gap_hist;
  const host = $("#hist");
  const max = Math.max(...counts, 1);
  const box = Math.max(96, (host.clientHeight || 172) - 58);

  host.innerHTML = counts
    .map((c, i) => {
      const lo = edges[i];
      const hiEdge = edges[i + 1];
      const last = i === counts.length - 1;
      // Every gap at or above the final edge lands in the last bin, so it is open ended.
      const label = last ? `${lo}+` : `${lo}–${hiEdge}`;
      const isTail = lo >= 48;
      const h = Math.max(3, Math.round((c / max) * box));
      const delay = reduceMotion ? 0 : i * 45;
      return `<div class="col${isTail ? " tail" : ""}">
        <div class="cap">${c}</div>
        <div class="bar" style="height:${h}px;animation-delay:${delay}ms"></div>
        <div class="tick">${label}</div>
      </div>`;
    })
    .join("");
}

function renderStats() {
  const b = basin();
  const items = [
    [`${num(b.median_gap_h)} h`, "median gap", false],
    [`${num(b.p95_gap_h)} h`, "95th percentile", false],
    [`${num(b.max_gap_h)} h`, "longest gap", true],
    [String(b.gaps_over_48h), "gaps over 48 h", true],
    [String(b.per_day), "looks per day", false],
  ];
  $("#stats").innerHTML = items
    .map(([v, k, hi]) => `<div class="${hi ? "hi" : ""}"><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");
}

/* ---- 04 clock ---- */

function renderClock() {
  const b = basin();
  const byHour = new Map(b.clock_hours.map((c) => [c.hour, c.n]));
  const lit = [...byHour.keys()].sort((x, y) => x - y);

  let cells = "";
  for (let h = 0; h < 24; h++) {
    const n = byHour.get(h) || 0;
    cells += `<div class="${n ? "c on" : "c"}" title="${pad2(h)}:00 UTC, ${n} looks"></div>`;
  }
  $("#clock").innerHTML = cells;

  const old = document.querySelector("#clock + .clock-axis");
  if (old) old.remove();
  let axis = "";
  for (let h = 0; h < 24; h++) {
    axis += `<span>${h % 6 === 0 ? pad2(h) : ""}</span>`;
  }
  $("#clock").insertAdjacentHTML("afterend", `<div class="clock-axis" aria-hidden="true">${axis}</div>`);

  $("#clock-note").textContent =
    `All ${b.n_acquisitions} looks in the record land on ${lit.length} of the 24 hours. ` +
    `Everywhere else in the day, no look is possible at all. The gap distribution ` +
    `above shows what that produces.`;
  $("#clock-lit").innerHTML =
    `hours with looks: <b>${lit.map((h) => `${pad2(h)}:00`).join(", ")} UTC</b>`;
}

/* ---- 05 blackout ---- */

function renderBlackout() {
  const b = basin();
  const w = b.worst_gap;
  const fits = Math.floor(w.hours / b.rise_hours);

  $("#blackout-num").innerHTML = `${num(w.hours)}<span>hours</span>`;
  $("#blackout-range").innerHTML =
    `<div><dt>from</dt><dd>${w.from} UTC</dd></div>` +
    `<div><dt>to</dt><dd>${w.to} UTC</dd></div>`;

  const note =
    fits > 1
      ? `A ${durAdj(b.rise_hours)} rise fits inside this gap <b>${fits} times over</b>. ` +
        `That is ${fits} separate floods that could each have risen and peaked without a single look.`
      : `A ${durAdj(b.rise_hours)} rise fits inside this gap <b>with room to spare</b>, and nothing observed it.`;
  $("#blackout-note").innerHTML = note;
}

/* ---- 06 timeline ---- */

function renderTimeline() {
  const b = basin();
  const tl = b.timeline;
  const host = $("#timeline");
  const W = Math.max(300, Math.round(host.clientWidth || 680));
  const H = 128;

  const t0 = Date.parse(tl[0].t);
  const t1 = Date.parse(tl[tl.length - 1].t);
  const X = (t) => ((t - t0) / (t1 - t0)) * W;

  const tickTop = 20;
  const tickBot = 42;
  const baseY = 108;
  const capH = 44;
  // Scale to the basin, so a 288 hour gap is not silently clamped to a 96 hour ceiling.
  const capHours = Math.max(96, Math.ceil(b.max_gap_h / 48) * 48);
  const Yg = (h) => baseY - (Math.min(h, capHours) / capHours) * capH;

  let ticks = "";
  let bars = "";
  tl.forEach((p, i) => {
    const x = X(Date.parse(p.t));
    ticks += `<line class="tick" x1="${x.toFixed(1)}" y1="${tickTop}" x2="${x.toFixed(1)}" y2="${tickBot}"/>`;
    if (i > 0 && p.gap_h) {
      const prevX = X(Date.parse(tl[i - 1].t));
      const w = Math.max(1, x - prevX - 0.4);
      const y = Yg(p.gap_h);
      bars += `<rect class="gapbar" x="${prevX.toFixed(1)}" y="${y.toFixed(1)}" ` +
        `width="${w.toFixed(1)}" height="${(baseY - y).toFixed(1)}"/>`;
    }
  });

  let months = "";
  const cursor = new Date(t0);
  cursor.setUTCDate(1);
  cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  while (cursor.valueOf() < t1) {
    const x = X(cursor.valueOf());
    const name = cursor.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
    months += `<line class="month" x1="${x.toFixed(1)}" y1="${tickTop - 6}" x2="${x.toFixed(1)}" y2="${baseY}"/>`;
    months += `<text class="mlabel" x="${(x + 4).toFixed(1)}" y="${H - 6}">${name}</text>`;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const ref = Yg(48).toFixed(1);
  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" ` +
    `aria-label="Acquisition times across the year with gap lengths drawn below the axis, ` +
    `worst gap ${num(b.max_gap_h)} hours.">` +
    `<line class="rule" x1="0" y1="${baseY}" x2="${W}" y2="${baseY}"/>` +
    `${months}` +
    `<line class="gapref" x1="0" y1="${ref}" x2="${W}" y2="${ref}"/>` +
    `${bars}${ticks}</svg>`;

  $("#timeline-note").textContent =
    `${b.gaps_over_48h} gaps exceed 48 hours, drawn above the dashed line. ` +
    `${b.gaps_over_72h} exceed 72 hours. The tallest bar is the ${num(b.max_gap_h)} hour blackout.`;
}

/* ---- 07 the forecast ---- */

async function loadForecast() {
  try {
    const res = await fetch("/api/forecast");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    FORECAST = await res.json();
  } catch (err) {
    FORECAST = null;
    forecastError = err.message;
  }
  renderForecast();
}

function spark(row) {
  const s = row.series || [];
  const vals = s.map((p) => p.q).filter((v) => v != null);
  if (vals.length < 2) return "";

  const W = 240;
  const H = 46;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = (max - min) || 1;
  const lo = min - span * 0.12;
  const hi = max + span * 0.12;
  const X = (i) => (i / (s.length - 1)) * W;
  const Y = (v) => H - ((v - lo) / (hi - lo)) * H;

  const path = (from, to) => {
    let d = "";
    let pen = false;
    for (let i = from; i < to; i++) {
      const q = s[i].q;
      if (q == null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(q).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const split = row.split_index ?? 0;
  const base =
    row.baseline_median_m3s != null
      ? `<line class="base" x1="0" y1="${Y(row.baseline_median_m3s).toFixed(1)}" ` +
        `x2="${W}" y2="${Y(row.baseline_median_m3s).toFixed(1)}"/>`
      : "";

  let peakAt = -1;
  let peakVal = -Infinity;
  for (let i = split; i < s.length; i++) {
    if (s[i].q != null && s[i].q > peakVal) {
      peakVal = s[i].q;
      peakAt = i;
    }
  }
  // A vertical tick, not a dot: the viewBox is stretched, so a circle would distort.
  const marker =
    peakAt >= 0
      ? `<line class="pk" x1="${X(peakAt).toFixed(1)}" y1="${(Y(peakVal) - 4).toFixed(1)}" ` +
        `x2="${X(peakAt).toFixed(1)}" y2="${(Y(peakVal) + 4).toFixed(1)}"/>`
      : "";

  return (
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" ` +
    `aria-label="Past 30 days and 30 day forecast, peak ${row.peak_m3s} cubic metres per second on ${row.peak_date}">` +
    `${base}<path class="past" d="${path(0, split)}"/>` +
    `<path class="fcst" d="${path(Math.max(0, split - 1), s.length)}"/>${marker}</svg>`
  );
}

function renderForecast() {
  const host = $("#forecast");
  if (!host) return;

  if (!FORECAST) {
    host.innerHTML = `<p class="fc-empty">${
      forecastError
        ? `No forecast available (${forecastError}). Run <code>python3 forecast.py</code> to refresh it.`
        : "Loading the forecast"
    }</p>`;
    return;
  }

  const meta = (id) => DATA.basins.find((b) => b.id === id) || { name: id, country: "" };

  host.innerHTML = FORECAST.basins
    .map((row) => {
      const m = meta(row.id);
      const on = row.id === current ? " is-current" : "";
      const head =
        `<div class="fc-name"><span class="fc-basin">${m.name}</span>` +
        `<span class="fc-country">${m.country}</span></div>`;

      if (!row.ok) {
        return `<div class="fc-row">${head}<div class="fc-spark"></div><div></div>` +
          `<div class="fc-conf"><span class="fc-pct blind">n/a</span>` +
          `<span class="fc-conf-label">no forecast returned</span></div></div>`;
      }

      const cls = row.confirm_p >= 0.7 ? "ok" : row.confirm_p < 0.3 ? "blind" : "mid";
      return `<div class="fc-row${on}">
        ${head}
        <div class="fc-spark">${spark(row)}</div>
        <div class="fc-peak">
          <span class="fc-val">${row.peak_m3s}</span><span class="fc-unit">m³/s</span>
          <span class="fc-when">peak ${row.peak_date}<br>${row.peak_vs_baseline}× the 30-day median</span>
        </div>
        <div class="fc-conf">
          <span class="fc-pct ${cls}">${Math.round((row.confirm_p || 0) * 100)}%</span>
          <span class="fc-conf-label">of peaks checkable within a day</span>
        </div>
      </div>`;
    })
    .join("");

  $("#fc-fignote").textContent =
    `${FORECAST.source}, issued ${FORECAST.issued_at}. Sampling: ${FORECAST.sample_rule}. ` +
    `Checkable means a Sentinel-1 look within ${FORECAST.confirm_half_window_h} hours either ` +
    `side of the forecast peak. No flood threshold is applied: the peak is simply the ` +
    `maximum of the forecast window, which exceeds the median in any normal month, so ` +
    `these are discharge figures, not warnings. ${FORECAST.limits}`;
}

/* ---- rail ---- */

function renderProvenance() {
  $("#provenance").innerHTML =
    `collection <code>${DATA.collection}</code><br>` +
    `window <code>${DATA.window}</code><br>` +
    `computed <code>${DATA.generated_at}</code><br>` +
    `endpoint <code>/api/data</code><br>` +
    `refresh <code>python3 ingest.py</code>`;
}

/* ---- map ---- */

const bboxBounds = (bbox) => [
  [bbox[0], bbox[1]],
  [bbox[2], bbox[3]],
];
const ring = (bbox) => {
  const [w, s, e, n] = bbox;
  return [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
};

function initMap() {
  const host = $("#map");
  if (!window.maplibregl) {
    host.innerHTML =
      `<div style="padding:18px;font:400 12px/1.7 ui-monospace,monospace;color:#7c8b96">` +
      `The map library did not load from its CDN. Every statistic on this page is ` +
      `computed locally, so the finding is unaffected.</div>`;
    return;
  }

  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        base: {
          type: "raster",
          tiles: [
            "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          attribution:
            "Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community",
        },
      },
      layers: [
        {
          id: "base",
          type: "raster",
          source: "base",
          // The basemap is context, not subject: darken it so the basin box stays primary.
          paint: { "raster-brightness-max": 0.52, "raster-saturation": -0.35 },
        },
      ],
    },
    center: [9.6, 48.6],
    zoom: 4.2,
    attributionControl: false,
  });

  map.on("idle", () => {
    host.dataset.loaded = "1";
  });
  map.on("error", (e) => {
    host.dataset.error = (e && e.error && e.error.message) || "unknown map error";
  });

  map.on("load", () => {
    map.addSource("basins", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: DATA.basins.map((b) => ({
          type: "Feature",
          properties: { id: b.id, name: b.name },
          geometry: { type: "Polygon", coordinates: ring(b.bbox) },
        })),
      },
    });

    map.addLayer({
      id: "basin-fill",
      type: "fill",
      source: "basins",
      paint: { "fill-color": CYAN, "fill-opacity": 0.05 },
    });
    map.addLayer({
      id: "basin-line",
      type: "line",
      source: "basins",
      paint: { "line-color": "#38505d", "line-width": 1 },
    });
    map.addLayer({
      id: "basin-fill-active",
      type: "fill",
      source: "basins",
      filter: ["==", ["get", "id"], current],
      paint: { "fill-color": CYAN, "fill-opacity": 0.2 },
    });
    map.addLayer({
      id: "basin-line-active",
      type: "line",
      source: "basins",
      filter: ["==", ["get", "id"], current],
      paint: { "line-color": CYAN, "line-width": 1.75 },
    });

    map.on("click", "basin-fill", (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (id) select(id);
    });
    map.on("mouseenter", "basin-fill", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "basin-fill", () => (map.getCanvas().style.cursor = ""));

    const b = basin();
    if (b) map.fitBounds(bboxBounds(b.bbox), { padding: 50, maxZoom: 7.5, duration: 0 });
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => map && map.resize()).observe(host);
  }
}

function updateMap(animate) {
  if (!map || !map.getLayer("basin-fill-active")) return;
  const filter = ["==", ["get", "id"], current];
  map.setFilter("basin-fill-active", filter);
  map.setFilter("basin-line-active", filter);
  const b = basin();
  if (!b) return;
  map.fitBounds(bboxBounds(b.bbox), {
    padding: 50,
    maxZoom: 7.5,
    duration: animate && !reduceMotion ? 700 : 0,
  });
}

/* ---- responsive re-render ---- */

function onResize() {
  if (!DATA) return;
  const w = Math.round($("#sweep-chart")?.clientWidth || 0);
  if (Math.abs(w - lastChartWidth) < 4) return;
  lastChartWidth = w;
  renderSweep();
  renderTimeline();
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(onResize, 120);
});

boot();
