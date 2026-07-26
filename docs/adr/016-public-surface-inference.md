# ADR 016: Public-Surface Inference

**STATUS: ACCEPTED & BUILT (pure algorithm) — owner sign-off 2026-07-20.** The pure inference algorithm
(typed contract + `inferSurface.ts` + `entrypoint.ts`) is cleared to build, with the graded confidence
contract below. The persisted-artifact + `align surface infer` CLI + confirmation-gate machinery remain
**promotion-gated** on the criteria in the Falsification section (a real prevented-autofix case; a fired
`SurfaceUncertaintyMarker` fixture). Shipping the downstream rules this unblocks (`@internal` barrel-escape,
deep-import provenance) is a separate, later decision per this project's promotion-on-evidence doctrine
(`docs/proposals/rule-expansion-evaluation.md`) — not authorized by accepting this ADR.

> **BUILD OUTCOME (2026-07-20).** The pure algorithm shipped: `packages/core/src/types/publicSurface.ts`,
> `packages/core/src/surface/inferSurface.ts`, `packages/plugin-typescript/src/entrypoint.ts` (+ the
> `isBarrelReexport` edge bit — see Context finding #2's build correction). Tests: core 285→308,
> plugin-typescript 44→57, including the first fixtures to exercise `barrel-cycle` and `unresolvable-reexport`.
> Typecheck clean, full suite green (633 pass / 1 skip), `align check` dogfood green. **Task-5 revalidation
> against the REAL modules held**: backstage 99.68% precision / 99.95% recall (the one large outlier
> hand-traced to a ground-truth-parser undercount, not the algorithm — not tuned to fit); nest 0% declared /
> 9-of-9 `inferred-unique`; langchain `./output_parsers` resolves `declared`. The uncertainty vocabulary,
> which fired zero times in both spike rounds, fired 4 benign `unresolvable-reexport` cases on the real run
> (asset-file subpath "entrypoints" + a package dir named `build`) — real material for the promotion-gate
> fixture the CLI/persistence layer still needs. NOT built (promotion-gated, as intended): the CLI command,
> `.align/public-surface.json` persistence, confirmation-gate UX, the `PublicSurfaceInferrer` DI seam, and
> both downstream rules.

> **AMENDMENT (2026-07-20, post-spike): the confidence contract is now GRADED, not binary.** The
> falsification plan (§ below) was executed in two rounds — `docs/evidence/surface-inference-spike/SPIKE_REPORT.md`.
> Round 2, using the TypeScript compiler API on both sides against independent ground truth, measured
> 99.67% precision / 100% recall on backstage (295 packages incl. subpath entrypoints) and **100%
> precision/recall on the *inferred* path** for 5 `@nestjs/*` packages validated against their published
> npm `.d.ts`. The declared-rate survey across all 9 TS repos (80.1% declared overall) found the original
> **binary `'declared' | 'inferred'` contract partly degenerate**: of 114 inferred cases, 0 were ambiguous,
> 24 resolved to a single unambiguous candidate (`inferred-unique` — including all 9 nest packages, the
> ones that scored 100%), and 90 resolved to no candidate (`inferred-none`). The real risk axis is
> **resolvable vs unresolvable, not declared vs inferred** — so the typed contract below now uses a
> three-way `EntrypointConfidence`. This is the one substantive change the spike forced; it must land in
> `publicSurface.ts` from the start, not be retrofitted. "Split it" (build the pure algorithm now,
> promotion-gate the persisted artifact/CLI) otherwise stands — see § Falsification plan for the executed
> results and the still-unexercised parts.

## Context

Two genuinely new, well-evidenced rule categories — public-surface leakage (`@internal`/unexported symbols
escaping a package's public barrel) and deep-import provenance (code reaching past a package's declared
entrypoint into its internals) — both depend on the same missing capability: knowing, for a workspace
package, what its public entrypoint is and what symbols are actually reachable through it, **without**
requiring the repo to have already declared `package.json` `exports`, `@public`/`@internal` JSDoc tags, or
any other curated API metadata.

`docs/proposals/stage0-surface-inference-gap-analysis.md` (companion document) establishes precisely what
align already has and what's missing, file:line-cited. Summary of the three load-bearing findings:

1. **Entrypoint resolution today is filename-convention guessing, not manifest-aware.**
   `resolveWorkspaceSpecifier` (`packages/plugin-typescript/src/workspace.ts:147-180`) tries a hardcoded
   candidate list (`src/index.ts`, `index.ts`, …) and never reads a package's `exports`/`main`/`types`
   fields — its own doc comment calls this "a deliberately boring heuristic… documented as a v1 limitation."
2. **Nothing walks a transitive `export *` barrel chain.** `extractExportedSymbols`
   (`packages/plugin-typescript/src/exports.ts:31-87`) explicitly punts on bare `export * from './other'` by
   design (`exports.ts:6-8`, `44-49`) — cross-file resolution is out of scope for that per-file pass. The
   graph already carries a `reexport`-kind edge for every barrel hop (`scanner.ts:304-310`), so this is a
   graph-algorithm gap over existing data, not a missing scan.
   > **Build correction (2026-07-20):** this finding was *half* right. The `reexport` edge exists, but
   > `kind: 'reexport'` alone cannot distinguish a **named** `export { foo } from './x'` (already fully
   > resolved into the from-file's own `exports`, so recursing would *leak* every other symbol `./x` exports)
   > from a **bare** `export * from './x'` (the barrel hop that must be recursed). The build added one
   > additive, optional field — `DependencyGraphEdge.isBarrelReexport` (`true` iff the export declaration had
   > no named/namespace clause) — set by the scanner, read by `inferSurface.ts`. So it was a graph-algorithm
   > gap **plus one bit of scan-time data**, not purely the former. See the amendment banner for scope.
3. **No public-surface data model exists anywhere in core.** `DependencyGraphNode.exports`
   (`docs/core-interfaces.md:252`) is a flat per-file `string[]` with no package-scoping, no entrypoint
   concept, and no confidence/provenance distinguishing a declared export from a heuristic guess.

The motivating evidence for *why this sequences first*, from `/Users/spikedpunchvictim/temp/enterprise-apps/pr-research/dataset-c-spike/fable-feedback-round2.md`:

- **§5, the single biggest unnamed risk the round-2 review names**: "every top-3 rule is defined against
  'the package's declared public entrypoint,' but in untooled mid-size repos, honest `exports` maps,
  entrypoint declarations, and `@internal` tags — the machine-readable facts these rules consume — largely
  don't exist. align's real first product is inferring/bootstrapping that API-surface metadata — an
  onboarding problem neither review scoped." This ADR is the design for that first product.
- **The `@internal` rule is market-mismatched without it.** Verified `@internal`-tagged-file counts:
  backstage 247, vscode 53, strapi 40, langchain 28, n8n 14, otel 9, **directus 1, nest 0** — the rule fires
  almost exclusively in the tooled (API-Extractor-culture) population, which `pr-research/README.md`'s own
  bias note already flags as "the population that needs align least." Surface inference computed
  independent of any tag (barrel-reachability + naming convention) is what makes the underlying category —
  public-surface leakage — usable in the untooled repos that are align's actual target market.
- **Autofix must be diff-only.** Per the same review, §2: barrel-removal is safe only for a symbol
  introduced in the current working diff — a symbol already at HEAD may be relied on by the repo's own code
  or external consumers regardless of its tag. This ADR's contract carries a confidence/provenance signal
  precisely so a future autofix implementation can make that distinction; this ADR does not itself build
  any autofix.

**This ADR proposes only the inference mechanism and its own validation** — the typed contract, where it
lives, the algorithm, and the falsification plan. The two downstream rule kinds are explicitly out of scope
(§7).

## Decision

### Typed contract (illegal-states-unrepresentable, per CODING_BEST_PRACTICES.md §10–§11)

Mirrors the branding/discriminated-union conventions `packages/core/src/types/branded.ts` and
`docs/ir-schema.md` already establish. Proposed home: `packages/core/src/types/publicSurface.ts` (a new
file, alongside `branded.ts`/`ir.ts`), consumed by a new pure algorithm module
`packages/core/src/surface/inferSurface.ts`.

```ts
// packages/core/src/types/publicSurface.ts

/** How a fact about a package's public surface was established — never conflated with the fact
 * itself, so a caller can condition autofix-safety on provenance without re-deriving it. */
type DeclaredProvenance =
  | { readonly source: 'package.json:exports'; readonly conditionPath: string } // e.g. '.', './output_parsers'
  | { readonly source: 'package.json:types' }
  | { readonly source: 'package.json:main' };
/** The workspace.ts filename-convention fallback. candidateCount is what grades the confidence:
 * exactly one candidate → 'inferred-unique' (validated at 100% P/R on nest, SPIKE_REPORT.md Round 2);
 * zero (or, unobserved-but-modeled, more than one) → 'inferred-none'. */
type ConventionProvenance = { readonly source: 'convention'; readonly candidateCount: number };
type SurfaceProvenance = DeclaredProvenance | ConventionProvenance;

/** GRADED confidence — the axis a downstream autofix gates on. Round 2 replaced the original binary
 * 'declared' | 'inferred': "inferred" meant "not declared in package.json", NOT "unreliable" — nest's
 * inferred-unique entrypoints scored 100% precision/recall vs published npm .d.ts. Only 'inferred-none'
 * (no resolvable entrypoint at all) should block autofix. */
type EntrypointConfidence = 'declared' | 'inferred-unique' | 'inferred-none';

/** One resolved entrypoint for a package. A package can have more than one (subpath exports) —
 * this is why entrypoints is a list on PackagePublicSurface, not a single field. Modeled as a
 * discriminated union so illegal states are unrepresentable: a 'declared'/'inferred-unique' entrypoint
 * ALWAYS has a resolved file; an 'inferred-none' entrypoint NEVER does (there was nothing to resolve).
 * This is stronger than round 1's conditional-type derivation and needs no runtime agreement check. */
type PackageEntrypoint =
  | { readonly confidence: 'declared';        readonly file: RepoRelativePath; readonly provenance: DeclaredProvenance }
  | { readonly confidence: 'inferred-unique'; readonly file: RepoRelativePath; readonly provenance: ConventionProvenance }
  | { readonly confidence: 'inferred-none';   readonly file: null;             readonly provenance: ConventionProvenance };

/** One symbol reachable from a package's public entrypoint(s), with the barrel chain that proves
 * reachability (Mermaid-renderable, same doctrine as no-cycles/no-dependency violations, ADR 007). */
interface PublicSurfaceEntry {
  readonly symbol: string;                        // 'default' sentinel included, matching exports.ts
  readonly declaredIn: RepoRelativePath;           // the file that actually declares/holds the symbol
  readonly reachableVia: readonly RepoRelativePath[]; // entrypoint -> ... -> declaredIn, barrel hops in order
  // The entrypoint's grade, carried down the chain and downgraded by the reachability walk: 'declared'
  // stays 'declared' only if every hop resolves; any unresolvable hop drops it to 'inferred-none' (the
  // gate-blocking grade). A symbol only ever reaches this struct if its entrypoint resolved, so the
  // 'inferred-none' *entrypoint* case (file: null) contributes no entries — it's a package-level signal.
  readonly confidence: EntrypointConfidence;
}

type SurfaceUncertaintyReason =
  | 'barrel-cycle'              // export * chain revisits a file already on the path
  | 'unresolvable-reexport'     // export * from './x' where 'x' doesn't resolve (mirrors UncertaintyReason)
  | 'non-source-reexport-target'; // export * from a non-.ts/.js file (rare; named, not machinery-heavy)

interface SurfaceUncertaintyMarker {
  readonly file: RepoRelativePath;
  readonly reason: SurfaceUncertaintyReason;
}

/** One package's complete inferred public surface. The unit persisted to the onboarding artifact
 * (§ Persistence) and the unit a future @internal/deep-import rule evaluator consumes. */
interface PackagePublicSurface {
  readonly packageName: string;                          // WorkspacePackage.name
  readonly entrypoints: readonly PackageEntrypoint[];
  readonly exports: readonly PublicSurfaceEntry[];
  readonly uncertain: readonly SurfaceUncertaintyMarker[]; // named-category vocabulary, ADR 004 precedent
}
```

Design notes tying this to CODING_BEST_PRACTICES.md:
- **§10 illegal-states-unrepresentable**: `PackageEntrypoint` is a discriminated union on `confidence`
  (Round-2 amendment), so a `declared` entrypoint with `file: null`, or an `inferred-none` entrypoint with
  a resolved file, cannot be constructed at all. This is a strict improvement over round 1's conditional-type
  derivation: the `file: RepoRelativePath` vs `file: null` split makes "we resolved an entrypoint" and "we
  didn't" structurally distinct types, and it round-trips cleanly through the persisted JSON artifact as a
  zod discriminated union (`z.discriminatedUnion('confidence', …)`) — no construction-time agreement check
  needed. The grade a downstream autofix gates on is read directly off the discriminant.
- **§11 branding**: `RepoRelativePath` is reused verbatim from `packages/core/src/types/branded.ts` — no new
  brand invented for a concept branded.ts already owns.
- **§14 functional core / imperative shell**: `inferSurface.ts`'s barrel-walk is a pure function over an
  already-materialized `DependencyGraph` plus a resolved entrypoint — no `fs`, no `Date.now()`. Only entrypoint
  *resolution* (reading `package.json`) touches the filesystem, and that stays in `plugin-typescript` (below).

### Where it lives (respects `dsl → core ← plugin-typescript`)

- **`packages/core/src/types/publicSurface.ts`** — the data model above. Core, because it's a contract type
  consumed by (future) rule evaluators the same way `DependencyGraph`/`ComponentDefinitionIR` are — core must
  never depend on a specific language plugin's types.
- **`packages/core/src/surface/inferSurface.ts`** — the transitive barrel-walk algorithm. Pure: `(graph:
  DependencyGraph, entrypoints: readonly PackageEntrypoint[]) => PackagePublicSurface`. It needs nothing
  language-plugin-specific — `DependencyGraph`'s `reexport`/`type-only` edges and `DependencyGraphNode.exports`
  are already core types, so the walk is expressible entirely in terms of data core already owns. This mirrors
  `diffExportedSymbols`'s existing placement pattern (pure diff over already-collected data,
  `packages/agent/src/symbolDiff.ts:17-29`) applied one layer up.
- **`packages/plugin-typescript/src/entrypoint.ts`** (new) — the impure shell: reads each workspace package's
  `package.json`, extends `resolveWorkspaceSpecifier`'s existing candidate-list fallback
  (`workspace.ts:147-180`) with a first pass over `exports`/`types`/`main`, and produces the
  `PackageEntrypoint[]` that `inferSurface.ts` consumes. Lives beside `workspace.ts`, not inside it — same
  file-per-concern boundary the package already keeps between `workspace.ts` (package inventory + specifier
  resolution) and `manifest.ts` (dependency fields), rather than growing `workspace.ts` into a second
  responsibility.
- **Composition**: a new `PublicSurfaceInferrer` injection seam in core (interface only, mirroring
  `Scanner`/`ManifestScanner`, `docs/core-interfaces.md:316-329` and `:345-406`), concretely implemented by
  plugin-typescript's entrypoint resolver + core's pure walk, wired at
  `packages/cli/src/composition-root.ts` exactly like `TypeScriptScanner`/`NodeManifestScanner` already are.

This split is the direct CODING_BEST_PRACTICES.md §14 application the companion gap analysis's §3 flags: the
inference-accuracy risk lives entirely in the pure core algorithm, which means it's testable with plain
`DependencyGraph` fixtures and zero filesystem/process mocking — the same reason `symbolDiff.ts` and every
`RuleEvaluator` are already pure functions over plain data.

### Algorithm sketch

1. **Entrypoint resolution** (plugin-typescript, impure shell), per workspace package:
   - Read `package.json`. If `exports` is present: resolve the `.` condition (respecting nested
     `import`/`require`/`types`/`default` conditions) to a path; if that path points under a `dist`-shaped
     output directory, apply the same `dist` → `src` remap `resolveWorkspaceSpecifier` already performs for
     ordinary cross-package specifiers (workspace.ts's existing package-entry → source mapping, ADR 004) so
     resolution works pre-build. Also resolve any subpath conditions (`./foo`) — each becomes its own
     `PackageEntrypoint`, since a package legitimately has more than one public surface (langchain's
     `./output_parsers`, the false positive `spike-findings.md` already documented for the naive
     single-entrypoint assumption).
   - Else check `types`, then `main`, applying the same `dist` → `src` remap.
   - Else fall back to the existing filename-convention candidate list (`workspace.ts:157-179`) unchanged,
     recording `candidateCount` (how many candidates resolved to real files): exactly one → an
     `inferred-unique` entrypoint (`file` set); zero → an `inferred-none` entrypoint (`file: null`).
     (Round 2 observed 0 ambiguous/multi-candidate cases across 9 repos, so >1 is modeled but unobserved —
     it maps to `inferred-none` conservatively.)
   - Tag the result with the `SurfaceProvenance` variant that produced it; the `confidence` grade follows
     from the discriminant (declared source → `declared`; convention with `candidateCount === 1` →
     `inferred-unique`; otherwise → `inferred-none`).
2. **Transitive barrel walk** (core, pure), per entrypoint:
   - Start with the entrypoint file's own `exports` (already computed by `extractExportedSymbols` today,
     unchanged — named exports and namespace re-exports already resolve correctly, §1.3/§1.4 of the gap
     analysis).
   - For each outgoing `reexport`/`type-only` edge from the current file (already in `DependencyGraph.edges`,
     no new scanning): if it's a named re-export, the symbol is already accounted for by (the target file's)
     `extractExportedSymbols` output — no recursion needed beyond confirming the target resolves. If it's a
     bare `export *` (today invisible to `exports.ts` by design), recurse into the target file's own computed
     surface and union its symbols in, propagating `reachableVia` (append this hop). Confidence degrades
     monotonically along the chain: a `declared` or `inferred-unique` entrypoint whose barrel reaches an
     **unresolvable** hop drops the affected `PublicSurfaceEntry` to `inferred-none` (the gate-blocking
     grade) — end-to-end reachability is only as trustworthy as its weakest hop. A resolvable
     `inferred-unique` hop does not degrade a `declared` chain further; only unresolvability does.
   - Maintain a visited-file set per walk to detect and name `barrel-cycle` rather than infinite-looping.
   - An edge whose target doesn't resolve to a scanned source node becomes an `unresolvable-reexport` marker,
     following the same "named category, not new machinery" doctrine ADR 004 already applies to
     `UncertaintyReason` (`docs/adr/004-graph-extraction.md:54-66`) — deliberately not building speculative
     handling for shapes no real repo has been observed to hit yet.
