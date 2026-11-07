# 03 - Method: flood observation coverage

*Status: current method note, 2026-11-07. Portfolio context, not commercial. The
framing it applies is `01` (observation age, not processing latency).*

## The claim

**Flood monitoring is coverage-limited, not latency-limited.**

A flood-extent map is a commodity. Copernicus publishes a global, fully
automated, 20 m flood layer with a median latency under 8 hours, free and open.
Rebuilding it would demonstrate nothing.

The unoccupied angle is the opposite one. The map arrives fast; the problem is
that it arrives for a 3 to 6 day snapshot of a phenomenon that evolves in hours.
A dashboard that makes *the age and coverage of knowledge* the primary object is
both truthful and, as far as I can find, not something anyone ships.

## 1. What is verified about latency

| Component | Cadence | Latency | Access |
|---|---|---|---|
| **Sentinel-1 SAR** (C+D) | 3-6 day revisit by latitude | NRT ≤3 h | Open [V] |
| **GFM** (CEMS Global Flood Monitoring) | continuous | **<3 h best case; <8 h for >99%** of scenes | Open, WMS-T / REST / STAC [V] |
| **GloFAS** forecast | daily | 51-member ensemble, 15 d at ~9 km, to 30 d at ~36 km | Open, registration [V] |
| **CEMS Rapid Mapping** | on demand | hours to 1-2 days; SL2 ≤5 d | API + vector tiles [V] |
| **Map product for a specific event** | - | **8 h** best documented case | see below [V] |

The 8-hour case is the most instructive number in the domain. During the June
2025 west-Ukraine floods (EMSR444), the first flood extent was delivered
**eight hours after the service was triggered**, and the reason was not a faster
satellite. It was that the SAR acquisition had been **pre-tasked off EFAS
forecast information** as a standing CEMS activity [V].

> The fastest flood map in the record was bought by a forecast, not by a
> satellite.

That generalises: in an operational emergency service, the way to be fast is to
acquire *before* the event, which means the forecast is doing the latency work.
Latency is a solved problem. Coverage is not.

## 2. The two real limits, both admitted by the operators

**Revisit, not processing.** GFM's own material states a revisit of **3 to 6 days
depending on location** [V]. A flood's rise and recession can run in hours to a
few days [V]. So a "current flood extent" layer is frequently a snapshot of a
different flood than the one happening now, and nothing in a conventional
dashboard communicates that. This is the `01` problem in its newest form:
observation age, not processing latency.

**Coverage gaps in the forecast.** GloFAS states its own limitation plainly:

> "GloFAS prediction only focuses on rivers and does not provide real-time
> forecast information on flash flood risk or coastal flooding, nor on inundated
> areas." [V]

Flash floods are the lethal subset and the one the global forecast system
explicitly does not cover. Any dashboard that renders a green "no forecast
exceedance" for a basin has quietly implied safety in a category the model does
not model. That is the "absence rendered as zero" failure, transplanted to
hydrology.

**Detection errors, also admitted.** GFM's 2026 review lists **over-detection
from water look-alikes** and **under-detection under dense vegetation, windy
conditions and in urban areas** [V]. The product ships a likelihood layer, an
exclusion mask and **advisory flags** for challenging conditions [V]. That
matters twice: the uncertainty-first idea is partly already implemented upstream,
and it gives a reference implementation to measure against.

## 3. The metric

For a basin, a flood's rise is a window of hours (`rise_hours` in `basins.py`).
The question is whether that window contains at least one usable Sentinel-1 look.

The probability is computed **empirically**, not modelled. Take one year of real
acquisition timestamps from STAC, slide the rise window across the year in one
hour steps, and count the fraction of window positions that contain a look:

```
P(rise is observed) = |{t : a look falls in [t, t + rise_hours]}| / |{t}|
```

This is why the numbers differ from the nominal revisit figure. A 6-day revisit
does not mean a 6-hour event is seen 1 time in 24; it depends on how the passes
cluster, and passes cluster hard. The method also reports the raw gap
distribution, so the same year can be read at any rise time without re-running.

Rise times are assumptions, not measurements: 48 hours for a large lowland
river, 6 hours for a steep or urban catchment, 168 hours for a peatland river.
The sweep exists so the conclusion can be read at any rise time instead of
resting on one guess.

## 4. Results

One year of Sentinel-1 acquisition metadata, same collection, same window, same
method for all four basins. 694 distinct overpasses in total.

| basin | looks/yr | looks/day | median gap | 6 h rise seen | 48 h rise seen | own rise seen |
|---|---|---|---|---|---|---|
| Po, IT | 315 | 0.87 | 24.0 h | 21% | 91% | 90% at 48 h |
| Ahr, DE | 250 | 0.69 | 24.0 h | 17% | 91% | 17% at 6 h |
| Siak, Riau | 78 | 0.22 | 120.1 h | 5% | 39% | 99% at 168 h |
| Ciliwung, Jakarta | 51 | 0.14 | 203.3 h | 3% | 28% | 3% at 6 h |

