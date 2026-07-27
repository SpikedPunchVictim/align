# ADR 019: Co-change-informed rule suggestion (onboarding + retrofit)

**STATUS: ACCEPTED (v1 = import-graph-only) — owner sign-off 2026-07-24.** The Fable review demanded the
arm the original draft skipped: co-change ranking vs. import-graph-only ranking. It was run, and
co-change largely failed it — so the co-change git-history pass is **cut from v1**; what ships is the
import-graph-only Mode-2 gap report + Mode-1 ranking below. Co-change stays deferred behind the
decision-flip test in § Falsification. Original co-change framing retained below the Decision for the
record. Build target for reconciled-build-order #3 is **Mode 2 (the ungoverned-edge gap report)**.

> ADR numbering: 016/017 in flight on `stage0-surface-inference`; 018 on main. This is 019.

## Placebo-test result (the measurement that rescoped this ADR)

align already builds the import graph; component **fan-in** and **edge-weight** are one aggregation away,
**no new mechanism**. Measured on directus:
- **Fan-in alone surfaces the foundation layer** — `@directus/types` (22 importers), `utils` (18),
  `constants` (11) top the fan-in ranking. The onboarding demo's "the foundation fell out of co-change"
  is **redundant with import fan-in**; the git-history pass added nothing to that result.
- **Co-change vs. edge-weight top-12 overlap = 6/12.** Where they diverge, edge-weight surfaces *stable,
  heavy* dependencies (`api↔errors` 198 imports, `types↔utils` 35) while co-change surfaces *churny* ones
  (`storage-driver↔utils`). Per ADR 009's day-one-green doctrine, the **stable** deps are the better rule
  candidates — the exact pairs co-change **down-ranks**. Co-change's unique signal (recency/hotness) is
  thus a *plausibly wrong* prior for encoding settled architecture.
- Co-change's one genuinely non-redundant payload — hidden no-edge implicit contracts (PROBE.md class 4)
  — is **out of scope** here (nothing to enforce). So the expensive pass would be kept for a sort key the
  static graph already provides.

**Conclusion:** within this ADR's scope (import-coupled pairs), co-change is a more-expensive proxy for
import centrality, ranking by a prior (churn) that is arguably wrong for the goal. Cut it from v1.

## Context

align's real adoption barrier is not detection — it's **config friction**: on an un-governed repo you
face a blank `align.config.ts` and must decide, out of hundreds of possible component pairs, which
boundaries to write rules for. align's existing suggestion surfaces (`align init`'s layer macros, the
`align_propose_rules` MCP tool) are **structural only** — they can list components and obvious layers,
but they can't tell you which boundaries *matter*.

The co-change probe (`docs/evidence/co-change-coupling/PROBE.md`) established the missing signal:
**logical (co-change) coupling — how often two components change in the same commit — intersected with
the import graph.** Co-change alone is 70-93% inherent noise (full-stack, ecosystem cadence, tests);
intersecting it with align's import graph collapses that to the handful of boundaries a rule can
actually govern, *ranked by how much they churn*. Two demonstrations proved the payoff:

- **Onboarding (directus, no prior knowledge):** ranking import-coupled pairs by co-change made the
  **foundation layer fall out automatically** — `types`/`utils`/`env` surfaced as "everything depends
  on them" (`api → types` 84%, `app → utils` 71%), `api`/`app` as top consumers. 467 high-co-change
  pairs with no import edge were correctly filtered out. Blank-config paralysis → ~12 evidence-ranked
  decisions in dependency order.