3. **Assembly**: one `PackagePublicSurface` per workspace package, all its entrypoints' walks merged.

### Persistence — a confirmed, one-time onboarding artifact

Modeled directly on `.align/ruleset-ir.json` (ADR 014) and the baseline-consent doctrine (ADR 006), not
re-inferred silently on every check:

- `align surface infer [--out .align/public-surface.json]` (new command, or a step folded into `align init`)
  runs the algorithm above once and writes a committed, human-readable JSON artifact —
  `{ irVersion, inferredAt, surfaces: PackagePublicSurface[] }` — the same "portable JSON, zod-parsed on read"
  discipline every other IR-shaped artifact in this codebase already follows (ADR 002's locked decision #1).
- **Human confirmation gate, same posture as baseline acceptance (ADR 006).** The artifact is not silently
  trusted the moment it's generated — `align surface infer` prints a loud summary (packages resolving
  `inferred-none` — no entrypoint found — first, since that is the grade that blocks autofix; then
  `inferred-unique` packages; then any `uncertain` markers) and, in non-interactive/CI contexts, requires an
  explicit acknowledgment flag before the artifact is considered confirmed — mirroring `align init`'s
  `--accept-existing` requirement exactly. This is the mechanism that lets a human correct a mis-resolved
  entrypoint before any downstream rule gates on it. (Round 2 evidence: `inferred-unique` does **not** need
  this scrutiny for accuracy — it scored 100% P/R on nest — but confirmation stays cheap and uniform.)
