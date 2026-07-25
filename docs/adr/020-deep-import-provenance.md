# ADR 020: Deep-import convention check (`doctor` advisory; `arch.import-provenance` reserved)

**STATUS: ACCEPTED — RESCOPED to a `doctor` advisory after Fable review (2026-07-25).** The first
draft proposed a new IR *rule kind* that "ships advisory-only" — an incoherence: rule kinds emit
`severity: 'error'` violations that flip the red/green verdict and get baselined (`evaluators.ts`,
`host-rules.ts:170`); there is no advisory channel for a rule kind, so "advisory-only rule kind" has no
mechanism, and the only real reading (opt-in rule + baseline) is *blocking on new code* — the exact
1-in-5-FP trust-destruction the probe says this can't sustain (vscode ~31% precision). **v1 is therefore
a `doctor` advisory — the #3 shape** (`computeUngovernedEdgeGaps` → doctor advisory, no rule kind), for
which the evidence is exactly sized. The first-class `arch.import-provenance` IR rule kind is held in
**Design Reserve** behind a blocking-readiness trigger. Two evidence-driven corrections also fold in: a
**v1 allowlist** for the measured vendor-convention FP class, and a **false-quiet fix** (below).

> ADR numbering: 016/017 in flight on `stage0-surface-inference`; 018 on `main`; 019 on this branch.
> This is 020.

## Context

`docs/proposals/reconciled-build-order.md` #4 names this the strongest net-new signal remaining on
align's roadmap: a cross-package import that reaches **past** a package's declared public surface into
its internals — a specifier subpath containing a `src`, `dist`, `lib`, or `internal` path segment
(e.g. `n8n-nodes-base/dist/nodes/Set/v2/helpers/interfaces`, `@vscode/prompt-tsx/dist/base/...`). It is
invisible to `tsc` (the deep path still resolves and type-checks) and to most ESLint configs
(`import/no-internal-modules` exists but is rarely enabled). It needs no component classification —
align's weakest area on non-pnpm/npm repos — because it keys off package boundaries and specifier text,
which the scanner already carries.

The build order's explicit gate: **"placebo-test first: compare the exports-aware machinery against a
dumb `/src/|/dist/` cross-package grep before crediting the machinery."** That probe
(`docs/evidence/deep-import-provenance-probe/PROBE.md`) was run for real on n8n and vscode; its result
is the load-bearing input below.

## Placebo-test result (the measurement that scopes this ADR)

- **n8n** (a real pnpm workspace — best case for exports-awareness): Arm A (marker string-match, zero
  manifest reads) found **42** raw hits; exports-aware Arm B suppressed **1** (2.4%), and that one was a
  package declaring `"./*": "./*"` — a blanket self-mapping that opts *out* of encapsulation, not a
  curated surface. Hand-checked sample: 4/4 true positives.
- **vscode**: has no internal workspace graph; the deep imports are against external npm packages whose
  manifests weren't installed. Even against the real npm-registry manifests, Arm B would change **1 of
  51** (2%) — and does nothing about the dominant FP driver: `typescript` (31) + `mocha` (4) = **69% of
  hits are vendor-documented multi-entrypoint conventions** (both ship *no* `exports` field), which
  neither arm can distinguish from a real violation.
- The prior "466 → ~15-20" hypothesis doesn't survive: it measured a dumber baseline (any undeclared
  subpath). Scoping to the four marker segments alone — zero manifest reads — gets 466 → 42 with no
  exports parsing.

**Verdict: the exports-parsing machinery (Arm B) is not justified** — ~2% swing in either sample,
untouched dominant FP driver. And **vscode's ~31% precision (35/51 vendor-convention FPs)** means the
signal is *repo-dependent* and, unfiltered, fails the ≥80% advisory bar on a real repo.

## Decision (v1 = a `doctor` advisory, not a rule kind)

Mirror reconciled-build-order #3 (`computeUngovernedEdgeGaps` → doctor advisory): a **pure core
function** surfaced as a **`doctor` advisory**, no IR rule kind, no evaluator/gate/baseline surface.

