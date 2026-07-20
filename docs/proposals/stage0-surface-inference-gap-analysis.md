# Stage 0: Public-Surface Inference — Gap Analysis

**Status**: Proposal — no code, plan, ADR, or config changes in this document. Companion to
`docs/adr/016-public-surface-inference.md` (draft, pending owner sign-off). Written under the same
promotion-on-evidence doctrine as `docs/proposals/rule-expansion-evaluation.md`: the burden of proof is on
promotion, not on the mechanism already being designed.

**Scope**: does align already have what it needs to determine, for each workspace package, (a) its public
entrypoint file(s) and (b) the full set of symbols externally reachable through that entrypoint — including
through transitive `export *` barrel chains — **without** requiring `package.json` `exports`/`@public`/
`@internal` metadata to already exist? Answer: **no, on both counts, but less is missing than it looks.**
Most of the graph primitives this needs are already collected for other reasons; the gap is two specific,
narrow deltas plus an assembly layer that doesn't exist anywhere in the codebase today.

---

## 1. What already exists (cited, file:line)

### 1.1 Workspace package inventory and specifier resolution
`packages/plugin-typescript/src/workspace.ts`:
- `WorkspacePackage` (`workspace.ts:12-15`) is `{ name, dir }` only. No `main`, `types`, or `exports`
  field is modeled anywhere on this type.
- `loadWorkspacePackages` (`workspace.ts:55-79`) reads each workspace member's `package.json` and pulls out
  exactly one field: `pkg.name` (`workspace.ts:69`). Nothing else is parsed.
- `resolveWorkspaceSpecifier` (`workspace.ts:147-180`) is the closest thing to entrypoint resolution that
  exists. Its own doc comment (`workspace.ts:143-146`) is explicit about what it is: "Tries common TS
  monorepo entry conventions rather than a full package.json `exports` map resolver — a deliberately boring
  heuristic (CODING_BEST_PRACTICES.md §3), documented as a v1 limitation." It walks a hardcoded candidate
  list (`src/index.ts`, `index.ts`, `src/index.tsx`, …) and returns the first one that exists on disk
  (`workspace.ts:157-179`). It never reads `package.json`'s `main`/`types`/`exports` fields — it resolves
  by filename convention, not by manifest declaration.

### 1.2 Manifest reading
`packages/plugin-typescript/src/manifest.ts`'s `RawPackageJson` interface (`manifest.ts:26-30`) models
exactly three fields: `dependencies`, `devDependencies`, `optionalDependencies`. A repo-wide grep for
`"exports"`, `"main"`, `"types"`, `typesVersions` across `packages/plugin-typescript/src` and
`packages/core/src` returns zero hits for any of those fields being *read* from a `package.json` — the only
hit is an unrelated comment (`manifest.ts:114`, "Scans the manifest domain"). **Nothing in this codebase
today reads a package's declared `exports` map, `main`, or `types` field, for any purpose.**

### 1.3 Per-file exported-symbol extraction
`packages/plugin-typescript/src/exports.ts`'s `extractExportedSymbols` (`exports.ts:31-87`) is a per-`ts.SourceFile`
pass. It correctly handles named exports (`export { foo }`, `export const foo`, `export function foo`, etc.,
including destructured bindings) and namespace re-exports (`export * as ns from './other'`,
`exports.ts:54-58`, since the binding name is statically known without resolving the target). It explicitly
does **not** resolve bare `export * from './other'` — the doc comment (`exports.ts:6-8`) states this
outright: "`export * from './other'` barrels are the one case that would require resolving and scanning the
target module to enumerate; that's out of scope here, so barrels are recognized (not crashed on) and simply
contribute no symbols of their own." The implementation (`exports.ts:44-49`) confirms this: when
`statement.exportClause === undefined` (the bare-star case), the function `continue`s without adding
anything.

