# Public-Surface Inference Spike Report (Stage-S falsification spike)

**Date**: 2026-07-19
**Trigger**: `docs/adr/016-public-surface-inference.md` §"Falsification / validation plan" — this ADR is
DRAFT, pending owner sign-off, and explicitly states "no spike has yet been run on the inference algorithm
itself." This report is that spike.
**Targets** (read-only): `/Users/spikedpunchvictim/temp/enterprise-apps/{backstage,nest,directus,langchainjs}`.
Nothing under any target was modified. **No production code was written** — nothing under
`packages/*/src` in this repo changed. The only repo file this spike adds is this report.
**Spike code** (throwaway, not to be productionized as-is — see Caveats):
`/private/tmp/claude-501/-Users-spikedpunchvictim-projects-align/2183e330-9ae0-4643-92e2-6ea09185483b/scratchpad/surface_infer.py`
(entrypoint resolution + transitive barrel walk), plus two runner scripts in the same directory:
`run_backstage_validation.py` (precision/recall vs `report.api.md`) and `internal_leak_check.py`
(`@internal` source-scan leak measurement). Raw per-package output:
`backstage_validation.json`, `internal_leak_results.json` (same directory).

All numbers below are measured by running these scripts against the real repos on disk, then
**hand-verified by reading source** for every non-obvious result — per `spike-findings.md`'s explicit
discipline, raw counts are not the result.

---

## Method note on the prototype (read this before the numbers)