```ts
// packages/core/src/gates/deep-imports.ts (proposed; same shape as gates/ungoverned-edges.ts)
export interface DeepImportHit {
  readonly from: RepoRelativePath;
  readonly line: number;
  readonly specifier: string;     // the exact import text
  readonly targetPackage: string; // parsed package name
  readonly subpath: string;       // the part after the package name
  readonly marker: string;        // which of src|dist|lib|internal matched
}
export function computeDeepImportHits(
  graph: DependencyGraph,
  opts?: { markers?: readonly string[]; allowlist?: readonly string[] },
): DeepImportHit[];
```

- **Input = the scan align already has, over THREE sources** — `graph.edges` (internal cross-component),
  `graph.externalEdges` (to `node_modules`/builtins), **and `graph.uncertain`**. The third is the
  **false-quiet fix** (see below) — non-negotiable, or v1 sees ~nothing in the uninstalled/unbuilt
  repos it targets.
- **Marker match on the *subpath*.** Parse `package + subpath` correctly for scoped packages: the
  package name is the first **1 (unscoped) or 2 (`@scope/name`) segments**; the subpath is everything
  after (cf. `packageNameFromSpecifier`, `tsconfig-resolver.ts:148-153`). Flag iff a subpath segment is
  `src`/`dist`/`lib`/`internal` (default markers, overridable). This avoids `@scope/lib` and a package
  literally *named* `lib` false-matching on the package-name segment.
- **v1 allowlist — `knownPublicDeepImports: string[]`** (config, same feed as `compositionRoots`,
  `doctor.ts:143`), **seeded** with the measured FP class: `typescript/lib/*`, `mocha/lib/*` (and the
  ecosystem-wide pre-`exports` `lib/`-entry convention — antd/babel-plugin-import/older aws-sdk). A hit
  whose `package + subpath` matches an allowlist glob is suppressed. This is the cheap mechanism the
  probe data supports needing — shipped in **v1, not deferred** (Fable correction).
