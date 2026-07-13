# ADR 004: Graph Extraction

**Status**: Accepted

## Context

The dependency graph is align's ground truth — every rule evaluates over it. Its extraction strategy has the
largest number of independently falsifiable claims in the whole design (memory bound, edge classification
correctness, config discovery correctness), so it's the part the spike spent the most measurement on. This
ADR fixes the extraction contract for the single v1 language plugin (`@spikedpunch/align-plugin-typescript`).

## Decision

**Per-file syntactic scan-and-discard** is the extraction strategy: parse each file with the TypeScript
compiler API (not ts-morph — the raw compiler API is the proven implementation), extract edges, discard the
AST immediately. The graph session caches only nodes + edges, never ASTs. Measured: **2.16–2.33 s wall-time,
131–136 MB peak heap, 1,755 files / 455,931 LOC** (kluster, cold); **12.9 s / 231 MB peak, 17,708 files /
3.23M LOC** (n8n) — confirms no OOM cliff for this strategy at 10x scale.

**pnpm realpath classification — v1 hard requirement, false-green severity-zero class.** In a pnpm
workspace, inter-package imports resolve *through* `node_modules` symlinks. Classifying edges via
`resolvedModule.isExternalLibraryImport || path.includes('node_modules')` silently misclassified **898
edges (~11% of kluster's graph: 363 import, 410 type-only, 24 dynamic, 1 reexport across 30 workspace
packages) as external, with zero uncertainty markers** — the single largest false-green vector the spike
found. Fix: realpath the resolved file and classify by real location. The false-green invariant test suite
(ADR 005 territory) gains a dedicated pnpm-workspace fixture asserting inter-package edges exist.

**Workspace-name resolver fallback.** Workspace package specifiers resolve from `pnpm-workspace.yaml`'s
package inventory directly to source directories, without requiring `node_modules` to exist. Evidence: 54%
of n8n's no-install "uncertainty" (17,139 of 31,587 unresolvable specifiers) was exactly uninstalled
*workspace* packages, resolvable from the workspace manifest alone (probe 4). This is what makes `pnpm
install` a non-prerequisite for seeing a repo's architecture — align must be usable read-only, pre-install.
It doubles as the entry-point mapping below.

**Type-only edges are first-class graph members**, `kind: 'type-only'`, **32% of all edges (2,665/8,338,
kluster)**. Dropping them discards a third of the graph. They are **excluded from the `arch.no-cycles` rule
default only** (not the graph): including them added exactly 2 benign type-reference loops with no runtime
failure mode (probe 5a) — noise for a fix agent. A strict opt-in variant may include them per-rule later;
the default stays runtime-only.

**Package-entry → source mapping.** Cross-package imports in a pnpm workspace resolve to `dist/**/*.d.ts`,
which are not scanned nodes. Without mapping a package's declared entry point back to its source directory
(or modeling packages as graph nodes), package-boundary cycles are invisible. v1 requirement — implemented
via the same workspace-name resolver above, which already knows each package's source directory.

**Nearest-tsconfig discovery.** For each source file, walk up to the first `tsconfig.json`, respect
`extends` chains, resolve path aliases per package. Validated against ~90 tsconfigs with extends chains
(NodeNext `.js`-extension imports, per-package options) at negligible added cost with per-directory caching;
the fallback resolver design in the plan was **not needed** — `ts.resolveModuleName` cost well under a third
of spike effort. **ADR-level trap, must be handled in the implementation**: strip `include`/`files` before
calling `parseJsonConfigFileContent`, or it enumerates every input file per tsconfig — pure wasted I/O that
does not show up until repo scale.

**Uncertainty vocabulary over uncertainty machinery.** Real-world uncertainty was **1.3% of files (32 edges
/ 23 files)** at 456K LOC and **15 non-literal dynamic imports in 3.23M LOC** (n8n) — genuinely rare.
Conservative Graph Mode's package-scope expansion for uncertain files is kept (negligible cost at this
rate); the ≥80%-of-edges-uncertain full-check-promotion heuristic stays in Design Reserve — no evidence it
would ever fire. What the uncertainty list actually needed was better *categories*, not more machinery:
- **Asset-specifier category**: `.css`/`.svg`/`.vue`/`.json`-ish imports are not graph uncertainty — kluster
  misclassified `./styles.css` as uncertain; n8n had 891 `.vue` SFC imports + 168 asset imports mixed into
  its unresolvable count.
- **Configurable build-output excludes**: `.stage/`, `dist-bundle/` polluted the spike's uncertainty list
  because they weren't in its hardcoded exclusion list — excludes must be config, not a fixed heuristic.