- **Re-infer + diff, not silent overwrite.** A second `align surface infer` run diffs against the committed
  artifact and reports additions/removals/confidence changes — analogous to `align baseline prune`'s
  move-detection story (ADR 006) — rather than silently replacing a human-reviewed artifact with a fresh
  guess every time it's re-run.
- **Gitignored?** No — deliberately the opposite of telemetry (ADR 015). This artifact is meant to be
  committed and reviewed like `.align/baseline.json`/`.align/ruleset-ir.json`, since it's an input to
  future rule *evaluation*, not a local usage log.

## Falsification / validation plan

> **STATUS: EXECUTED (2 rounds) — see `docs/evidence/surface-inference-spike/SPIKE_REPORT.md`.** The plan
> below is the original design; results: items 1-3 passed with independent (compiler-API, published-npm)
> ground truth — 99.67% P / 100% R on backstage incl. subpath entrypoints, 100% P/R on the inferred path
> (nest vs published `.d.ts`). Item 4's gate is met **for the pure algorithm**. Still open, gating the
> **persisted-artifact + `align surface infer` CLI** (not the algorithm): (a) no evidence yet that a
> committed surface artifact prevents a real wrong autofix — the explicit promotion criterion; (b) the
> `SurfaceUncertaintyMarker` vocabulary (`barrel-cycle`, `unresolvable-reexport`) fired **zero times** across
> all 9 repos in both rounds and needs a hand-built fixture before it is trusted to gate anything.