### 1.4 The graph already carries reexport edges — for both the star and named case
`packages/plugin-typescript/src/scanner.ts`'s edge-extraction (`scanner.ts:304-310`) records a
`DependencyGraphEdge` with `kind: 'reexport'` (or `'type-only'`) for **any** `ts.ExportDeclaration` that has
a `moduleSpecifier` — this covers `export { foo } from './x'` *and* the bare `export * from './x'` case
identically at the edge level; the distinction only matters to `exports.ts`'s symbol-table pass, not to
scanner.ts's edge extraction. `docs/core-interfaces.md:246` confirms `reexport` is a first-class
`EdgeKind`. **So the graph already has a directed edge for every barrel hop** — what's missing is walking
those edges transitively and, for the bare-star case, recursively pulling in the target's own `exports` list
(§2.1 below).

### 1.5 Components registry — files-to-name, not package-to-public-API
`packages/core/src/components/registry.ts` models `ComponentDefinitionIR` → `FileSelector` (glob or
package-name) and classifies files into named components (`classifyFile`, `registry.ts:38-48`). This answers
"which component does file X belong to," never "what is component X's public API." There is no concept of a
component/package *having* a public surface anywhere in `packages/core/src/types` or
`docs/core-interfaces.md` — `DependencyGraphNode.exports` (`docs/core-interfaces.md:252`) is a flat
`readonly string[]` per file, with no package-scoping, no entrypoint designation, no transitivity, and no
provenance/confidence field distinguishing a declared export from an inferred one.

### 1.6 The one existing consumer of export data is file-level, not surface-level
`packages/agent/src/symbolDiff.ts`'s `diffExportedSymbols` (`symbolDiff.ts:17-29`) diffs
`SymbolTableEntry[]` before/after a fix, purely per-file (`beforeEntry.file` → `afterExports`). This is
align's green≠correct guard (a fix that deletes an exported symbol becomes an escalating advisory,
`symbolDiff.ts:1-6`) — it has no notion of whether the removed symbol was *publicly reachable*, only
whether it existed in that file's export list before and after. Confirms: **no existing code path needs, or
supplies, package-level public-surface reachability today.**