- Fixture/generated-tree exclusion (kluster's `sdd/apps`) is explicitly a human consent decision surfaced at
  `align init`, not a layout heuristic (ADR 003 territory) — no code path infers it.

## Alternatives considered

- **ts-morph-based scanning.** Rejected for the scan path: the spike proved the raw compiler API sufficient
  and faster for pure edge extraction; ts-morph's object model (and the plugin-session use case it enables)
  is explicitly Design Reserve, deferred with the incremental-machinery decision below.
- **Persistent incremental scanning / plugin sessions in v1.** Rejected — see ADR 005; warm rescan (1.37 s
  mean) is cheap enough that a session-level result cache is the only optimization v1 needs.
- **≥80%-of-edges-uncertain heuristic promoting a scan to full-repo scope.** Rejected for v1: zero
  observed trigger across two real repos (1.3% and ~0.5% uncertain-file rates); building the heuristic ahead
  of evidence is exactly the "design saturation" risk the plan's re-audit discipline exists to prevent.

## Consequences

- The false-green invariant test suite must include a pnpm-workspace fixture from day one — this is not an
  optional edge case, it deleted 11% of a real repo's graph silently.
- `DependencyGraph.edges[].kind` includes `type-only`; `arch.no-cycles`'s evaluator, not the scanner, owns
  the exclude-by-default behavior — the graph stays a complete, rule-agnostic fact base.
- Asset/build-output/fixture categorization work happens in the uncertainty classifier, not in new scan
  logic — keeps the scanner itself simple and testable in isolation.

## Evidence

All figures above are cited inline from `spike/SPIKE_REPORT.md` §Q1, §Q2, and the Probe 3/4/5 extension
section; see especially the "Recommendations for the v1 re-audit" list (items 1–9) and the n8n uncertainty
decomposition table (probe 4).

## Amendment (Stage 5, 2026-07-12): external-package retention + .mjs/.cjs/.mts/.cts scan coverage

**External-package retention.** Three independent demand signals converged on the same gap:
`docs/proposals/rule-expansion-evaluation.md`'s correction #2 (the scanner resolved and classified
every external specifier, then discarded it — `scanner.ts:228`, `case 'external': return;`); the
`custom.host` "`no-child-process-outside-git-rails` is inexpressible" finding logged while dogfooding
align's own predicates; and an earlier coordinator misstatement the evaluation doc corrects (assuming
external edges were already tracked). `DependencyGraph` gains `externalNodes`/`externalEdges`
(name-level, `docs/core-interfaces.md`'s "Dependency graph" section has the full shape) — a **separate**
pair of arrays from `nodes`/`edges`, not merged in, so every `arch.*` evaluator (no-dependency,
no-cycles, layers, metric) is unaffected by construction; `custom.host` predicates gain visibility via
`ctx.graph`. Regression-verified: rule counts on kluster (1 rule, 0 violations) and n8n (207 cycles) are
byte-identical before and after this change, both scanning the real repos read-only. Memory: a per-scan
string-intern table bounds retained memory by distinct-package count — n8n retains 3,742 external edges
across only 41 distinct external nodes; peak RSS and wall time measured flat within run-to-run noise
(no regression) at both kluster (~1,800 files) and n8n (3.2M LOC) scale. Uncertainty vocabulary is
unaffected: a specifier that already resolved to `'external'` was never on the `unresolved` path, so
only the discard behavior changed, not the classification. No new first-class rule kind was added —
`arch.external-imports` (docs/proposals/rule-expansion-evaluation.md §B.3.1) stays in reserve; this
amendment is infrastructure a `custom.host` predicate can use today, and gives that rule kind's future
promotion case a working expression path to gather evidence from.

**Scanner extension coverage.** `SOURCE_EXTENSIONS` grows from `.ts`/`.tsx`/`.js`/`.jsx` to also include
`.mjs`/`.cjs`/`.mts`/`.cts` — same lexical grammar, parsed identically by
`ts.createSourceFile`/`ts.resolveModuleName` (NodeNext already understands the extension-specific
resolution rules, e.g. a `.mts` file importing `'./foo.mjs'` resolves to `./foo.mts` source). Evidence:
kluster has 43 real `.mjs` + 9 `.cjs` files that were invisible to the scanner before this change
(a live-session polish note); n8n has 230 `.mjs` + 6 `.cjs` + 9 `.mts` (0 `.cts` — still supported, just
unexercised by either validation repo so far, noted rather than assumed). Measured graph delta on n8n:
17,714 → 17,959 files (+245, exactly matching the four extensions' file counts), 61,483 → 61,587 edges
(+104 from those files' own internal imports); on kluster: 1,758 → 1,809 files (+51), 8,343 → 8,381
edges (+38). `arch.no-cycles` violation counts on both repos are unchanged by the added files (0 on
kluster, 207 on n8n) — confirmed no rule regressions.
