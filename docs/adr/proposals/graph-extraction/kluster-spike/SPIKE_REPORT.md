# align — Kluster Spike Report (Stage S)

**Date**: 2026-07-11
**Target**: `/Users/spikedpunchvictim/projects/align/test-apps/kluster` (writable copy; original at
`~/projects/kluster` untouched). Scan roots: `packages/`, `application/`, `features/`.
`packages/workbench/sdd/apps/**` excluded per user directive (pipeline test-run output, not source).
**Spike code**: `spike/src/` (throwaway). Measured artifacts: `spike/out/graph-stats.json`,
`spike/out/violations.json`, `spike/out/mcp-transcript.txt`.

All numbers below are measured, not estimated, except where marked "projected".

---

## Q1 — Graph extraction performance: seconds or minutes?

**Seconds. Comfortably.**

| Metric | Value |
|---|---|
| Cold scan wall-time (parse + nearest-tsconfig + module resolution) | **2.16–2.33 s** across runs |
| Files scanned | **1,755** (.ts/.tsx/.js/.jsx) |
| Total LOC | **455,931** |
| Graph nodes | 1,755 |
| Edges: `import` | 5,160 |
| Edges: `type-only` | **2,665 (32% of all edges)** |
| Edges: `reexport` | 397 |
| Edges: `dynamic` | 116 |
| **Total edges** | **8,338** |
| External packages referenced (not traversed) | 69 |
| Heap before scan | ~42 MB |
| Peak heap (sampled every 100 files + at end) | **131–136 MB** |
| Rule evaluation (all 5 rules, incl. repo-wide Tarjan SCC) | **8–77 ms** |

Scan-and-discard works as designed: peak heap ~136 MB for a 456K-LOC monorepo (ASTs discarded per file,
only primitive edge data retained). Throughput ≈ 800 files/s ≈ 200K LOC/s including module resolution.
Rule evaluation is noise compared to scanning. Extrapolation: even a 10x larger monorepo stays under
~30 s cold and likely under ~1 GB heap — no OOM cliff in sight for the per-file syntactic strategy.

## Q2 — Edge quality: how often does uncertainty bite?

**32 uncertain edges across 23 files = 1.3% of files affected.** Breakdown by reason:

| Reason | Count |
|---|---|
| `unresolvable-specifier` | 31 |
| `non-literal-dynamic-specifier` | 1 |
| `export *` targets that couldn't be resolved | **0** (all 397 re-exports resolved) |

Concrete examples, categorized:

1. **The one true Conservative-Graph-Mode case** — `application/api/src/db/migrate.ts:215`,
   `import(pathToFileURL(fullPath).href)`: a runtime migration loader. Exactly the shape the plan's
   uncertainty machinery exists for. There is exactly **one** in the whole repo.
2. **Asset import misclassified as uncertainty** — `application/ui/src/main.tsx:8`, `./styles.css`.
   Not a dependency-graph problem; a resolver-vocabulary problem. v1 needs an asset-extension category
   so CSS/SVG/JSON-ish imports don't pollute the uncertainty signal.
3. **Standalone test fixtures** (24 of the 31 unresolvable) — files under
   `packages/workbench/fold/substrate-packages/**` importing `fastify`, `kysely`, `twilio`,
   `@kluster/ast.noTokenInLogs`, `@fold/schemas` from directories where those packages are deliberately
   not installed (they are pattern-check fixtures, e.g.
   `.../ast-checks/authRequiredOnProtectedRoute/tests/shouldFail.ts:1`). Honest unresolvables — but they
   are *fixture* code, and a components/exclusion registry is the right fix, not graph machinery.
4. **Staged build artifacts** — 4 in `packages/workbench/sdd/claude-runner/.stage/fold-mcp/dist-bundle/**`
   (bundled JS importing `@modelcontextprotocol/sdk`, `ajv`). Should have been excluded as build output;
   `.stage`/`dist-bundle` weren't in the spike's hardcoded exclusion list. Build-output exclusion must be
   configurable, not hardcoded heuristics.
5. **Missing devDependency** — `application/api/test/integration/audit-1m-rows-200ms.test.ts:190,266`
   imports `pg-copy-streams`, which does not resolve anywhere up the tree. A genuine repo hygiene finding.

