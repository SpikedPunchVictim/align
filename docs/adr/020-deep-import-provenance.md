# ADR 020: Deep-import provenance (`arch.import-provenance`)

**STATUS: DRAFT — pending owner sign-off.**

> ADR numbering: 016/017 in flight on `stage0-surface-inference`; 018 on `main`; 019 on this branch.
> This is 020.

## Context

`docs/proposals/reconciled-build-order.md` #4 names this the strongest net-new signal remaining on
align's roadmap: a cross-package import that reaches **past** a package's declared public surface into
its internals — a specifier subpath containing `/src/`, `/dist/`, `/lib/`, `/internal/`, or an
undeclared `exports` subpath (e.g. `n8n-nodes-base/dist/nodes/Set/v2/helpers/interfaces`,
`@vscode/prompt-tsx/dist/base/...`). It is invisible to `tsc` (the deep path still resolves and
type-checks fine) and to most ESLint configs (`import/no-internal-modules` exists but is rarely
enabled, and doesn't know about `exports` wildcards either). It needs no component classification —
align's weakest area on non-pnpm/npm repos (`nest`=1 component, `vscode`=6,234 unmapped, per the
external empirical run cited in the reconciled build order) — because it keys off package boundaries
and specifier text, which the scanner already has.

The build order's explicit gate for this item: **"placebo-test first: compare the exports-aware
machinery against a dumb `/src/|/dist/` cross-package grep before crediting the machinery."** That
probe is `docs/evidence/deep-import-provenance-probe/PROBE.md`, run for real (not estimated) on n8n and
vscode. Its result is the load-bearing input to this ADR's scope decision below.

## Placebo-test result (the measurement that scopes this ADR)

Full detail: `docs/evidence/deep-import-provenance-probe/PROBE.md`. Summary:

- **n8n** (a real pnpm workspace — every target manifest resolvable in-repo, the *best case* for
  exports-awareness): Arm A (marker string-match, zero manifest reads) found **42** raw hits.
  Exports-aware Arm B suppressed **1** of them (2.4%) — and that one suppression is a package
  (`n8n-workflow`) that declares `"./*": "./*"`, a blanket self-mapping wildcard that opts the whole
  package **out of** exports encapsulation rather than curating a public surface. A hand-checked
  sample of 4 of the 42 (chosen for target diversity) were all confirmed true positives by direct file
  inspection, including two cases where the same file imports the *correct* symbol from the package's
  real entrypoint one line above the violating deep import.
- **vscode**: has **no internal workspace-package graph at all** (no `workspaces` field; `extensions/*`
  are independently-installed sibling projects) — the deep imports the earlier research flagged there
  (`@vscode/prompt-tsx/dist/base/...`) are against **externally published npm dependencies**, whose
  manifests live in `node_modules`, absent in this checkout by design. Arm B was **completely inert**
  as run (0 of 51 hits had a resolvable manifest). Hand-verifying against the real npm-registry
  manifests for all 8 distinct target packages showed Arm B would change **1 of 51** decisions (2%)
  even in the best case (`node_modules` installed) — and it does nothing about the dominant measured
  false-positive driver (`typescript`/`mocha`, 69% of the raw hits: both ship **no `exports` field at
  all**, and the specific deep paths used are each vendor's own documented, intentional multi-entrypoint
  convention — a false-positive class neither arm can fix, because there's nothing to consult either
  way).
- **The prior "466 raw → ~15-20 est. TP once wildcards respected" hypothesis (`spike-findings.md` Rule
  B) does not survive contact with a real measurement.** That number came from a *different, dumber*
  prior detector that flagged any undeclared subpath (marker or not) whenever the target had *some*
  `exports` map — its FP flood was dominated by ordinary, non-internal imports under `@n8n/rest-api-
  client`'s ignored `"./*"` wildcard. **Scoping the string match to the four marker segments (still
  zero manifest reads) already eliminates that FP class** — 42 hits on n8n, not 466, before exports-
  parsing ever enters the picture. The "466 → ~15-20" hypothesis was solving the wrong baseline.

**Verdict, blunt: the exports-parsing machinery is not justified by this evidence.** Across both
repos, and even in exports-awareness's best case (real, resolvable manifests), it changes ~2% of Arm
A's raw decisions — and in neither sample does it touch the dominant FP driver. Arm A alone is doing
essentially all of the useful work.