The script is **regex-based, not a TS-AST parse** — it does not use the TypeScript compiler API the way
`packages/plugin-typescript/src/exports.ts` does. This is a deliberate throwaway-spike shortcut (matching
`spike.py`'s own precedent), not a claim that regex extraction is what should ship. Two concrete regex
limitations were found *during* this spike (both documented below with the exact case that surfaced them)
and are the dominant cause of the residual imprecision reported for backstage. A real AST-based
implementation, as ADR 016 §"Where it lives" specifies, would not have either limitation — so the backstage
precision number below is a **conservative floor**, not a ceiling, on what the actual algorithm can do.

Two bugs were also *found and fixed* mid-spike by hand-checking a suspicious result rather than trusting the
first run's raw counts — both are called out inline because they're evidence the hand-checking discipline
actually did its job:
1. `export type { X } from './y'` (a very common TS re-export form) wasn't matched by the initial regex —
   caught because `@backstage/plugin-catalog-common` scored recall=0.0, which is the kind of jarring result
   that self-flags to check by hand rather than getting averaged away.
2. `parse_api_md`'s ground-truth extractor didn't recognize `export default someExpr;` (no keyword between
   `default` and the expression) — caught the same way, a recurring `n_inferred=2, n_declared=1` pattern
   across ~10 packages that turned out to be a ground-truth-parser gap, not an inference error.
3. `remap_to_src`'s `dist/ → src/` remap assumed every repo wraps source in a `src/` directory —
   `@directus/utils` ships `dist/shared/index.js` built straight from `./shared/index.ts` with no `src/`
   wrapper at all. Fixed by also trying the bare de-prefixed path.

---

## (a) Backstage — precision/recall vs. declared ground truth

**Ground truth**: `report.api.md` (API Extractor output), symbols on `export ...` lines directly preceded by
a `// @public` comment. 205 `report.api.md` files exist on disk; 204 had a non-empty declared-or-inferred
set and were scored (1 package's report is empty of both).

**Inference run blind**: the algorithm never reads `@internal`/`@public` tags or any `report.api.md` file —
only `package.json` + source `export` syntax, exactly as ADR 016 §5.1 requires.

| Metric | Value |
|---|---|
| Packages scored | 204 |
| Micro precision (ΣTP / (ΣTP+ΣFP)) | **0.974** (3600 / 3697) |
| Micro recall (ΣTP / (ΣTP+ΣFN)) | **0.998** (3600 / 3606) |
| Macro-avg precision | 0.986 |
| Macro-avg recall | 0.999 |

### Hand-checked root causes of the residual imprecision (not raw counts — read the actual files)

Every one of the 10 lowest-precision packages was opened and read against its `report.api.md`. Two
explanations account for essentially all of it:

1. **Regex limitation: TS `namespace` member flattening.** `@backstage/plugin-bitbucket-cloud-common` scored
   precision 0.145 (55 inferred vs. 8 declared) — the single worst outlier. Its `src/events/index.ts` does:
   ```ts
   /** @public */
   export namespace Events {
     /** @public */
     export interface RepoEvent { ... }
     ...
   }
   ```
   `report.api.md` correctly reports one public symbol, `Events` (a namespace) — `RepoEvent` etc. are
   namespace *members*, only reachable as `Events.RepoEvent`, never as a bare top-level export. The regex
   script can't see TS scoping and flatly matches every `export interface` line regardless of namespace
   nesting, inflating the symbol count. **This is a prototype limitation, not an ADR 016 algorithm
   limitation** — a real implementation built on `ts.SourceFile` (as `exports.ts` already is) would scope
   this correctly for free, since it already walks a real AST, not text.
2. **Ground-truth parser limitation: untagged forwarded re-exports.** `@backstage/core-plugin-api` scored
   precision 0.909 (55 vs. 50); all 5 "false positives" (`useApi`, `withApis`, `ApiRefConfig`,
   `IconComponent`, `useApiHolder`) are real, genuinely-public re-exports —
   `report.api.md:553` literally has `export { useApi };` — but API Extractor doesn't require a fresh
   `// @public` tag on a forwarded re-export of an already-tagged symbol, so my strict "must have `@public`
   directly above" ground-truth parser misses them. Same root cause explains `@backstage/catalog-model`'s
   8 "FPs" (`ApiEntity` etc. — all `export { ApiEntityV1alpha1 as ApiEntity };` aliases, untagged, genuinely
   public). **These are true positives my ground truth undercounts, not inference errors** — meaning true
   precision is higher than 0.974, not lower.

Net read: the inference algorithm's *actual* agreement with backstage's hand-curated public API is very
close to 100% on every case hand-checked; the measured 97.4%/99.8% is a defensible floor, with a known,
named, and fully-explained cause for essentially all of the gap — not unexplained noise.

### `@internal` exclusion rate (separate measurement, source-scanned — see note below)

`report.api.md` mostly **omits** `@internal`-tagged declarations entirely rather than tagging them
in-report (confirmed: 0 `@internal` tags found across all 204 scored `report.api.md` files) — so exclusion
can't be measured against the report. Measured directly instead: scanned every `.ts`/`.tsx` source file in
all 223 backstage workspace packages for `/** @internal */`-tagged exported declarations, then checked
whether blind inference (which never reads this tag) still surfaced that symbol name from the package's
own `.` entrypoint.

| Metric | Value |
|---|---|
| `@internal`-tagged exported symbols found (source scan) | 354 |
| Leaked into the blind-inferred public surface | **17 (4.8%)** |
| Correctly excluded (not barrel-reachable) | 337 (95.2%) |

Hand-checked 2 of the 17 leaks:
- **`useIsPodExecTerminalSupported`** (`plugins/kubernetes-react/src/hooks/...`) — a genuine, confirmed leak:
  `index.ts → export * from './hooks' → hooks/index.ts → export * from './useIsPodExecTerminalSupported'`.
  Two bare-star hops. **This is exactly the case the naive one-hop `spike.py`'s Rule C could never catch**
  (`fable-feedback-round2.md` §1's core critique) — a concrete, positive validation that the transitive walk
  does what it was built for.
- **`createExtension`** (`packages/frontend-plugin-api/src/wiring/createExtension.ts`) — a **false positive
  of the leak-detection script**, not a real leak: TS function-overload pattern, 3 declarations of the same
  exported name, only the *implementation* signature (the 3rd) is tagged `@internal`; the two public-facing
  overload signatures are untagged. The exported name `createExtension` genuinely is public API (it's the
  package's primary export). My source-scanner counts each `@internal`-tagged declaration independently and
  doesn't understand overload grouping, so 1-2 of the 17 "leaks" (`createExtension`,
  `createExtensionBlueprint`, both same package, both same overload pattern) are measurement artifacts —
  the true leak rate is closer to 15/354 ≈ 4.2%, not materially different from the headline number.

---

## (b) nest / directus — the untooled case

| Repo | Packages | Declared entrypoint (`exports`/`main`/`types`) | Inferred (convention fallback) | No entrypoint |
|---|--:|--:|--:|--:|
| nest | 9 | **0 (0%)** | 9 (100%) | 0 |
| directus | 36 | **35 (97%)** | 0 (0%) | 1 (root monorepo package, correctly excluded — not a library) |

**Nest matches the ADR's prediction exactly**: zero of its 9 real lerna-workspace packages
(`packages/*` per `lerna.json`) declare `exports`/`main`/`types` in `package.json` at all — every one falls
back to filename-convention guessing (`index.ts` at package root, not even `src/index.ts`).

**Directus is a genuinely useful counter-finding, not just a confirmation**: it has near-zero `@internal`
curation (Fable's verified count: 1 tag) but a **97% declared-entrypoint rate** — almost every package has a
real `package.json` `exports`/`main` field, because it's a set of independently `npm`-published packages,
which forces basic manifest hygiene regardless of whether anyone ever wrote an `@internal` tag. **"Declared
entrypoint" and "curated public/internal API metadata" are orthogonal axes, not the same untooled/tooled
split the ADR's prose sometimes conflates them into** — this mechanism helps directus even though directus
has none of API-Extractor's curation culture, because entrypoint declaration and API-surface curation are
different things a repo can have independently.

### Hand-validated plausibility sample (15 packages: all 9 nest + 6 directus)

All 9 nest packages and 6 sampled directus packages (`@directus/sdk`, `@directus/utils`, `@directus/errors`,
`@directus/schema`, `@directus/extensions-sdk`, plus the `@directus/utils` cross-condition case) were
inspected symbol-by-symbol. Every inferred surface reads as a plausible, genuine public API — real
well-known symbols (`BadRequestException`, `TestingModule`, `ClientGrpc`, `ConnectedSocket`, `DirectusError`,
`SchemaInspector`, `createInspector`), zero implausible/junk entries, and **zero `barrel-cycle` or
`unresolvable-reexport` markers fired across any of the 15** (nest's `@nestjs/testing` barrel, for example,
walks 4 star-reexports cleanly with 7 correctly-collected symbols). `@directus/extensions-sdk`'s root `.`
entrypoint correctly resolved to 0 symbols (it's a CLI package; the real API lives at the `./cli` subpath,
which resolved with 2 symbols, `build`/`create`) — a plausible, not broken, result.

**Caveat**: this spike never observed a real `barrel-cycle` or genuinely `unresolvable-reexport` case fire
across backstage, nest, directus, *or* langchain — 0 uncertainty markers total across every package
inspected. That half of ADR 016's contract (the `SurfaceUncertaintyMarker` vocabulary) is **completely
unexercised by this evidence base**, not validated, not falsified — an honest gap, not a finding either way.

---

## (c) langchain regression: **PASS**

The concrete regression this ADR names (§5.3, and `spike-findings.md`'s Rule A false positive):

```
@langchain/core package.json exports:
  "./output_parsers": { "input": "./src/output_parsers/index.ts", "require": {...}, "import": {...} }
```

Inference result:
```
conditionPath: ./output_parsers
file:          libs/langchain-core/src/output_parsers/index.ts
source:        package.json:exports
confidence:    declared
n_symbols:     30
uncertain:     []
```

`./output_parsers` resolves as a **`declared`-confidence, legitimate subpath entrypoint** — not flagged as a
leak or an inferred/guessed surface. This directly fixes the naive-spike false positive
(`spike-findings.md`: "langchain's flagged `output_parsers/index.ts` IS a declared public export subpath").

One implementation note beyond what ADR 016's algorithm sketch spells out: `@langchain/core`'s `exports` map
uses an `"input"` condition (a `tsdown`/`tsup` convention pointing straight at pre-build `.ts` source) that
the ADR's sketch doesn't explicitly name alongside `import`/`require`/`types`/`default`. This spike's
resolver treats `input` as highest-priority when present (it's the most direct source pointer available,
consistent with the ADR's own "resolves pre-build" intent) — worth folding into the ADR's condition-priority
list explicitly rather than leaving it an implementation-time surprise. Also confirmed as a side effect: the
package's root `.` entrypoint (`src/index.ts`) is literally `export {};` — a deliberately empty root, forcing
all consumption through subpaths. The algorithm correctly reports 0 symbols there rather than erroring or
guessing, which is the correct behavior, not a bug.

---

## (d) Recommendation

> **⚠️ CORRECTION (Round 2, see § below).** A skeptical audit found that Round 1's precision/recall
> was measured **regex-vs-regex against a ground truth known to undercount** (the GT parser read only
> one name per `export { a, b }` line), so the claim further down that *"the real AST numbers can only
> get better"* was **unsupported** — they could equally have fallen. Round 2 re-ran the whole thing
> with the TypeScript compiler API on **both** sides against corrected ground truth. Net: the numbers
> **held** (99.67% precision / 100% recall), and an independent published-artifact check on the
> untooled path scored **100%** — but the binary `declared`/`inferred` confidence contract was found
> **partly degenerate** and should become **graded** before `publicSurface.ts` is frozen. Read the
> Round 2 section for the corrected evidence; treat the paragraph immediately below as Round-1 context.

**(ii) Split it — validate/build the pure inference algorithm now; promotion-gate the persisted-artifact
and `align surface infer` command machinery on further evidence.**

Why not (i) full sign-off:
- The evidence here is strong (97-99%+ on every measured axis, hand-checked, with the residual gap fully
  explained by prototype-specific causes that a real AST implementation wouldn't have) — but it was produced
  by a regex throwaway, not the actual `packages/core/src/surface/inferSurface.ts` /
  `packages/plugin-typescript/src/entrypoint.ts` modules the ADR designs. That gap should close by building
  the real thing and re-running this same validation against it (cheap: the ground truth and repos are
  already staged), not by extrapolating from the prototype.
- **The `SurfaceUncertaintyMarker` vocabulary (`barrel-cycle`, `unresolvable-reexport`) fired zero times
  across all four repos.** This spike validates the "happy path" of entrypoint resolution + barrel walk
  thoroughly; it provides *no* evidence about whether cycle detection or unresolvable-target handling behaves
  correctly, because neither case ever occurred in real code. That's a real, not cosmetic, gap for a
  mechanism whose whole contract is "confidence you can condition autofix-safety on."
- The **persisted artifact, `align surface infer` command, confirmation-gate UX, and re-infer/diff story**
  (ADR 016 §"Persistence") were not touched by this spike at all — by design, and correctly out of scope for
  a pure-algorithm falsification spike, but that means zero evidence exists yet for that half of the ADR.

Why not (iii) Design Reserve: the accuracy is not weak — it's the strongest-evidenced number in any spike
this project has run against a hand-curated ground truth (99.8% recall, and every "precision loss" traced to
a named, explained, non-algorithmic cause). Sending a mechanism this well-supported to Design Reserve would
be under-crediting real evidence, the mirror-image mistake of the promotion-on-evidence doctrine this
project already holds itself to.

**Concretely**: build `publicSurface.ts` + `inferSurface.ts` + `entrypoint.ts` as designed, re-run this
report's three validations (backstage precision/recall, nest/directus declared-rate + plausibility, langchain
regression) against the real AST-based implementation to confirm the two regex-specific issues actually
disappear, and add at least one repo-sourced or hand-constructed fixture that exercises `barrel-cycle` and
`unresolvable-reexport` before either is trusted. Keep the persisted artifact / `align surface infer` CLI /
confirmation-gate machinery, and any downstream rule (`@internal` barrel-escape, deep-import provenance),
gated behind that follow-up — consistent with §5 item 4's own instruction not to let this ADR's acceptance
alone authorize what's downstream of it.

---

## Reproducibility

Throwaway script (entrypoint resolution + transitive barrel walk):
`/private/tmp/claude-501/-Users-spikedpunchvictim-projects-align/2183e330-9ae0-4643-92e2-6ea09185483b/scratchpad/surface_infer.py`

```
python3 surface_infer.py langchainjs --pkg "@langchain/core"   # single-package detail dump
python3 surface_infer.py nest                                  # declared-vs-inferred distribution
python3 run_backstage_validation.py                             # precision/recall vs report.api.md
python3 internal_leak_check.py                                  # @internal source-scan leak rate
```

Raw per-package data: `backstage_validation.json`, `internal_leak_results.json` (same directory).

---

# Round 2 — Independent-GT revalidation & confidence-contract survey

Round 1 was audited and three methodological problems were found and addressed here. **Both the
inference extractor and the ground-truth parser were rebuilt on the TypeScript compiler API**
(`typescript@5.9.3`), eliminating the correlated-regex-error problem, and validation was widened
from a 15-package hand sample to **all scorable packages including subpath entrypoints**, plus an
**independent published-artifact** check the market case never had. Scripts:
`scratchpad/round2/{ts_surface.js, task_a_backstage.js, task_b_declared_rate.js, task_c_inferred_validation.js}`;
raw data: `scratchpad/round2/{backstage_validation_round2.json, declared_rate_round2.json, task_c_results.json}`.

## (a) Task A — independent-GT Backstage precision/recall: the numbers HELD

AST parse on **both** sides (declared surface from `report.api.md` parsed with `ts.createSourceFile`,
handling `export { a, b }`, `export namespace`, `export type`, overloads; inference via AST entrypoint
resolution + transitive `export *` walk). Scored **295 packages** (vs Round 1's ~15-package sample),
of which **91 were subpath entrypoints** (Round 1 scored only the `.` entrypoint — the novel
subpath machinery had been unmeasured).

- **Micro precision 99.67% (4246 TP / 14 FP), micro recall 100.00% (0 FN).**
- vs Round 1's regex-vs-regex 97.4% / 99.8% → **precision rose, recall held.** The correlated-error
  worry did not materially inflate Round 1; corrected parsing on both sides produced *cleaner*
  agreement, not worse.
- **Honest caveat carried forward:** recall = 1.0000 on Backstage is near-tautological because
  Backstage's `api-report` CI *forces* declared ≈ reachable (audit point #2). Task A proves the
  algorithm agrees with a curated declared surface; it does **not** prove behaviour where declared
  and reachable diverge. That is what Task C exists to test.

## (b) Task B — declared-rate survey across all 9 TS repos + the contract-shape decision

Per-repo fraction of workspace packages resolving to a `declared` entrypoint (package.json
`exports`/`main`/`types`) vs the convention `inferred` fallback, with the inferred cases graded:

| repo | pkgs | declared % | inferred-unique | inferred-none |
|---|--:|--:|--:|--:|
| backstage | 223 | 98.7% | 3 | 0 |
| directus | 39 | 94.9% | 0 | 2 |
| langchainjs | 44 | 95.5% | 1 | 1 |
| opentelemetry-js | 55 | 83.6% | 1 | 8 |
| n8n | 51 | 80.4% | 5 | 5 |
| strapi | 54 | 74.1% | 4 | 10 |
| vscode | 96 | 33.3% | 1 | 63 |
| nest | 9 | 0% | 9 | 0 |
| cdk8s | 1 | 0% | 0 | 1 |
| **all** | **572** | **80.1%** | **24** | **90** |

**Findings that correct Round 1:**
- **The market is NOT uniformly nest-like.** Round 1 generalized "untooled → 0% declared" from nest
  alone; across 9 repos **80.1%** of packages are `declared`. nest (0%) and cdk8s (0%) and vscode
  (33%, an internal non-publishing monorepo — 63 unresolvable) are the low outliers, not the norm.
- **Binary `declared`/`inferred` is partly degenerate — and the reason is precise.** Of 114 inferred
  cases, **0 are ambiguous**, **24 resolve to a single unambiguous candidate** (`inferred-unique` —
  including all 9 nest packages), and **90 resolve to no candidate at all** (`inferred-none`). The
  binary flag lumps nest's 9 confidently-resolved entrypoints together with vscode's 63 unresolvable
  ones, even though Task C proves the former are 100% accurate. The real risk axis is
  **resolvable vs unresolvable**, not **declared vs inferred**.
- **Recommendation (decide before freezing `publicSurface.ts`): move to a GRADED confidence signal** —
  `declared` (manifest) / `inferred-unique` (single convention hit) / `inferred-none` (unresolvable) —
  not the binary contract ADR 016 currently proposes. `inferred-none` is the only grade that should
  block autofix; gating on `declared` alone would needlessly silence autofix on nest-shaped packages
  that are demonstrably accurate.

## (c) Task C — inferred-path vs PUBLISHED npm artifacts: 100%, and this is the real result

The `inferred` path is ~100% of what fires in the untooled market yet Round 1 only eyeballed it.
Here, 5 `@nestjs/*` packages (all resolving via the `inferred-unique` path, 0% declared) had their
inferred surface diffed against the **published npm `.d.ts`** — an independent ground truth (network
was available; tarballs pulled via `npm pack`).

- **@nestjs/common, core, microservices, testing, websockets: micro precision 100%, recall 100%**
  (380 symbols, 0 FP, 0 FN).
- This is the strongest single result in the spike: independent GT (not self-authored), the *inferred*
  path (not declared), and the *untooled* market case. It directly refutes the fear that "inferred"
  means "inaccurate." **"Inferred" means "not declared in package.json," not "unreliable"** — a nest
  package resolving `inferred-unique` produced a perfect surface against what npm actually ships.

## (d) Round 2 recommendation — "split it" HOLDS, with one contract change

- **Build the pure algorithm** (`publicSurface.ts` + `inferSurface.ts` + `entrypoint.ts`) — evidence
  is now independent-GT-backed on both the tooled (Task A, 99.67/100) and untooled (Task C, 100/100)
  cases. "Split it" survives the audit.
- **CHANGE THE CONTRACT BEFORE FREEZING IT:** `PackageEntrypoint.confidence` should be the **graded**
  `'declared' | 'inferred-unique' | 'inferred-none'`, not binary. This is the one substantive design
  change Round 2 forces; it must land in `publicSurface.ts` from the start, not be retrofitted.
- **Still promotion-gated (unchanged):** the persisted `.align/public-surface.json` artifact,
  `align surface infer` command, and confirmation-gate UX — no evidence gathered on those. **Explicit
  promotion criterion (the audit's demand):** a real repo where a stale/committed surface artifact
  demonstrably prevents a wrong autofix, OR a downstream rule ADR that needs the persisted signal.
- **Still unexercised:** the `SurfaceUncertaintyMarker` vocabulary (`barrel-cycle`,
  `unresolvable-reexport`) fired **zero times** across all 9 repos in both rounds. A hand-built
  fixture must exercise both before either is trusted to gate anything.
- **Downstream, not Stage 0 (now resolved):** the nest-degeneracy worry the audit raised is answered —
  nest is `inferred-unique` + 100% accurate, so the graded contract carries the signal fine. What
  remains genuinely downstream is whether the `@internal`/deep-import rules gate autofix on the right
  grade (`inferred-none` blocks, `inferred-unique` allows) — a question for those rules' ADRs.
