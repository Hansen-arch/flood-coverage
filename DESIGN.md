# Design direction

Owner's direction, in their words: minimalist, futuristic, and it should not look
like a generic analytics dashboard. Everything below is that direction turned
into decisions that can be checked.

Reading this as: **a findings page for a sceptical technical reader**, in a
**scientific instrument** visual language, dial **ENERGY 2 / RHYTHM 3 / MOTION 2**.

---

## The motif: presence is cyan, absence is amber

The page's argument is that not seeing something is the interesting event. So the
palette carries the argument rather than decorating it.

| Meaning | Colour |
|---|---|
| A look happened / a flood would be observed | cyan `#4ec9ff` |
| No look, or a threshold crossed | amber `#f0a44a` |

Nothing on the page uses either colour for any other purpose. The consequence is
the rule the whole piece is about: **absence is always drawn as a mark, never as
empty space and never as zero.** The year strip, the gap bars, the histogram
tail, and the headline number itself all obey it.

## Decisions and why

**Dark, fixed theme.** The subject is radar imagery and a dark basemap; a light
ground would put a luminous map next to luminous text and lose the data. The
figures stay the only bright thing on screen. No toggle is shipped, so there is
no second theme to break.

**Hairlines instead of cards.** Sections are separated by a single 1px rule, not
boxed. Boxing every panel makes seven sections look like one repeated component,
which is the dashboard default this page is avoiding. One rule per section also
gives the page its ledger-like rhythm.

**Numbered sections (01 to 07).** A real reading order on a document that is an
argument in sequence, not a set of equal widgets. It is the repeated typographic
gesture that makes the page belong to this piece rather than to a template.

**Monospace for figures only.** Every number on the page is a measurement that
changes when you switch basin. Tabular monospace keeps digits from shifting, and
it matches the axis labels and provenance block. Body copy is a separate
grotesque so the page does not read as terminal cosplay.

**The headline number changes colour with its own meaning.** Above 70% it is
cyan (observed), below 30% amber (blind). The reader learns the semantics from
the single most important element on the page before reading a word of legend.

**One focal point.** The percentage is the largest thing on screen by a wide
margin, and no other element competes: no gradient, no glow, no second accent.

**Log scale on the sweep chart.** The seven tested rise durations run from 3 hours
to a week. A linear axis would bunch the short ones at the left and imply a
resolution between them that does not exist. The axis is labelled as logarithmic.

**Two basins on one chart, paired by response class.** The comparison is the
argument, and switching tabs to compare two curves is work the chart should have
done. The selected basin is solid with value labels; the dashed line is the basin
with the same response class (flash or slow) on the other continent, so the gap
between the lines is cadence rather than hydrology. Differentiation is by weight
and line style, not by hue, because hue is spoken for.

**The forecast section breaks the per-basin pattern on purpose.** Everything above
it shows one basin at a time. The forecast compares all four in a single table,
because its question is comparative: whose forecast can be checked at all. The
selected basin is only marked with a background tint, not a stripe.

**Motion at MOTION 2.** Bars grow once on render and the headline figure
crossfades on basin change, both to signal "this is new data" after a switch, not
to decorate. Nothing loops. Everything is disabled under
`prefers-reduced-motion`.

**Amber never means "warning" generically.** It means "no observation", which is
why the longest blackout is the loudest amber moment on the page.

## Not used, deliberately

No background grid, no glow, no glass, no gradients, no badges, no icons, no
illustrations, no fake terminal window, no emoji. Each was considered and cut for
the same reason: none of them carries a fact, and this page has real facts to
carry.