### 1.7 ADR precedent for the extraction philosophy
ADR 004 (`docs/adr/004-graph-extraction.md`) already establishes "package-entry → source mapping" as a v1
requirement (lines 41-44) — but scoped narrowly to "so cross-package imports resolve to a scannable node,"
not "so a package's intentionally-curated public API can be computed." The same ADR's uncertainty-vocabulary
doctrine (lines 54-66: "uncertainty vocabulary over uncertainty machinery," name the categories that
actually occur, don't build speculative machinery) is the right frame to apply to surface inference's own
uncertainty (barrel cycles, unresolvable re-export targets, `export *` through a non-source file) — see
§3 of the companion ADR.

---

## 2. What's genuinely missing

### 2.1 Transitive barrel-walk / symbol-level reachability
Nothing in the codebase walks `index.ts → export * from './sub' → sub/index.ts → export * from
'./helper'` to compute the flattened set of symbols actually reachable from a package's entrypoint. This is
structural, not accidental — `exports.ts`'s own doc comment names cross-file resolution as explicitly out
of scope for that pass (§1.3). It is also independently confirmed as the correct diagnosis by
`dataset-c-spike/fable-feedback-round2.md` §1: Rule C's (`@internal` barrel-escape) detector is "one hop
only... transitive chains... are invisible," and "the detector cannot see the mechanism its own category
calls dominant." align's own codebase has exactly the same one-hop limitation, for exactly the same
structural reason.

### 2.2 Entrypoint resolution from package.json (`main`/`types`/`exports`), not just filename convention
`resolveWorkspaceSpecifier` guesses a file by trying a fixed candidate list; it never consults the
package's own declared entrypoint. This matters for two reasons the spike surfaced directly:
- **False positives from ignoring `exports` map subpaths.** `spike-findings.md`'s Rule A verdict: "langchain's
  flagged `output_parsers/index.ts` IS a declared public export subpath (`./output_parsers`) — §10.2's
  *recommended* pattern. Flagging it is a false positive." A surface-inference mechanism that doesn't consult
  a package's `exports` map when present will repeat this exact mistake for any package that has one.
- **No confidence distinction.** There is currently no way to say "this package declared `exports.'.'` = X
  explicitly" vs. "we guessed X because `src/index.ts` happened to exist." Both facts about `WorkspacePackage`
  today are collapsed into one `dir` field with no entrypoint metadata at all (§1.1).

### 2.3 No public-surface data model in core
No type anywhere (checked `packages/core/src/types/`, `docs/core-interfaces.md`, `docs/ir-schema.md`)
represents "package X's public entrypoint is file Y, discovered via Z, and its externally-reachable symbol
set is {…}, with per-symbol/per-file uncertainty." This has to be designed from scratch — it does not exist
as an unfinished stub anywhere, unlike (say) `custom.host`, which exists schema-only and only needs a
registration surface (`docs/proposals/rule-expansion-evaluation.md` §B.0).

### 2.4 What is NOT missing (worth being honest about, so the delta isn't oversold)
- The graph already has the `reexport`/`type-only` edges needed to walk barrel chains (§1.4) — this is not
  a new scan domain, it's a graph-algorithm layer over data align already collects.
- Named re-exports (`export { foo } from './other'`) are already resolved to the importer-facing name by
  `extractExportedSymbols` (`exports.ts:50-53`) — only the bare-star case is unhandled.
- The package-entry → source directory mapping mechanism (resolving a workspace specifier past
  `node_modules`/`dist` to real source, ADR 004) already exists and is exactly the substrate a smarter
  entrypoint resolver would extend, not replace.

**Net assessment: this is a medium-small, well-bounded delta — an assembly + two point-fixes over
existing primitives — not a new scanning subsystem.** The honest risk is not scanner cost or architectural
fit; it is *inference accuracy*, addressed in §4.

---

## 3. Precise delta to build

1. **Entrypoint resolver, generalized.** Extend the package-entry resolution `resolveWorkspaceSpecifier`
   already does for arbitrary import specifiers (`workspace.ts:147-180`) to first check the package's own
   `package.json` for `exports` (root `.` condition, with `require`/`import`/`types` condition handling and
   a `src`-remap for the common `dist` → `src` monorepo pattern — since `dist` won't exist pre-build, per
   ADR 004's own framing), then `types`, then `main`, falling back to the existing filename-convention list
   **only** when none of those resolve. Each result carries which source produced it (declared-via-manifest
   vs. convention-fallback) — this is the confidence signal §2.2 identifies as missing.
2. **Transitive barrel walk.** A pure function (no I/O — the `DependencyGraph` is already fully materialized
   by the time this runs) that, starting from a resolved entrypoint file, follows `reexport`/`type-only`
   edges recursively: for a named re-export, the symbol is already in `exports.ts`'s per-file list; for a
   bare `export *`, recurse into the target file's own computed surface and union it in. Needs cycle
   detection (a barrel that re-exports itself transitively) and a recursion-depth or visited-set guard, with
   any cycle or unresolvable hop surfaced as a named uncertainty category — following ADR 004's "uncertainty
   vocabulary over uncertainty machinery" precedent (§1.7) rather than inventing new machinery for a case
   that may never fire in practice.
3. **A `PackagePublicSurface` data model in core** binding (1) and (2) together per package, with confidence
   fields at both the entrypoint level and (ideally) the per-symbol level, since a barrel can mix a
   declared-subpath re-export with a convention-guessed one. See the companion ADR for the concrete interface
   shapes.
4. **A persisted, human-reviewable artifact** — the inferred surface has to be confirmed once (like
   baseline acceptance, ADR 006) rather than silently re-inferred and trusted fresh on every check, because
   downstream rule severity and autofix safety both depend on it being right.

---

## 4. Market-mismatch and autofix-diff-only constraints (Fable review)

These constraints, from `dataset-c-spike/fable-feedback-round2.md`, directly shape why this is a
prerequisite and not an optional nicety, and must be carried into any downstream rule design:

- **The `@internal`-tag rule is market-mismatched without this.** Verified `@internal`-tagged-file counts:
  backstage 247, vscode 53, strapi 40, langchain 28, n8n 14, otel 9, **directus 1, nest 0**
  (`fable-feedback-round2.md`, independently re-verified in the same document's closing note — matches the
  reviewer's probe). A rule keyed on `@internal` annotations fires almost exclusively in the *tooled* repos
  (API-Extractor culture) — exactly the population `README.md`'s own bias note says "needs align least."
  The untooled mid-size repo — align's actual target market per the same document — mostly doesn't write
  `@internal` at all. Surface inference (barrel-reachability + naming-convention/underscore heuristics,
  computed independent of any tag) is what makes the *category* (public-surface leakage) usable in a repo
  that has never annotated anything — this is `fable-feedback-round2.md` §5's "single biggest unnamed risk":
  every one of align's top-3 candidate rules assumes machine-readable API-surface metadata that, in the
  untooled target market, "largely don't exist." Surface inference is the fix for that gap, not a bonus.
- **Autofix must be diff-only, never blanket-safe.** Per `fable-feedback-round2.md` §2: removing a symbol
  from a barrel is "safe only pre-publication" — a symbol already at HEAD may be relied on by the repo's own
  code (otel's `_clearDefaultServiceNameCache` is imported by its own tests) or by external consumers who
  never read the `@internal` tag. **Rule: auto-apply only when the symbol first appears in the working diff;
  suggest-only at HEAD.** Deep-import → entrypoint rewrite is "the most dangerous" of the two — it can
  execute code the deep import deliberately avoided (tree-shaking, side-effect ordering) and can introduce a
  cycle; **suggest-only in an editor context, auto-apply only inside an agent loop that runs build+test
  after.** This ADR's scope is the inference mechanism only — it does not implement either rule's autofix —
  but the inferred-surface artifact's confidence field is precisely the signal a future autofix
  implementation needs to distinguish "safe to touch" from "leave alone," so the contract has to carry it
  from day one rather than bolting it on later.

---

## 5. Difficulty and risk assessment (honest)

- **Scanning/architecture-fit difficulty: low-medium.** As shown in §2.4, the graph primitives (reexport
  edges, per-file exports) already exist; the deltas are a smarter entrypoint resolver and a recursive walk
  over data already in memory. No new AST pass over source is required beyond what `exports.ts`/`scanner.ts`
  already do. This fits comfortably inside `packages/plugin-typescript` (impure shell: reading
  `package.json`, resolving files) and `packages/core` (pure shell: the graph walk itself), matching the
  scanner/manifest-scanner split ADR already established.
- **Inference-accuracy risk: the real risk, not the plumbing.** Rule A's own false positive
  (`spike-findings.md`: langchain's `output_parsers/index.ts`) shows a naive "everything re-exported through
  a barrel is public surface" inference over-fires the moment a repo has *any* curated subpath export. The
  confidence signal (§3 item 3) exists specifically to contain this, but its accuracy is unproven until
  measured — see the companion ADR's falsification plan (validate against backstage's *declared* surface as
  ground truth, then stress-test on nest/directus's sparse-metadata case). **This mechanism should not be
  treated as promote-now infrastructure the way `custom.host`'s registration surface was
  (`rule-expansion-evaluation.md` §B.0) — that item had an existing, dated, already-occurred false-green to
  point to. This one has strong landscape/market evidence for *why it's needed*, but zero repo-measured
  evidence yet for whether the specific inference algorithm proposed here is *accurate*.** Treat it the way
  `docs/adr/013-security-manifest-gate.md`'s manifest probe treated its own candidates: build the smallest
  version, run it read-only against real repos, and only then decide whether (and how) it gates anything.
- **Scope-creep risk.** It is tempting to build the downstream rules (`@internal` barrel-escape, deep-import
  provenance) at the same time as the inference layer, since the motivating evidence discusses them together.
  This document and its companion ADR deliberately do not — see "Out of scope" in the ADR. Shipping the
  inference layer and its own validation first, as a separately-evaluated Stage 0, keeps the promotion
  decision for each downstream rule cleanly evidence-gated on its own terms, exactly as
  `rule-expansion-evaluation.md`'s doctrine already requires project-wide ("the burden of proof is on
  promotion").
- **Non-TS/non-ESM scope.** This delta is scoped to `plugin-typescript`'s existing ESM/CJS-via-TS-compiler
  world. CommonJS-only packages (`module.exports = {...}` with no ESM export syntax at all) are not analyzed
  by `exports.ts` today and are out of scope for this proposal too — no evidence has been gathered on how
  common that shape is in the target market, and inventing handling for it now would be exactly the
  "building ahead of evidence" pattern `docs/adr/004-graph-extraction.md`'s uncertainty-vocabulary section
  warns against.