This is the section that gates whether this mechanism is worth shipping at all — per the project's own
"zero new rule kinds cleared the bar" standard (`rule-expansion-evaluation.md`), a new *inference mechanism*
proposed as prerequisite infrastructure should clear a comparable bar, not get a pass for being upstream of
something evidenced.

1. **Validate against backstage's *declared* surface as ground truth.** Backstage runs API Extractor and has
   247 `@internal`-tagged files (the verified count both this ADR and the gap analysis cite) — run the
   inference algorithm **blind** (ignore any `@internal` tag, ignore any existing `api-report` output) and
   diff the inferred surface against backstage's own declared/reported public API. Precision/recall here is
   the direct measure of whether the barrel-walk + entrypoint-resolution algorithm agrees with a repo that
   has already done this curation by hand. This directly reuses `dataset-c-spike`'s own methodology
   (backstage as the tooled-repo ground truth) rather than inventing a new validation repo.
2. **Stress-test on the sparse-metadata case: nest (0 `@internal` tags) and directus (1 tag).** These are the
   two repos `fable-feedback-round2.md` verifies have essentially no hand-curated API metadata — exactly the
   untooled-market case this mechanism exists to serve. Measure: what fraction of each repo's packages get a
   `'declared'`-confidence entrypoint (via `exports`/`main`/`types`) vs. fall back to `'inferred'`
   convention-guessing, and hand-validate a sample of the inferred surface for plausibility (same TP/FP
   discipline `spike-findings.md` applied to Rules A/B/C — "raw counts are NOT the result").