- **Retrofit (kluster, already align'd):** intersecting co-change against kluster's *existing* rules
  surfaced a real **gap** — `apiPlugins → apiDb` (87%), `apiPlugins → apiServices` (76%) are churny,
  import-coupled, and **ungoverned** (no existing rule constrains what plugins may depend on). A
  specific, reviewable question the owner can judge: *should Fastify plugins reach into the db directly,
  or go through services?*

## Decision (v1 — import-graph-only; co-change deferred)

Enhance the existing suggestion surfaces (`align init`, `align_propose_rules`) with an **import-graph-
derived ranking** — **no git-history pass**. Not a new rule kind and not enforcement; suggestions a human
confirms.

### Inputs (all already computed by align — zero new extraction pipeline)
- **Import graph with weights**: component-level edge-weight (import-site count) and **fan-in** (distinct
  importers) — one aggregation over the edges `scanner.ts` already emits. This is the ranking signal.
- **Existing ruleset** (retrofit mode only): the loaded `align.config.ts` rules.
- **~~Co-change~~ — CUT from v1.** The placebo test showed it's redundant with fan-in for the foundation
  and diverges toward the wrong (churn) prior. Deferred behind the § Falsification decision-flip test; if
  it ever earns its keep, it's a *secondary* sort ("govern where change is active"), never the primary.

### Mode 1 — onboarding (blank/sparse config)
Rank component import edges by **fan-in / edge-weight**; emit candidate dependency-direction rules in
dependency order (high-fan-in foundation at the bottom), each with the import-weight as rationale. The
human accepts/edits/rejects; align writes the accepted ones. (On directus this surfaces
`types`/`utils`/`constants` as the foundation with no git mining. On small repos this largely overlaps
ADR 009's existing layer macros; the added value is per-edge weighting + accept/reject copy, and it earns
its place mainly on large repos — backstage 255 pkgs / 1,490 edges — where raw edge existence isn't a
ranking.)

### Mode 2 — retrofit (existing ruleset)
Enumerate component import edges **not covered by any existing rule** = the gap list (a pure-graph
computation). Rank by edge-weight/fan-in. This is ongoing rule-*health*, `align doctor`-shaped
(dev-loop lever 3b). On kluster this yields the real `apiPlugins → apiDb` / `apiPlugins → apiServices`
gaps once composition roots are excluded (below).

**"Covered" is direction-aware for `arch.layers`.** A `layer(L).canOnlyDependOn(...)` rule fully
enumerates L's allowed *outbound* set, so it covers every edge `L → X` — but it says nothing about
who may import L, so an inbound edge `Y → L` from an unruled `Y` remains an undecided boundary and
IS reported. (An `arch.no-dependency` naming a pair, by contrast, marks that pair decided in either
direction — deciding `A cannotDependOn B` means the A/B boundary was considered.) Target-side
suppression for layers would hide exactly the partial-layering gaps this report exists to surface
(the common retrofit state: a few layer rules declared, most boundaries still open).

### Precision-critical
- **Exclude composition roots by explicit declaration, not a heuristic.** kluster's `api` catch-all
  legitimately depends on every sub-layer; a fan-out/glob-breadth heuristic can't distinguish a
  legitimate root from a god-component (and would suppress the god-component — the *most* important gap).
  Per this repo's explicit-over-implicit standard, the human declares `compositionRoots: ['api']` once in
  config; no threshold tuning, no wolf-crying. (After that, kluster's real gap list is ~2-3 edges — small
  enough that ranking barely matters, which is itself part of why co-change is unnecessary here.)
- **Suggest, never auto-apply.** The graph tells you `apiPlugins → apiDb` is a load-bearing, ungoverned
  edge; it cannot tell you whether that direction is *intended* (usually) or a smell to invert.
  Bidirectional edges are flagged as cycle-risk, but the human decides.

## Falsification / validation plan

**For v1 (import-graph-only):** run Mode 1 on directus/n8n + a mid-size untooled repo and Mode 2 on
kluster + align's own repo; a maintainer judges whether the top-N suggested rules / gaps are ones they'd
accept, and whether `compositionRoots` cleanly removes the catch-all noise. Cheap; the mechanism is
already-computed graph data.

**The gate for ever building the co-change pass — the decision-flip test (Fable's demand, partly run):**
emit top-N suggestions ranked (arm A) by import fan-in/edge-weight vs. (arm B) by co-change, and measure
**whether any human accept/reject decision flips** between arms. *Partial result (directus):* fan-in
alone surfaces the foundation; top-12 overlap 6/12, and the co-change-only pairs skew to churny (not
better) candidates — no evidence a decision flips in co-change's favor. Until a repo shows co-change
producing a *better* accept/reject decision than fan-in, the pass is not built. Zero decision-flips ⇒
co-change stays cut.

## Out of scope
- **Enforcing co-change coupling** — there is nothing to gate (no import edge for the hidden pairs); this
  is suggestion, not a rule kind.
- **The hidden-coupling residue** (implicit contracts like SDK↔scaffolder) — at most a *human prompt*
  ("undocumented contract here?"), reserve, not part of this ADR.
- **Auto-applying suggested rules** — always human-confirmed; align writes only accepted rules.
- **Longitudinal erosion tracking** (rising co-change across a decoupled boundary as a drift alarm) —
  a natural follow-on, but out of scope here.

## Alternatives considered
- **Co-change alone (no import intersection).** Rejected on measured evidence: 70-93% inherent noise;
  unusable as a suggestion source without the graph intersection.
- **Structural-only suggestion (status quo).** Keeps the blank-config problem — lists components with no
  sense of which boundaries matter. The demonstrations show co-change adds the missing prioritization.
- **Auto-generate and apply rules.** Rejected: direction/intent is a human judgment (a load-bearing
  dependency is usually fine, occasionally a smell); auto-applying would encode guesses as gates.

## Consequences (v1)
- **No new extraction pipeline.** Ranking is an aggregation over the import edges align already scans;
  gap-finding is edges-minus-ruleset. The git-history co-change pass is **not built** in v1.
- `align init` / `align_propose_rules` gain edge-weight/fan-in ranking (onboarding) and an
  ungoverned-edge gap report (retrofit, `align doctor`-shaped).
- A `compositionRoots` config field (explicit, human-declared) for catch-all exclusion — no heuristic.
- Serves the dev-loop review's top-supported lever (3a, rule-authoring assist,
  `docs/proposals/dev-loop-exploration.md`), targeting adoption friction — but the honest scope is
  smaller than the original draft: on small repos it mostly overlaps ADR 009's layer macros; its real
  payoff is large-repo edge-weight ranking + the retrofit gap report.

## Evidence
- `docs/evidence/co-change-coupling/PROBE.md` — co-change vs import graph (the diagnostic + noise classes).
- Onboarding demonstration (directus): foundation layer surfaced, 467 no-edge pairs filtered.
- Retrofit demonstration (kluster): `apiPlugins → apiDb` (87%) ungoverned gap, owner-judgeable.
