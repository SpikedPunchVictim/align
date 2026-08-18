# ADR 005: Verification Freshness

**Status**: Accepted

## Context

Trust in a verification oracle is binary, not gradual. The spike's fix-loop test (probe 2) put this beyond
theory: the spike server's scan-once session cache kept serving byte-identical violation reports after the
connected agent had already fixed all three issues. The agent detected the staleness **in one iteration**,
concluded the tool was "static/canned … not a real dependency-graph analyzer," refused to continue the
fix loop, and advised distrusting the tool entirely. One stale verdict destroyed trust permanently — there
was no partial-credit recovery, no "well it's usually right." This is the single most consequential finding
of Stage S and it overrides the plan's original cache-first framing.

Separately, probe 3 measured whether freshness is affordable: a full warm rescan (in-process, warm V8,
fresh resolver each pass — the shape of a long-lived MCP server's re-check) costs **1,374 ms mean / 1,652 ms
p95** at 456K LOC, actually *faster* than the 2.2 s cold scan. At 3.23M LOC (n8n), a full scan costs 12.9 s.

## Decision

**The oracle never answers from state older than the code it judges. No exceptions, no configuration flag
that weakens this.** Concretely for v1:

1. **Rescan-on-check**: every `align_check` / `align check` invocation performs a full fresh scan before
   evaluating any rule. There is no result cache, no partial-invalidation path, and no "trust the last scan
   if nothing looks like it changed" shortcut in v1 — the shortcut is exactly the mechanism that broke trust
   in probe 2.
2. **Empirical promotion trigger, not a schedule**: the six-component content-hash cache key design (kept in
   full in `IMPLEMENTATION_PLAN.md`, Design Reserve) is promoted from paper to implementation only when
   checks on the target repo class exceed **~10 s** — a threshold anchored directly between the measured
   1.37 s (456K LOC) and 12.9 s (3.23M LOC) data points, not a guess.
3. **If/when a cache is promoted, it inherits an absolute rule from this ADR**: any promoted caching
   mechanism must be provably content-hash-invalidated, never staleness-tolerant-by-design, and must ship
   with the false-green invariant test suite (ADR 004/006 territory) before it can be relied on for a
   verdict. This ADR is not "no caching forever" — it's "no caching whose failure mode is a plausible-looking
   wrong verdict."

## Alternatives considered

- **TTL-based cache (e.g., "trust a scan up to N seconds old").** Rejected directly by probe 2: the agent's
  distrust wasn't proportional to how stale the data was — it was categorical the moment staleness was
  detected at all. A TTL just changes how long it takes to hit the same failure.
- **File-watch invalidation (chokidar-style) instead of rescan-on-check.** Rejected for v1: this is exactly
  the Stage 5 `align watch` design (event-driven, debounced) — a different product surface (background
  process) with different freshness semantics (best-effort near-real-time, not verified-at-answer-time). An
  MCP tool call must answer for *this* invocation, not "as of the last file-watch event."
- **Ship the six-component cache key in v1, gated behind a flag.** Rejected: probe 3's own numbers argue
  against needing it yet (1.37 s doesn't justify the false-green surface area a cache introduces), and a
  flag that can be left on defeats the "no exceptions" posture — the cache-key design stays fully specified
  on paper (Design Reserve) so nothing is redesigned at promotion time, but it does not ship inert in v1
  code.

## Consequences

- v1's `GateResult.cacheHits` field (contract fixed in `docs/core-interfaces.md` for the growth path) is
  always `0` — the field exists so a later cache doesn't require a payload shape change, not because v1
  caches anything.
- Every `align_check` on a 3M-LOC-class repo costs ~13 s. This is a known, accepted v1 cost, not an
  oversight — documented here so Stage 1+ doesn't "fix" it by quietly reintroducing a staleness risk.
- The promotion trigger is a single number (~10 s) that a future ADR amendment can point at directly when
  deciding to build the cache — no re-litigation of the freshness doctrine itself, only "has the threshold
  been crossed."

## Evidence

- Probe 2 (spike report, "Fix-loop test... a v1 hard requirement discovered"): scan-once session cache
  served byte-identical stale violations after real fixes; agent detected staleness in one iteration,
  concluded the tool was fake, refused to continue, advised permanent distrust.
- Probe 3 (spike report, extension section): warm full-rescan mean **1,374 ms**, p95 1,652 ms, min/max
  1,178/2,545 ms, RSS bounded at 300 MB after 20 rescans (no leak signal) — 456K LOC.
- Cold-scan baseline: 2.16–2.33 s / 456K LOC (spike Q1); 12.9 s / 3.23M LOC (probe 4, n8n) — the anchor
  points for the ~10 s promotion trigger.
- Plan cross-reference: "the cache that probe 3 proved *unnecessary*, probe 2 proved *actively harmful*"
  (`IMPLEMENTATION_PLAN.md`, Stage S).