## Decision (v1 — Arm A only; exports-aware suppression deferred to reserve)

### The rule: `arch.import-provenance`

A new IR rule kind. `arch.layer(x).mustRespectPublishedSurface()` (or equivalent DSL verb name, TBD at
implementation time) flags any import edge whose specifier's subpath — the part after the package
name — contains a path segment `src`, `dist`, `lib`, or `internal`. **v1 is Arm A exactly as probed:
pure string match, no manifest reads, no `exports` parsing.** Applies identically whether the target is
a workspace-member component or an external package (`ExternalDependencyEdge`) — the marker heuristic
doesn't care which.

### Typed contract sketch

```ts
// packages/core/src/types/ir.ts (proposed addition, same shape family as archNoDependencySchema)
const archImportProvenanceSchema = z.object({
  kind: z.literal('arch.import-provenance'),
  id: ruleId,
  scope: z.union([z.literal('repo'), componentRef]),  // which component's outgoing edges to check;
                                                        // 'repo' = every component
  markers: z.array(z.string()).default(['src', 'dist', 'lib', 'internal']),  // overridable, but
                                                        // ships with this default per the probe
  provenance: ruleProvenanceSchema,
});
```

The evaluator is a pure function over data the scanner **already produces** — no new scanner input
required for v1:

```ts
// packages/core/src/rules/evaluators.ts (proposed addition, same family as evaluateNoDependency etc.)
function evaluateImportProvenance(
  rule: ArchImportProvenanceRule,
  graph: DependencyGraph,          // DependencyGraphEdge.specifier already carries the exact text
): Violation[]
```

`DependencyGraphEdge.specifier` (internal, cross-component edges) and `ExternalDependencyEdge.specifier`
(edges to `node_modules`/builtin targets) both already carry the exact import specifier string, per
edge, with `line` and `from`/`to` (`packages/core/src/types/graph.ts`). Parsing "packagename + subpath"
out of that string and checking the subpath's segments against the marker list needs no new scan pass —
this is the same reason `security.manifest.source-hygiene` (ADR 013) was cheap: the raw text was
already there.

### Where it lives