The constraint is the ratio of cadence to rise time, not latitude. Riau has a
five-day median gap, so it catches a week-long peat flood 99% of the time and a
six-hour one 5% of the time. Jakarta has an eight-and-a-half-day median gap, so a
flash flood is essentially never observed while it is rising.

**A basin can be simultaneously "monitored" and unwatched.**

The Po and the Ahr have nearly identical cadence (0.87 and 0.69 looks per day,
both with a 24 hour median gap) and land in completely different places: 90%
versus 17%. Nothing about the satellites changed. The rise time did.

### The forecast layer

GloFAS is already a free 30 day river discharge forecast, so predicting is not
the hard part. The question is whether the prediction can be **checked**. Each
forecast peak is paired with the measured chance that a look lands within 24
hours of it:

| basin | forecast peak | date | vs 30-day median | peak checkable within a day |
|---|---|---|---|---|
| Po | 2746.9 m3/s | 2026-11-22 | 3.2x | 91% |
| Ahr | 5.7 m3/s | 2026-11-15 | 6.8x | 91% |
| Siak, Riau | 447.8 m3/s | 2026-11-23 | 3.6x | 39% |
| Ciliwung, Jakarta | 34.0 m3/s | 2026-11-24 | 4.8x | 28% |

Europe can check its own forecast. Jakarta cannot. For 72% of forecast peaks, no
Sentinel-1 look lands within a day, so the forecast is issued, acted on, and
never verified.

Two caveats are load-bearing and are printed under the section in the app:
the maximum of any 30 day window exceeds its median, so 3x normal is ordinary
and these are discharge figures, not warnings; and GloFAS samples a 5 km grid, so
small steep catchments are not resolved.

## 5. What the numbers do not show

- **No flood threshold is applied.** The forecast peak is simply the maximum of
  the forecast window. Nothing here says a flood will happen.
- **River discharge only.** No flash flood, coastal flood or inundation extent.
- **The bbox is a query box, not a catchment.** The probability describes the
  acquisition record over that box, not flow at a pour point.
- **Absence is not zero.** A gap means no look, not no water.
- **Rise times are order-of-magnitude assumptions.** The sweep shows how much the
  answer moves when they are wrong, which is the honest substitute for a
  calibration that was not done.

## Sources

All accessed 2026-11-07.

- CEMS, *GFM: Global Flood Monitoring* (Sentinel-1 based, three-algorithm
  ensemble, 20 m, archive from 2015, continuous processing):
  https://global-flood.emergency.copernicus.eu/technical-information/glofas-gfm
- EODC/CEMS, *Global Flood Monitoring: a short intro* (Apr 2026; **<3 h best
  case, <8 h for >99%**; **revisit 3-6 days by location**; S-1C/D integration):
  https://global-flood.emergency.copernicus.eu/media/events/9/gfm_intro_glofas_am_2026-tobias.pdf
- CEMS, *Evolution of GFM* (Apr 2026; over-detection from water look-alikes;
  under-detection under dense vegetation, wind, urban):
  https://global-flood.emergency.copernicus.eu/media/events/9/salamon_evolution_gfm_april2026.pdf
- CEMS, *GFM poster* (likelihood values, exclusion mask, advisory flags,
  **S-1 schedule for the next 3 days**):
  https://european-flood.emergency.copernicus.eu/sites/default/files/AM/AM2025/AM2025pdf/Poster/GFM_Poster_EFAS_AM_2025.pdf
- Copernicus, *EMS forecasts and monitors flood in West-Ukraine and Romania*
  (**first flood extent 8 h after service trigger, from SAR pre-tasked off EFAS**;
  EMSR444): https://www.copernicus.eu/sl/print/pdf/node/8775
- CEMS, *About GloFAS* (daily forecasts; **rivers only, no flash flood, no
  coastal, no inundation extent**):
  https://global-flood.emergency.copernicus.eu/general-information/about-glofas
- CEMS, *GloFAS 30-day medium-range forecasts* (51-member ECMWF ENS, ~9 km to
  15 d, 36 km to 30 d):
  https://global-flood.emergency.copernicus.eu/technical-information/glofas-30day/
- ESA, *Sentinel-1 facts and figures* (six-day revisit at the equator from the
  two-satellite constellation):
  https://www.esa.int/Applications/Observing_the_Earth/Copernicus/Sentinel-1/Facts_and_figures
- ESA, *Sentinel-1 orbital reconfiguration dates* (S-1A operations terminated
  29 Jun 2026; final C/D configuration):
  https://sentinels.copernicus.eu/-/sentinel-1-orbital-reconfiguration-dates
- Politecnico di Torino et al., *Advancing flood detection and mapping: a review*
  (Nov 2026; Rapid Mapping "within hours or days"; SAR as the primary dataset
  for delineation; clouds can persist for days during flood events):
  https://iris.polito.it/retrieve/handle/11583/3006135/7efb3889-6ff5-48ae-b37d-fdfd3fe2fc01/remotesensing-17-02943%20%281%29.pdf
- Open-Meteo, *Flood API* (GloFAS v4 river discharge forecast, no key):
  https://open-meteo.com/en/docs/flood-api
