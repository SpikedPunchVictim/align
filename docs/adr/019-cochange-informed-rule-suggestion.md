# ADR 019: Co-change-informed rule suggestion (onboarding + retrofit)

**STATUS: DRAFT — pending owner sign-off.** Proposes an enhancement to align's existing rule-suggestion
surfaces + a falsification plan; per promotion-on-evidence doctrine it ships only if the plan clears.

> ADR numbering: 016/017 in flight on `stage0-surface-inference`; 018 on main. This is 019.

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

## Decision

Enhance the existing suggestion surfaces (`align init`, `align_propose_rules`) with a **co-change-
informed ranking**, in two modes. This is **not a new rule kind** and **not enforcement** — it produces
*suggestions a human confirms*.

### Inputs (all light; most already exist)
- **Co-change**: a new `git log --name-only` pass mapping each commit's files → components, accumulating
  pairwise co-change counts + per-component change counts (confidence = `max(P(B|A), P(A|B))`). Bounded
  sample (recent N commits). The one genuinely new mechanism.
- **Import graph + components**: align already builds both.
- **Existing ruleset** (retrofit mode only): the loaded `align.config.ts` rules.

### Mode 1 — onboarding (blank/sparse config)
Rank **import-coupled** component pairs by co-change; emit candidate dependency-direction rules in
dependency order (foundation → consumers), each with its co-change confidence as the rationale. The
human accepts/edits/rejects; align writes the accepted ones.

### Mode 2 — retrofit (existing ruleset)
Classify each import-coupled + high-co-change pair as **governed** (covered by an existing rule) or
**GAP** (not). Emit the GAPs, ranked by co-change, as "boundaries you haven't decided on yet." This is
ongoing rule-*health*, distinct from onboarding.

### Precision-critical (learned from the demonstrations)
- **Intersect with the import graph — never suggest from co-change alone.** The 467 no-edge directus
  pairs and the 70-93% hidden mass are noise for suggestion; only import-coupled pairs are governable.
- **Down-rank catch-all / composition-root components.** kluster's `api` catch-all → every sub-layer
  showed as "GAP" but is the composition root legitimately wiring everything. A root/catch-all heuristic
  (glob breadth, fan-out) must suppress these or the gap list cries wolf — the same inherent-coupling
  discipline the probe applied.
- **Suggest, never auto-apply.** Co-change tells you `apiPlugins → apiDb` is load-bearing; it cannot tell
  you whether that direction is *intended* (usually) or a smell to invert. Bidirectional import edges are
  flagged as cycle-risk, but the human decides.

## Falsification / validation plan
1. **Suggestion precision (onboarding).** Run Mode 1 on directus/n8n and a mid-size untooled repo; have
   a maintainer (or the ARCHITECTURE.md, where one exists) judge the top-N suggested rules — what
   fraction would they accept? Target: the foundation-layer suggestions (directus types/utils/env) are
   accepted; the noise (root-component, no-edge) is correctly suppressed.
2. **Gap precision (retrofit).** Run Mode 2 on kluster (already validated: the `apiPlugins → apiDb` gap
   is real and owner-judgeable) and align's own repo; confirm the GAPs are genuine ungoverned boundaries,
   not root-component noise. If the root/catch-all heuristic can't suppress the `api → *` class, that's a
   scope finding.
3. **Cost.** Confirm the co-change git-log pass is bounded and fast enough to run in `align init` / on
   demand, not every check.

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

## Consequences
- A new bounded co-change `git log` pass (the one new mechanism); reuses align's import graph, component
  model, and — for retrofit — the loaded ruleset.
- `align init` / `align_propose_rules` gain co-change ranking (onboarding) and a gap report (retrofit).
- A root/catch-all component heuristic (glob breadth / fan-out) for noise suppression.
- Directly serves the dev-loop review's top-supported lever (3a, rule-authoring assist,
  `docs/proposals/dev-loop-exploration.md`) — it targets adoption friction, align's actual barrier.

## Evidence
- `docs/evidence/co-change-coupling/PROBE.md` — co-change vs import graph (the diagnostic + noise classes).
- Onboarding demonstration (directus): foundation layer surfaced, 467 no-edge pairs filtered.
- Retrofit demonstration (kluster): `apiPlugins → apiDb` (87%) ungoverned gap, owner-judgeable.