Follows the existing `dsl → core ← plugin-typescript` direction align already enforces on itself
(verified live off the installed skill's rule-kind/DSL-verb registries):

- **IR schema**: `packages/core/src/types/ir.ts` — new discriminated-union member.
- **Evaluator**: `packages/core/src/rules/evaluators.ts` — new case in the dispatcher (line ~238's
  `switch`), pure `RuleEvaluator` over `DependencyGraph`, same family as `arch.no-dependency`/
  `arch.layers`.
- **DSL verb**: `packages/core/src/dsl/factories.ts` + `packages/core/src/dsl/verb-manifest.ts`.
- **Docs surfaces that must stay in lockstep** (the "live off the installed binary's own registries"
  doctrine `align skill` depends on): `packages/cli/src/skill/rule-kinds.ts`, `dsl-verbs.ts`,
  bullet-grammar generation, and the Tier-2 doc-authoring sentence form.
- **plugin-typescript**: no changes needed for v1 — the scanner already emits everything Arm A
  consumes (see above). This is itself part of the evidence that Arm A is the right v1 scope: it costs
  no new scanner surface, only IR + evaluator + DSL + docs.

### The known new-rule-kind cost (same burden ADRs 016/017 carry)

Confirmed by grep against the live tree — a new rule kind is **not** a cheap addition, regardless of
how simple the evaluator logic is:
- IR schema (`types/ir.ts`)
- Evaluator (`rules/evaluators.ts`)
- **Five** exhaustive-switch sites that must be updated or the build fails closed (verified):
  `rules/evaluators.ts` (dispatcher), `rules/component-refs.ts` (reference-validity — every
  component name in a rule must resolve, ADR 007's invariant), `rules/rule-category.ts`,
  `build/ground.ts`, `cli/src/commands/build-report.ts`.
- DSL verb (`dsl/factories.ts`, `dsl/verb-manifest.ts`)
- Docs generation (`cli/src/skill/rule-kinds.ts`, `dsl-verbs.ts`, the Tier-2 bullet grammar)
- Reference-validity coverage so an unresolvable component in an `arch.import-provenance` rule errors
  the gate instead of silently passing (the false-green invariant every rule kind must honor)

This is why the placebo test had to run **before** committing to Arm B: paying this fixed cost once for
Arm A (justified, ~42/51 real hits, hand-checked TP) is very different from *also* building a Node
`exports`-subpath-pattern resolver, wiring a new manifest scan pass (`ManifestRecord` today captures
only `dependencies`, not `exports` — see below), and carrying that surface forward for a ~2% swing.

### Where the `exports`-aware path (Arm B) would live, IF later promoted

`ManifestInventory`/`ManifestRecord` (`packages/core/src/types/manifest.ts`, ADR 013) already scans
every workspace-member `package.json` for `security.manifest.*` — but only `dependencies`. Extending
`ManifestRecord` with each manifest's own `exports` field is additive and cheap **for workspace
members** (the manifest is already being read). It is **not available at all for external
dependencies** without installing `node_modules` — the exact false-green class reconciled-build-order
item #1 (deps-not-installed advisory) exists to gate. Building Arm B before item #1 ships risks a
second, rule-specific instance of that same failure mode: a repo without `node_modules` would either
silently skip exports-arbitration on every external edge (a hidden gap in the "aware" claim) or the
evaluator has to explicitly know it's degraded — either way, more moving parts for evidence that says
they aren't earning their keep yet.

## TP/FP tiering (ADR 008's discipline: `~1-in-5 FP is trust-destroying for a blocking rule`)

Per `reconciled-build-order.md` #5's bar (≥80% TP for advisory, ~95%+ for a blocking default):
- **n8n**: hand-checked sample was 4/4 TP; the dominant repeated cluster (nodes-langchain reaching into
  nodes-base internals, 30+ of 42 hits) is structurally the same real violation repeated across many
  node files, not independent judgment calls. This repo plausibly clears the advisory bar and is in
  range for blocking, but 4-of-42 hand-checked is not a large enough sample to certify a 95%+ rate —
  **ship as advisory first everywhere**, re-measure blocking-readiness per repo once real usage
  accumulates more hand-checked volume.
- **vscode**: the measured raw-hit composition (69% `typescript`/`mocha` deep imports into documented,
  intentional vendor entrypoints) means Arm A's *unfiltered* precision on this repo is likely well
  below either bar. **This is the honest, repo-dependent finding of this ADR**: precision is not a
  property of the rule alone, it's a property of how many "conventionally-tolerated deep-import"
  dependencies a given codebase pulls in. v1 ships advisory-only for exactly this reason — a codebase
  like vscode would see real noise until a documented-convention allowlist (out of scope below) exists.

## Falsification / validation plan

1. **Reproduce the probe through the real implementation**, not the throwaway script: run
   `arch.import-provenance` against n8n and vscode (plus a third, unrelated repo — n≥2 external
   generalization per this repo's empirical-planning discipline) and confirm the marker-only raw-hit
   counts and TP rate are in the same range measured here. If the real evaluator's hit count diverges
   materially from the probe's regex-based approximation, that's a scope finding to report, not silently
   absorb.
2. **The Arm B promotion trigger, stated as a decision-flip test** (mirrors ADR 019's co-change
   decision-flip discipline): before building any `exports` consultation, find a repo where the
   exports-suppression rate is *materially* higher than the ~2% measured here — specifically, a repo
   that uses curated, non-wildcard subpath exports as its actual documented public API (not a blanket
   `"./*"` escape hatch) heavily enough that Arm A's false-positive rate without it is unacceptable. Zero
   such repos found ⇒ Arm B stays in the Design Reserve.
3. **The documented-convention FP class** (typescript/mocha-style): before shipping this as a default-
   on advisory (vs. opt-in), measure how common vendor-documented multi-entrypoint conventions are
   across a broader repo sample. If they recur often enough to dominate noise the way they did on
   vscode, the falsification result is "ship opt-in per-repo, not on-by-default," or build a small,
   explicit allowlist config field (`knownPublicDeepImports: string[]`) — a much cheaper mechanism than
   exports parsing, and one the probe data supports needing more than it supports needing Arm B.
4. **Reference-validity regression**: confirm an `arch.import-provenance` rule scoped to a non-existent
   component name hard-errors the gate (same invariant every rule kind carries, ADR 007) rather than
   silently evaluating vacuously true.

## Out of scope

- **Exports-aware wildcard suppression (Arm B)** — Design Reserve, not built in v1. Promotion trigger
  above. If promoted, it needs: `ManifestRecord.exports` (additive scan), a Node-subpath-pattern-
  matching implementation (exact key + `*` wildcard, condition-object traversal), and an explicit
  decision on how (or whether) it degrades for external dependencies without `node_modules` — likely
  gated on reconciled-build-order item #1 shipping first.
- **A documented-convention allowlist** (`typescript/lib/tsserverlibrary`, `mocha/lib/reporters/base`
  style exceptions) — real, measured FP driver on vscode, but a separate mechanism from this ADR's
  scope; noted as a probable v1.1 need, not built here.
- **Auto-fix / rewrite-to-public-import** — this is a detection rule; what the "correct" import should
  be (does the package need to expose the symbol, or should the importer stop reaching in) is a human
  judgment call, same posture as ADR 019's suggestion-not-enforcement stance on ungoverned edges.
- **Non-marker "any undeclared exports subpath" detection** — the broader condition named in the
  feature's original framing (flag *any* undeclared subpath, not just marker segments) was exactly the
  prior, dumber-in-a-different-way detector this probe found noisy (the 466-hit baseline). Not
  resurrected here; if it's ever wanted, it needs its own placebo test against real hand-checked data,
  not inheritance from the rejected prior number.
- **Cross-language / non-npm ecosystems** — align's plugin-typescript posture; out of scope by
  construction, unchanged by this ADR.

## Alternatives considered

- **Ship Arm A + Arm B together in v1** ("build it right the first time"). Rejected on measured
  evidence: Arm B costs a real new scan pass + a wildcard-pattern resolver + a `node_modules`-
  availability edge case, for a ~2% swing in either sample. This is exactly the promotion-on-evidence
  failure mode the placebo-test gate exists to prevent — elegant machinery with no measured payoff.
- **A `custom.host` predicate instead of a new IR rule kind.** Rejected for the same reason ADR 018
  rejected it for doc-links: `custom.host` sees `ctx.graph`, and the graph already has everything Arm A
  needs, so this **could** technically be expressed as a host predicate. But a first-class IR rule kind
  gets doc-authoring (Tier-2 bullet grammar), reference-validity, and MCP `align_explain_rule` surfacing
  for free — the same reasoning that makes `arch.metric` (LOC) a first-class kind rather than a host
  escape hatch. Given the strength of this signal (reconciled-build-order's "strongest net-new" call),
  it earns first-class treatment.
- **Block by default from day one.** Rejected: vscode's measured composition shows precision is
  repo-dependent, and ADR 008's blocking bar (~95%+) is not something 4-hand-checked-of-42 can certify.
  Ships advisory; blocking is a per-repo, evidence-gated upgrade, same posture as ADR 018's "toil-
  reduction requires a red loop" argument but scoped down to what's actually measured here.

## Consequences

- One new IR rule kind (`arch.import-provenance`) — IR schema entry, evaluator, five exhaustive-switch
  updates, a DSL verb, and docs-generation entries (rule-kinds, dsl-verbs, bullet grammar).
- **No new scanner input for v1.** `DependencyGraphEdge.specifier`/`ExternalDependencyEdge.specifier`
  already carry everything the marker heuristic needs — this is the direct payoff of narrowing scope to
  Arm A.
- `exports`-aware suppression (Arm B) is explicitly **not built**, held in the Design Reserve behind the
  promotion trigger in § Falsification.
- Ships **advisory only** in v1, per the measured, repo-dependent precision spread (n8n vs. vscode) —
  not a blocking default.
- A known, unaddressed FP class (vendor-documented multi-entrypoint conventions) is named rather than
  hidden; it is the primary reason this ships advisory, not blocking, and the primary candidate for a
  v1.1 allowlist mechanism.

## Evidence

- `docs/evidence/deep-import-provenance-probe/PROBE.md` — the Arm A vs. Arm B measurement on n8n and
  vscode, including hand-checked TP samples and the real npm-registry manifest check for all 8 distinct
  vscode target packages.
- `docs/proposals/reconciled-build-order.md` #4 — the feature framing, the placebo-test gate, and the
  original (now corrected) "466 → ~15-20" hypothesis.
- `pr-research/dataset-c-spike/spike-findings.md` (Rule B) and `spike.py` — the prior, broader detector
  whose FP flood this ADR's narrower Arm A resolves without any exports parsing.