- **Surface: one `doctor` advisory** (kind `deep-import`), one per hit in ranked order, so doctor's
  existing per-kind top-10 + "and M more" cap and `--json` completeness apply with no new truncation
  logic (exactly how #3 wired in).
- **Naming honesty.** With Arm B cut, v1 establishes nothing about a target's actual public *surface* —
  it's a deep-import *convention* check. The advisory kind is `deep-import`; the name
  `arch.import-provenance` is **reserved** for the Design-Reserve rule kind, not used in v1.

### The false-quiet fix (Fable finding — verified)

`tsconfig-resolver.ts:47-59`: when `ts.resolveModuleName` can't resolve a specifier (no `node_modules`)
and the workspace fallback can't either (an **unbuilt `dist/` subpath** — the code comment says so), it
returns `{kind: 'unresolved'}` → the scanner routes it to **`graph.uncertain`, not `edges`/
`externalEdges`**. So a check reading only edges sees **0 of vscode's 51 / most of n8n's `dist/`
cluster** in a fresh, uninstalled clone — silently green, the deps-not-installed false-green class (#1).
The probe's throwaway regex scanner had no resolution step, so **its counts don't transfer** to an
edges-only evaluator in the very environments it ran in. Fix: markers are pure text — also match over
`graph.uncertain[].specifier` (which carries `specifier`/`file`/`line`). The advisory notes degraded
completeness the same way #1's `missing-dependencies` advisory does when deps are absent.

### Where it lives
`packages/core/src/gates/deep-imports.ts` (pure, core-owned — same placement as `ungoverned-edges.ts`);
wired into `packages/cli/src/commands/doctor.ts` as a `deep-import` advisory; `knownPublicDeepImports`
added to `packages/cli/src/config.ts` (sibling export, same pattern as `compositionRoots`/`excludes`).
plugin-typescript: **no changes** (the scanner already emits `edges`/`externalEdges`/`uncertain` with
specifiers). Zero IR/evaluator/DSL/exhaustive-switch/reference-validity cost — the whole point of the
rescope.

## Falsification / validation plan
1. **Reproduce the probe through the REAL implementation** (not the regex script) on n8n + vscode + a
   third repo. Critically: verify the `uncertain`-source path recovers the hits an edges-only version
   would miss in an uninstalled clone (the false-quiet). If real counts diverge from the probe, that's a
   scope finding.
2. **Precision WITH the allowlist, BEFORE ship** (moved into v1, Fable correction): measure post-allowlist
   precision on vscode-class repos. Target ≥80% (advisory bar). If the allowlist can't get a
   convention-heavy repo over the bar, ship the advisory **off-by-default / opt-in**, not on.
3. Confirm scoped-package subpath parsing (`@scope/name/dist/x` flags; `@scope/lib` does not).

## Out of scope / Design Reserve
- **First-class `arch.import-provenance` IR rule kind** — Design Reserve. Promotion trigger: a real
  adopter wanting the **blocking ratchet** on a workspace monorepo, **AND** ≥80% measured precision
  *with the allowlist* on a vscode-class repo. Only then does the rule-kind cost (IR + evaluator + 5
  exhaustive switches + DSL + reference-validity + docs-lockstep) earn its keep — the `arch.metric` bar
  (promoted on a real adopter's ruleset, and it blocks). Until then a `doctor` advisory captures 100% of
  the measured *detection* value at a fraction of the cost.
- **Exports-aware wildcard suppression (Arm B)** — Design Reserve; ~2% swing, needs `ManifestRecord.exports`
  + a subpath-pattern resolver + a `node_modules`-absence edge case (gated on #1).
- **A `custom.host` recipe** — a cheap *optional* offering for a repo that wants **red today**: the graph
  already carries the edges/specifiers a predicate needs. Documented as a recipe, not built into core.
- **Auto-fix**, **non-marker "any undeclared subpath" detection** (the rejected 466-hit baseline),
  **cross-language** — all out, unchanged.

## Alternatives considered
- **A new IR rule kind (the original draft).** Rejected — see the STATUS banner. An advisory-only rule
  kind has no mechanism; the honest reading is blocking-on-new-code, which the vscode precision can't
  sustain. #3 set the precedent *days ago*: an advisory-only structural check is a doctor advisory, not
  a rule kind.
- **`custom.host` as the v1 vehicle.** The original draft rejected this "for the same reason ADR 018
  did" — but that citation is backwards: ADR 018 rejected `custom.host` because doc links **aren't in
  `ctx.graph`** (data unavailability), whereas here the edges **are** in the graph; and 018's actual
  outcome was **Design Reserve + a `custom.host` recipe**. So the honest 018 precedent prescribes the
  graduated path (a built-in advisory now; rule kind on evidence), which is exactly this rescope. We
  ship the built-in `doctor` advisory (better default DX than making every user write a predicate) and
  *offer* the `custom.host` recipe for red-today repos.
- **Block by default.** Rejected: vscode ~31% precision; ADR 008's ~95% blocking bar is uncertifiable
  from the sample. Advisory only; blocking is the Design-Reserve rule kind's job.

## Consequences (v1)
- A new pure core function `computeDeepImportHits` + a `deep-import` doctor advisory + a
  `knownPublicDeepImports` config field. **No IR rule kind, no new scanner input.**
- Reads `edges` + `externalEdges` **+ `uncertain`** — the false-quiet fix means it works in uninstalled
  clones (with a degraded-completeness note), not just built ones.
- Ships **advisory**, allowlist-filtered, per the measured repo-dependent precision.
- `arch.import-provenance` (first-class IR) + Arm B (exports-aware) both explicitly **not built** — held
  in Design Reserve behind the triggers above.

## Evidence
- `docs/evidence/deep-import-provenance-probe/PROBE.md` — the Arm A vs Arm B measurement (n8n, vscode),
  hand-checked TP samples, and the real npm-registry manifest check.
- `docs/proposals/reconciled-build-order.md` #4 — feature framing + the placebo gate.
- `packages/core/src/gates/ungoverned-edges.ts` + `packages/cli/src/commands/doctor.ts` — the #3
  doctor-advisory precedent this v1 mirrors.
- `packages/plugin-typescript/src/tsconfig-resolver.ts:47-59` — the `unresolved → uncertain` routing
  (the false-quiet finding).