3. **Report false positive/negative rate on a hand-checked sample, not raw counts** — following
   `spike-findings.md`'s explicit discipline. In particular, re-run the exact Rule A false-positive case
   (langchain's `output_parsers/index.ts`) through this mechanism and confirm it now resolves as a
   `'declared'`-confidence, legitimately-public subpath entrypoint rather than a flagged leak — this is the
   single concrete regression test the existing evidence base already hands us.
4. **Gate promotion of the downstream rules on this clearing a bar**, not on this ADR's acceptance alone. If
   the inference algorithm's precision/recall on backstage is weak, or the nest/directus sample shows the
   convention-fallback path producing implausible surfaces at a meaningful rate, that is grounds to revise
   the algorithm (or keep it in Design Reserve) before either the `@internal` barrel-escape rule or the
   deep-import provenance rule's symbol-confirmation step is built on top of it.

## Out of scope

- **The `@internal` barrel-escape rule** (IR kind, DSL verb, evaluator, `FixHint`) — a future ADR, gated on
  §5's validation results, not authorized by this one.
- **The deep-import provenance rule** — same. Note per the gap analysis and `TOP-5-CATEGORY-BREAKDOWN.md`
  #2 that Rule B's high-precision core (`/src`|`/dist`|`/lib`|`/internal` deep-reach detection) needs **no**
  symbol-resolution layer on its own and can ship independently and earlier; this ADR only concerns the part
  of deep-import provenance that needs to confirm a rewritten import target is actually exported from the
  entrypoint (the safe-rewrite case), which does depend on this mechanism.
- **Any autofix implementation for either downstream rule.** The diff-only/HEAD-vs-working-diff distinction
  (`docs/proposals/stage0-surface-inference-gap-analysis.md` §4) is a constraint this ADR's contract is
  designed to make possible later (via the confidence field), not something this ADR builds.
- **Rule A as a metric** (`export *` count at entrypoints as a health signal, `spike-findings.md`'s
  recommended demotion from hard rule to advisory) — mentioned only as a beneficiary of the same
  symbol-resolution layer (`fable-feedback-round2.md` §4's "unlocks #1's rule, #2's safe rewrite, and Rule A
  as a metric *together*"), not designed here.
- **CommonJS-only packages** (`module.exports = {...}` with no ESM export syntax) — no evidence gathered on
  prevalence in the target market; building handling now would be evidence-free speculative machinery,
  the exact pattern ADR 004's uncertainty-vocabulary section already warns against.
- **Non-pnpm workspace formats (Nx, etc.)** — same reject-with-reason as
  `rule-expansion-evaluation.md`'s Nx assessment: zero evidence base, no real Nx repo has ever been run
  through align.
- **Any network-backed check** — this entire mechanism is local, offline, static-analysis-only; no version of
  it needs the network-gate-class discussion `rule-expansion-evaluation.md` §B.3.1 raises for unrelated
  supply-chain candidates.

## Alternatives considered

- **Skip entrypoint-resolution improvements; only build the barrel walk, keyed off the existing
  filename-convention guess.** Rejected: this reproduces Rule A's exact documented false positive
  (`output_parsers/index.ts`) for every package with a curated `exports` subpath — the confidence signal this
  ADR's contract is built around would be meaningless if the entrypoint itself is never resolved from the
  manifest when one exists.
- **Skip the persisted/confirmed artifact; re-infer fresh on every `align check`.** Rejected, mirroring ADR
  006's own reasoning against silent baseline re-seeding: a downstream autofix rule conditioning its safety
  on a `'declared'` vs `'inferred'` confidence signal needs that signal to be stable and human-reviewed, not
  silently recomputed (and potentially silently changed) on every scan.
- **Fold entrypoint resolution and the barrel walk into one impure module in plugin-typescript**, skipping
  the core/plugin split. Rejected: the barrel walk itself needs no filesystem access once the
  `DependencyGraph` exists — keeping it pure and in core makes it unit-testable with plain fixture graphs
  (no repo on disk needed) and keeps the pattern consistent with every other `RuleEvaluator`/pure-transform
  in this codebase (CODING_BEST_PRACTICES.md §14, §4's "class only for state+lifecycle/polymorphism/DI
  boundary" — there is no such need here, so this stays functions over data, not a service class).
- **Promote straight to building the `@internal`/deep-import rules now, treating market evidence as
  sufficient.** Rejected: matches this project's own explicit doctrine violation the rule-expansion-evaluation
  document names repeatedly — landscape/market evidence is not repo-measured evidence. The falsification plan
  (§5) exists specifically to convert the former into the latter before anything downstream is promoted.

## Consequences

- `packages/core/src/types/publicSurface.ts` and `packages/core/src/surface/inferSurface.ts` become new,
  small, framework-free additions to core — no existing core file needs restructuring.
- `workspace.ts`'s existing `resolveWorkspaceSpecifier` heuristic is unchanged by this ADR; entrypoint
  resolution for a package's *own* declared entry is additive (`entrypoint.ts`), not a rewrite of the
  specifier-resolution path used for arbitrary cross-package imports.
- A new persisted artifact (`.align/public-surface.json`) joins `.align/baseline.json`,
  `.align/ruleset-ir.json`, and `.align/generated-rules.json` as a committed, human-reviewable file — the
  project's `.gitignore` posture for `.align/*` needs one more explicit non-ignored entry, following the same
  precedent ADR 015 already established for the opposite case (telemetry, deliberately gitignored).
- Every future consumer of `PackagePublicSurface` (the `@internal` rule, the deep-import rewrite's
  symbol-confirmation step, Rule A's eventual metric) reads the same confidence-carrying contract — a single
  place to get the "was this declared or guessed" question right, rather than three separate ad hoc guesses.
- If §5's validation shows weak precision/recall, this ADR's mechanism stays in Design Reserve rather than
  shipping — the falsification plan is designed to make that a legitimate, expected outcome, not a failure of
  the ADR.

## Evidence

- File:line citations throughout are the primary evidence for "what already exists" — see
  `docs/proposals/stage0-surface-inference-gap-analysis.md` for the consolidated version.
- Market/motivation evidence: `/Users/spikedpunchvictim/temp/enterprise-apps/pr-research/dataset-c-spike/spike-findings.md`
  (Rule A/B/C TP/FP verdicts) and `fable-feedback-round2.md` (transitive-barrel critique §1, autofix-safety
  regime §2, market-mismatch `@internal` counts, §5's onboarding-gap framing).
- **No spike has yet been run on the inference algorithm itself** — this is explicitly a design/falsification
  proposal, not a promotion backed by measured accuracy. §5 is the plan for closing that gap; until it runs,
  this mechanism's actual precision/recall is unknown and must not be asserted as validated in any status
  update that cites this ADR.