**The finding that matters more than all of the above — pnpm symlinks silently cut 898 edges (~11% of
the graph).** First implementation classified edges as external via
`resolvedModule.isExternalLibraryImport || path.includes('node_modules')`. In a pnpm workspace,
`@kluster/core`, `@fold/*`, `@foldv2/*` etc. resolve *through* `node_modules` symlinks, so **every
inter-package edge** (898: 363 import, 410 type-only, 24 dynamic, 1 reexport; 30 workspace packages
misclassified as external) vanished — with zero uncertainty markers. A false-green vector that produces
no warning at all. Fix: realpath the resolved file, classify by real location
(`spike/src/tsconfig-resolver.ts`, `resolveUncached`). This is a v1 hard requirement.

**Barrels**: no `export *` resolution failures; barrels were not a source of uncertainty in this repo —
they were a source of a real *cycle* (see Q4). **Aliases**: the root tsconfig maps `@kluster/shared/*`
to a directory that does not exist; measured impact: zero, because no source file actually imports it
(it appears only as string data inside mast's own import-resolver). Dead config — an `align doctor`
advisory ("alias target missing"), not a graph problem.

Caveat worth recording: workspace-package imports resolve to `dist/**/*.d.ts` targets. Component
classification by path prefix still works on those paths, but dist files are not scanned nodes, so
**cross-package cycles through package entry points are invisible** to this spike. v1 needs
package-entry → source mapping (or package-level graph nodes) to close that gap.

## Q3 — MCP tool usability (registration + exercised transcript)

Registration (either form):

```bash
claude mcp add align-spike -- pnpm --dir /Users/spikedpunchvictim/projects/align/spike exec tsx src/mcp.ts
```

```json
// .mcp.json
{
  "mcpServers": {
    "align-spike": {
      "command": "pnpm",
      "args": ["--dir", "/Users/spikedpunchvictim/projects/align/spike", "exec", "tsx", "src/mcp.ts"]
    }
  }
}
```

Both tools exercised over the real stdio protocol by an in-process client
(`spike/src/client-test.ts`; full 162-line transcript at `spike/out/mcp-transcript.txt`). Highlights:

- `tools/list` → both tools with descriptions.
- `align_check` (cold): **2,329 ms** — scan happens inside the first tool call, then is cached.
  Second call: **79 ms**. Response: `verdict: "red"`, per-rule counts (5 rules), violations grouped by
  rule with `shown/total`, uncertainty summary. Zero passing-rule prose.
- `align_explain_rule` with a fired rule id → intent, constraint sentence, both components with
  descriptions + 3 example files each, "what a fix looks like".
- Error path: unknown ruleId → structured `isError: true` text listing known rule ids; server survives.

Whether Claude Code *discovers* the tool unprompted (the second half of Q3) requires the live session
test, which this spike explicitly leaves to the user. The tool-side prerequisites are in place: the
`align_check` description names its capability ("architecture rules... dependency constraints + cycle
detection") and the cold call is fast enough (~2.3 s) not to be abandoned.

## Q4 — Violation actionability

Three violations, verbatim from `spike/out/violations.json` (2 real, 1 deliberate probe):

**1. Probe** (single forbidden import added to the writable copy at
`application/api/src/server.ts` — the only kluster edit made; remove by deleting lines 7–8):

```json
{
  "ruleId": "no-ui-import-in-api",
  "kind": "no-dependency",
  "fromFile": "application/api/src/server.ts",
  "toFile": "application/ui/src/util/cx.ts",
  "specifier": "../../ui/src/util/cx.js",
  "line": 8,
  "message": "'application/api/src/server.ts' (component 'api-app') imports 'application/ui/src/util/cx.ts' (component 'ui-app') via '../../ui/src/util/cx.js' at line 8, which rule 'no-ui-import-in-api' forbids: The API must remain headless: backend code must never couple to React/frontend modules.",
  "fixHint": "Remove or invert this dependency. Options: (a) delete the import at application/api/src/server.ts:8 if unused; (b) move the shared code out of 'ui-app' into a component both sides may depend on; (c) invert the dependency via an interface owned by 'api-app' and implemented in 'ui-app'."
}
```

File, line, and specifier verified exact against the inserted probe.

**2. Real cycle (UI)** — verified by hand against the source:

```json
{
  "ruleId": "no-runtime-cycles",
  "kind": "no-cycles",
  "chain": [
    "application/ui/src/views/root-layout.tsx",
    "application/ui/src/components/project-sidebar.tsx",
    "application/ui/src/views/root-layout.tsx"
  ],
  "message": "Import cycle of 2 file(s) detected in scope 'repo': application/ui/src/views/root-layout.tsx -> application/ui/src/components/project-sidebar.tsx -> application/ui/src/views/root-layout.tsx. ...",
  "fixHint": "Break one edge in the chain: typically extract the shared symbols into a new module both sides import, or replace the back-edge (last arrow in the chain) with an interface/type-only import."
}
```

Ground truth: `root-layout.tsx:28` imports `ProjectSidebar`; `project-sidebar.tsx:44` imports
`WORKSPACE_NAV_TABS` back from `root-layout.tsx`. A genuine latent bug the repo's own toolchain never
flagged; the right fix (move `WORKSPACE_NAV_TABS` to a constants module) is exactly what the fixHint
suggests generically.

**3. Real cycle (test fixture barrel)** — `mock-idp/google.ts -> mock-idp/index.ts -> google.ts`
(fixture files import their own barrel; the barrel re-exports them).

**Assessment — is this enough for an LLM to act?**

- `no-dependency` violations: **yes.** File, line, exact specifier, both component names, direction,
  rationale, and three concrete fix strategies. An agent can locate and delete/relocate the import
  without further queries. Missing: (a) a **code snippet** of the offending line — the agent must read
  the file to build a search/replace block (the plan's `snippet` field on Violation is validated as
  necessary); (b) **whether the imported symbol is used** — deciding between fix (a) delete and
  (b)/(c) relocate/invert requires usage info the payload doesn't carry.
- `no-cycles` violations: **mostly.** The chain names the files, but **no per-edge line numbers or
  specifiers** — the agent must grep each file in the chain to find the back-edge import statement.
  v1 cycle violations should carry `{from, to, specifier, line}` per chain edge, and ideally name
  the specific edge whose removal is suggested. The fixHint is generic where it could be specific.

## Q5 — Components fit

**8 components; 0 of 1,755 scanned files unmapped.** Coverage was total, but only after three
human judgment calls the model could not have made alone:

1. **`packages/workbench/sdd/apps/**` had to be excluded by user directive.** Structurally it looks like
   source (90 tsconfigs, packages, src trees); it is actually pipeline test output. ~800 files and an
   entire second copy of app-shaped code would otherwise have polluted every metric. No layout heuristic
   distinguishes "generated app snapshot" from "real app" — this is a consent/config decision.
2. **Workspace-orphaned packages**: `@fold/*` (13 packages under `packages/workbench/fold/`) and
   `packages/workbench/sdd/` are in no `pnpm-workspace.yaml` glob. Package-name-based component binding
   (the plan's preferred stable identity) would have silently missed them; path prefixes caught them.
   Package names and path globs are complementary, not interchangeable — a repo's package registry
   can lie about what lives in the tree.
3. **Dead alias**: `@kluster/shared/*` maps to a nonexistent directory. Harmless here, but a
   components/aliases model that trusted tsconfig paths as ground truth would carry a phantom component.

Where the model did *not* fight the repo: application/api, application/ui, kluster-bt (core vs nodes vs
llm-providers), and mast all mapped cleanly to first-prefix-match components, and the measured
cross-component edge matrix confirms the layering is real:
`bt-nodes -> bt-core` 194 edges, `api-app -> bt-core` 61, `bt-nodes -> llm-providers` 22,
`api-app -> llm-providers` 10, `api-app -> bt-nodes` 2, `fold-workbench -> mast` 2 — every direction
consistent with the intended architecture. 3 of 5 rules were green on the untouched repo because the
repo genuinely honors them.

## Q6 — Payload token economy

Measured on the real `align_check` response containing 3 violations (JSON, pretty-printed 2-space):

| Payload | Bytes | ≈ Tokens (bytes/4) |
|---|---|---|
| `align_check` (3 violations + counts + uncertainty) | 3,588 | **897** |
| `align_explain_rule` | 1,278 | 320 |
| Envelope alone (verdict, 5 rule counts, uncertainty block) | 1,402 | 351 |
| Average serialized violation | 729 | **182** |

Projected (envelope + N × avg violation, uncapped):

| Violations | Bytes | ≈ Tokens |
|---|---|---|
| 10 | 8,692 | 2,173 |
| 50 | 37,852 | 9,463 |
| 200 | 147,202 | **36,801** |

Conclusions: 182 tokens/violation is dominated by self-inflicted redundancy — `message` restates
`fromFile/toFile/specifier/line` that already exist as fields, and `fixHint` repeats file:line again.
Rendering prose *at the surface* from structured fields (or dropping `message` entirely for MCP
consumers) would roughly halve the per-violation cost. Even so, 200 violations ≈ 37K tokens confirms
the plan's caps/pagination are mandatory, not optional; the spike's first-10-per-rule cap keeps any
response under ~10 KB. Compact JSON (no pretty-printing) would save a further ~15–20%.

---

## Recommendations for the v1 re-audit

Blunt, evidence-ranked:

1. **Per-file syntactic scan-and-discard: strongly confirmed. Promote as-is.** 2.2 s / 136 MB peak on
   456K LOC. The OOM risk row in the plan is retired for this strategy. No incremental scanning is
   needed for repos of this class — cold rescans are cheap enough that the session cache
   (79 ms warm MCP calls) is already the right optimization, not persistent graph caches.
2. **pnpm realpath classification is a new v1 hard requirement (false-green, severity-zero class).**
   `isExternalLibraryImport` + node_modules substring checks silently deleted 11% of edges — every
   cross-package edge — with no uncertainty marker. Add to Stage 2's graph-extraction commitments and
   the false-green test suite (a pnpm-workspace fixture asserting inter-package edges exist).
3. **Nearest-tsconfig discovery: needed, cheap, keep.** ~90 tsconfigs with extends chains resolved
   correctly (NodeNext `.js`-extension imports, `.tsx` extension imports, per-package options); with
   per-directory + per-tsconfig caching it is a rounding error inside 2.2 s. The documented fallback
   resolver was **not** needed — `ts.resolveModuleName` cost well under a third of spike effort.
   One trap for the ADR: strip `include`/`files` before `parseJsonConfigFileContent`, or it enumerates
   input files for every tsconfig (pure wasted I/O).
4. **Conservative Graph Mode: keep the mechanism, downgrade the ambition.** Real-world uncertainty was
   1.3% of files, and exactly **one** non-literal dynamic import in 456K LOC. Package-scope expansion
   would trigger on ~1.3% of files — negligible cost. The ≥80%-of-edges heuristic stays in the Design
   Reserve (no evidence it would ever fire here). What the uncertainty list actually needs is better
   *vocabulary*: asset imports (`.css`) and build-artifact files must not masquerade as graph
   uncertainty. Add an asset-specifier category and configurable build-output excludes
   (`.stage/`, `dist-bundle/` burned this spike).
5. **Type-only edges as first-class: confirmed emphatically.** 32% of all edges (2,665/8,338). Any
   design that drops them discards a third of the graph.
6. **Components registry: path prefixes are the load-bearing selector; package names are a
   complement, not the primary.** Evidence: 13 workspace-orphaned `@fold/*` packages that package-name
   binding would have missed, plus one dead alias. Keep the plan's "globs and/or package names" design,
   but the ADR should state that package-name selectors must be validated against the tree at load
   (empty-selector-fails already covers this — keep it). Fixture/generated-code exclusion is a human
   consent decision — fold it into `align init`'s interactive review.
7. **`no-cycles` is the day-one value rule; `no-dependency` is the guardrail.** On an untouched,
   reasonably healthy repo, all three no-dependency rules were green (the layering matrix confirms the
   architecture is honored), while cycle detection found two real latent bugs (one in shipped UI code).
   For adoption messaging and `align init` defaults, lead with cycles; no-dependency rules prove their
   value as regression guards (the probe fired with exact file/line/specifier on first try).
8. **Violation model: add `snippet` (already planned — now evidenced) and per-edge detail on cycle
   chains** (`{from, to, specifier, line}` per hop). Drop redundant prose from machine payloads;
   render `message` at the surface from structured fields. Measured redundancy is ~2x per violation.
9. **Cross-package edges resolve to `dist/*.d.ts`** — v1 must map package entry points back to source
   (or model packages as graph nodes) or package-boundary cycles stay invisible.
10. **MCP oracle shape validated.** Scan-inside-first-tool-call (2.3 s) + session cache (79 ms) is a
    fine UX; counts-only-for-passing kept a red 5-rule response under 900 tokens. The `align_check` /
    `align_explain_rule` split felt right in use: check stays terse, explanation is pulled on demand.

**Probe note**: the single deliberate violation remains in the writable copy at
`test-apps/kluster/application/api/src/server.ts` lines 7–8 (marked `ALIGN-SPIKE PROBE`) so a live
Claude Code discovery session has a red verdict to find; delete those two lines to restore green
(minus the two real cycles, which are the repo's own).

---

# Spike Extension — Probes 3/5/4 (2026-07-11, same day)

Follow-up empirical probes approved after the main report. Probe scripts:
`spike/src/probe-rescan.ts`, `spike/src/probe-extensions.ts`, `spike/src/probe-external.ts`,
`spike/src/probe-n8n-uncertain.ts`. All numbers measured.

## Probe 3 — Rescan economics: does the MVP need incremental machinery?

**No. Not at this repo class.** 20 iterations of "modify one source file → full rescan"
(in-process, warm V8, fresh resolver each pass — exactly what a long-lived MCP server re-check does):

| Metric | Value |
|---|---|
| Warm full-rescan mean | **1,374 ms** |
| p95 | 1,652 ms |
| min / max | 1,178 ms / 2,545 ms (max = first iteration, JIT warmup) |
| Rule evaluation mean (5 rules incl. repo-wide SCC) | 49.9 ms |
| RSS after 20 rescans | 300 MB (heap 121 → 332 MB, lazy GC of superseded graphs; bounded, no leak signal) |

Warm rescan (1.37 s) is *faster* than the cold scan (2.2 s). At 456K LOC, rescan-on-check is a
perfectly acceptable inner-loop cost, and content-hash caching / impact-scoped re-verification buys at
most ~1.3 s per check. The n8n data point below (12.9 s at 3.2M LOC) marks where that calculus changes:
incremental machinery earns its complexity somewhere between these two repo sizes — build it when a
target repo demands it, not before.

## Probe 5a — Type-only cycle noise

Repo-wide cycles with `type-only` edges **excluded**: 2 (the two real ones reported above).
With type-only edges **included**: **4** — the two extra being
`bt-core registry.ts <-> node.ts` (mutual type references) and a 3-hop loop through
`bt-core replay/replay.ts -> index.ts -> replay/index.ts -> replay.ts` (barrel type re-export loop).
Both extras are benign type-reference loops with no runtime failure mode and no obvious fix value —
sending them to a fix agent would be noise. **Excluding type-only edges from the cycle-rule default is
confirmed correct**; a strict opt-in variant can exist for teams that want type-graph hygiene.
(Type-only edges stay first-class in the *graph* — this is only about the cycle rule's default scope.)

## Probe 5b — Inferred starter rules (the `align init` zero-authoring story)

Of 8 components → 56 ordered pairs: **49 pairs (87.5%) have zero edges today** and are candidate
auto-generated `no-dependency` rules; 7 pairs have real edges (61/194/22/10/2/2 edges, plus the 1-edge
probe). Every candidate is green on day one — **the seeded baseline for inferred dependency rules is
zero**, which is the best possible `align init` first impression. Caveat: proposing 49 pairwise rules
verbatim is overwhelm; the measured matrix collapses naturally into ~3 layer statements
(apps → libraries; plugins → engine; tooling isolated), which supports the plan's intent-level layer
macros as the generation target rather than pairwise dumps.

## Probe 5c — Payload compaction: hard numbers

Same 3 violations, structured-fields-only compact JSON (no `message` prose, fixHint as short code,
minified) vs the spike's prose payload:

| | Prose (spike MCP shape) | Compact | Reduction |
|---|---|---|---|
| Avg per violation | 729 B ≈ 182 tokens | **204 B ≈ 51 tokens** | **3.6x** |
| Envelope | 1,402 B | 190 B | 7.4x |
| 10 violations (projected) | 2,173 tokens | **558 tokens** | 3.9x |
| 50 violations | 9,463 tokens | **2,598 tokens** | 3.6x |
| 200 violations | 36,801 tokens | **10,248 tokens** | 3.6x |

The earlier "~2x redundancy" estimate was conservative: it is **3.6x**. Machine-facing payloads should
be structured-only with prose rendered client-side/at human surfaces; that single decision more than
triples the violation budget per context window.

## Probe 4 — Second repo (n = 2): n8n

`test-apps/n8n` (shallow clone, **no install** — honest accounting below), components auto-derived
from `pnpm-workspace.yaml` (71 workspace packages discovered in 22 ms), scan root `packages/`.

**Performance (scales fine):** 17,708 files / **3,234,354 LOC** in **12.9 s**, peak heap **231 MB**,
45,834 edges (34,988 import / 7,874 type-only / 2,203 reexport / 769 dynamic). 10x the files of
kluster → ~6x the time, +95 MB heap. Scan-and-discard holds; "minutes" never appeared; repo-wide
Tarjan over 45K edges: 3.0 s.

**Components fit: 100%.** 0 of 17,708 files unmapped by auto-derived workspace-package components on a
layout nobody hand-picked. Kluster's fit friction came from *non-package* trees (orphans, fixtures);
where a repo is disciplined about workspace packages, the components-from-packages model fits with
zero configuration.

**Uncertainty — the honest no-install numbers:** 31,587 unresolvable specifiers, 70.8% of files
affected. Decomposed:

| Class | Count | Verdict |
|---|---|---|
| Workspace-package specifiers, uninstalled (`n8n-workflow`, `@n8n/di`, …) | 17,139 | **No-install artifact** — resolvable from `pnpm-workspace.yaml` alone, no node_modules needed (see recommendation 3) |
| External deps, uninstalled (vitest 1,585, vue 960, zod 688, …) | 13,167 | No-install artifact — external edges are package-name-only anyway; a package.json cross-check could classify these without install |
| Relative/alias | 1,266 | The real resolver signal: **891 `.vue` SFC imports** + 168 asset imports (svg/json/scss/css) + ~30 imports of `../dist/*` build artifacts that don't exist pre-build + `@/` bundler aliases |
| Non-literal dynamic imports | **15** | In 3.2M LOC. Conservative Graph Mode's target population remains tiny (kluster: 1) |

The pnpm-realpath fix could not be exercised here (no symlinks without install) — untested on n=2,
still mandatory per kluster's evidence.

**Cycles: 207 runtime cycles** — real material: `json-schema-to-zod` `parse-schema <-> parse-one-of`
(recursive-descent parser), the vendored `@n8n/typeorm` fork (dozens — TypeORM is famously cyclic),
deliberate DI test fixtures, sample code. Two lessons: (1) `no-cycles` finds abundant true positives on
a messy mature repo, (2) **207 day-one violations makes baseline machinery a v1 prerequisite, not a
nice-to-have** — without `baseline accept`, the first check on a repo like n8n is a wall of red.

## Scope-cut recommendations (post-probe deltas to IMPLEMENTATION_PLAN.md)

**Move to Design Reserve (MVP does not build these):**
1. **Content-hash cache + impact-scoped re-verification.** Warm full rescan is 1.37 s at 456K LOC;
   rescan-on-check is the MVP verification strategy. Promotion trigger is empirical and now known:
   ~3M LOC repos cost ~13 s/check. (The six-component cache-key *design* stays on paper; nothing is
   deleted.)
2. **Conservative Graph Mode's package-scope expansion + 80% heuristic.** Target population measured
   twice: 1 non-literal dynamic import in 456K LOC, 15 in 3.2M LOC. Mark uncertain files, surface the
   count, and stop there for MVP.
3. **Plugin sessions / in-memory AST updates.** With no incremental machinery in the MVP, there is
   nothing for a session to accelerate (rescan is the session).

**Promote / confirm as v1:**
4. **Workspace-name resolver fallback (new mechanism, promote):** resolve workspace-package specifiers
   via `pnpm-workspace.yaml` + package.json names directly to source directories, bypassing
   node_modules. Evidence: it would have eliminated 17,139 of n8n's 31,587 uncertainties (54%) and
   removes `pnpm install` as a scan prerequisite. Cheap (the 22 ms discovery already exists) and it
   doubles as the dist→source entrypoint mapping from recommendation 9 of the main report.
5. **Baseline machinery (incl. `accept --rule`)**: v1-critical, evidence: 207 day-one cycles on n8n.
6. **Asset/bundler-domain specifier category**: `.vue`/`.css`/`.svg`/`.json` imports and
   bundler-config aliases must be classified, not dumped into `unresolvable` (1,059 of n8n's 1,266
   real-signal unresolvables are this).
7. **Structured-only machine payloads**: measured 3.6x token reduction; prose renders at human
   surfaces only. Fold into the Token Economy ADR as a norm.
8. **Cycle-rule default excludes type-only edges** (confirmed by probe 5a); type-only edges remain
   mandatory in the graph (32% of kluster's edges).
9. **`align init` layer-macro generation**: 87.5% of component pairs are zero-edge; generate ~3 layer
   statements, not 49 pairwise rules; seeded baseline for inferred dependency rules measured at zero.
