# align — Implementation Plan

Architecture-conformance + code-quality verification tool that LLM agents loop against until green.
Fluent TS DSL → portable JSON IR → language plugins execute checks → unified violations → oracle surfaces (CLI + MCP) → optional built-in fix agent.

**Guiding principles:**
- LLMs handle judgment; deterministic tools handle execution and verification (Refactorika).
- ArchUnitTS-style fluent, typesafe rule DSL.
- **Token economy in every decision**: the harness runs all gates and surfaces *only failures* to the LLM; passing results are counts, never text; payloads are prioritized, deduplicated, paginated; re-verification is impact-scoped; LLM calls are schema-constrained pure functions and memoizable.
- Incremental/caching built in from day one — and **a false-green is a severity-zero bug class**: trust in a green verdict is binary and does not degrade gracefully.
- **Day-one value requires zero DSL authoring**: `gates.format/lint/types/tests` wrap the repo's existing tool configs. The architecture DSL is the growth path, not the entry fee. (Counters the adoption-cliff risk.)
- **The architecture/best-practices markdown is a buildable intent source (`align build`, lockfile pattern)**: the doc compiles to the ruleset the way `package.json` resolves to a lockfile. Artifact is **JSON IR, not generated TS**: `.align/generated-rules.json` with per-rule provenance (`sourceFile`, `sourceLineRange`, `sourceQuote`) that `align.config.ts` imports — nothing machine-written lives inside a human-edited file, and violation output quotes the doc's own English ("Enforced by docs/architecture.md:42–45: '…'"). **Precision ladder** for doc authoring: fenced ```align blocks compile verbatim (zero LLM) → structured `- **Rule**:` bullets parse deterministically (LLM only grounds fuzzy selectors) → free prose goes through two-pass clarification. **Reproducibility**: section-hash incrementality (`--if-changed` exits on hash match; only changed sections re-proposed, memoized) + rule-level diff minimization (IR-identical rules keep their ids verbatim — a typo fix yields an empty diff). **Build gates**: default is dry-run with an impact delta ("adds 47 new violations / masks 12 baselined"); nothing writes without `--apply`, which also emits a human-reviewable audit map (`.align/last-build-report.md`: rule ↔ source sentence ↔ IR ↔ dry-run impact). CI runs `align build --verify` / `align check --frozen-rules` (doc section hashes ≠ lockfile → red). **Two-way drift**: doc changed → `doc-drift` advisory; generated rules hand-edited → divergence advisory. Doc frontmatter carries `align: { version }` so extraction logic can evolve without breaking older repos; `--fallback-manual` prints the concerns scaffold for human compilation when no LLM is reachable (the MCP path never needs an API key). Greenfield projects write the doc first and grow into the rules from day one.
- **Portability never vetoes a TS-plugin feature**: non-portable rule kinds are first-class and flagged (`ts.*` namespace, `portable: false`), not shamed into escape hatches. IR portability is discipline, not a straitjacket.
- The built-in agent loop is a **generic consumer of `CheckRun`**: new gates and rule kinds must require zero agent-side changes. (Counters the two-loops-redundancy risk.)
- **Category precedence is normative, not just a sort order**: architecture > security > types > lint > format. When rules from two categories demand incompatible states, the higher category wins and the lower rule yields (suppression, config change, or scoped exemption) — lint rules are generic heuristics; architecture rules are this project's encoded intent. Scoped precedence overrides in `align.config.ts` are the escape hatch. align never silently edits external tool configs — conflicts surface as advisories for a human to resolve.
- No implementation code until the architecture is fully nailed down (Stage 0).

**Locked decisions:**
1. TypeScript-embedded fluent DSL → portable language-neutral JSON IR executed by language plugins. IR kept (it is the cache-hash substrate, explain-rule payload, and baseline contract regardless of plugin count); IR migration machinery and `export-ir` polish deferred to Stage 5.
2. First language plugin: TypeScript/JS. Dogfooding on align itself + **external validation against kluster** (`/Users/spikedpunchvictim/projects/kluster` — real pnpm/TS monorepo with nested packages and tsconfig extends chains; read-only target).
3. Both fix-loop shapes: verification oracle (MCP + CLI) AND built-in BYOK agent loop. Stage 4 starts only after Stage 3 is validated against kluster. Inner PLAN+FIX: **raw Anthropic API pure function** (zod-constrained tool-use, memoizable), not a nested agent.
4. Wrap best-of-breed tools (prettier, eslint, tsc, eslint-plugin-security, vitest) behind adapters normalizing into a unified Violation model; own engine only for architecture rules over the dependency graph.

**Monorepo (pnpm workspaces, ESM, TS strict, vitest):**

```
packages/
├── core/               # @align/core — Violation model, RuleIR (zod), plugin contract, gate stack,
│                       #   baseline (+ move detection), content-hash cache, change impact analysis, orchestrator.
│                       #   Zero framework dependencies (zod only).
├── dsl/                # @align/dsl — fluent builder → IR serializer
├── plugin-typescript/  # @align/plugin-typescript — ts-morph dependency graph + tool adapters
├── cli/                # @align/cli — commander CLI; hosts `align mcp` (stdio MCP server)
└── agent/              # @align/agent — built-in fix loop (Stage 4)
```

Dependency direction: `dsl → core ← plugin-typescript`; `cli → {core, dsl, plugin-typescript}`; `agent → core`. Core never imports downstream — enforced by align's own rules from Stage 2 on.

**Composition root (how core calls plugins it never imports)**: core defines the interfaces; **the CLI is the composition root** — it imports concrete plugins and registers them. The orchestrator is constructed with a `PluginRegistry`:

```ts
// @align/core/plugin
interface PluginRegistry {
  getPluginForFile(file: string): LanguagePlugin;  // resolved via fileMatch globs
  getAllPlugins(): LanguagePlugin[];
}
```

**Plugin sessions (perf-critical for the agent loop)**: the plugin contract includes a long-lived session — a persistent ts-morph `Project`/program held across a check-and-fix session. When the engine applies an edit-block patch, it notifies the plugin, which updates the AST **in-memory** (`sourceFile.replaceWithText()`) instead of re-indexing the monorepo from disk — verification in milliseconds, not seconds, across loop iterations. Integrity guard: disk is the source of truth (git commits live there); the session validates content hashes on each verify and self-invalidates to a full reload on any drift — a stale in-memory AST producing a wrong verdict is a false-green variant.

**Gate model** (cheapest-first): **parse → format → lint → types → architecture → security → tests**, with **declared gate dependencies** rather than hardcoded short-circuit positions — each gate states what it requires:

- `parse` red → all downstream gates skipped (nothing is reliable on unparseable code).
- `types` red → **tests** skipped (they would re-report the same compile errors as duplicate noise) and **architecture** skipped (violations against code the agent is about to restructure for type fixes are wasted tokens).
- **Text-level gates always run**: `format`, `lint`, and `security.secrets` are type-independent — a leaked AWS key must never be masked by a type error.
- Future gates declare `dependsOn` metadata instead of re-litigating pipeline order.

```ts
type GateStatus = 'green' | 'red' | 'error' | 'skipped';
interface GateResult {
  gate: Category | 'parse';
  status: GateStatus;
  violations: Violation[];   // only if 'red' (new, post-baseline)
  baselinedCount: number;    // tolerated debt — count only, never payloads
  passCount?: number;        // e.g. tests passed — a number, never text
  errorMessage?: string;     // only if 'error' (e.g. "eslint binary not found")
  durationMs: number; cacheHits: number;
}
```

**`error` semantics**: environmental failure (tool crash, missing binary, config parse failure) — NOT a code problem. The orchestrator **halts the loop immediately and escalates to the user**; error output is never sent to the LLM (it would waste tokens "fixing" a non-existent code issue). Verdict is `green` only if ALL gates are `green`.

**Cache key — RESERVE for the MVP (probe 3 evidence)**: warm full-rescan measured at 1.37 s mean on 456K LOC / 12.9 s on 3.23M LOC — the MVP ships **rescan-on-check with zero incremental machinery**. The six-component key below is the retained promotion path, triggered when checks exceed ~10 s on the target repo class or when wrapped tool gates (lint/types) join the stack and change the economics. (All six components required when promoted):

```
(gateKind, fileContentHash, rulesetIRHash, toolVersion, configFingerprint, pluginAdapterHash)
```

- `configFingerprint` — contributed by each adapter: a strict hash of the **physical configuration files and their inheritance chains** (content hashes of `eslint.config.js`, `tsconfig.json` + everything in its `extends` chain, prettier config) plus **plugin/config package versions resolved from the lockfile** (an eslint-plugin update changes behavior with identical config files). Closes the false-green gap where an external tool config changes but no IR/version does — without per-file resolved-config API calls (`calculateConfigForFile` is a performance trap and its output is structurally unstable, causing accidental cache busts). **Module-graph tracking closes the transitive-import gap**: config files are loaded through an instrumented loader (jiti — the same loader used for `align.config.ts`), which exposes the config's full local module graph; every local file it pulls in is content-hashed into the fingerprint, while node_modules imports are covered by the lockfile component. **Predictive cache diagnostics**: the captured module graph is statically scanned for `process.env` reads — detected env vars have their *values folded into the fingerprint* (deterministic fix: `NODE_ENV`-dependent configs bust correctly, not silently). Truly dynamic load-time conditions (raw `fs.readFile`, time/CI-flag branching) emit a `cache-reliability` advisory via `align doctor` naming the config and the reason, so users are warned *before* the cache misleads them — `--no-cache` stops being the only tool.
- `pluginAdapterHash` — align's own version in release builds; hash of the plugin `dist/` in dev. Patching an adapter busts the cache automatically.
- Cache is advisory: corruption → silent full re-run (never a wrong answer); `--no-cache` escape hatch.

---

## Stage S: Kluster Spike (time-boxed, throwaway — runs BEFORE Stage 0 docs are finalized)

**Why**: after eight design rounds, the remaining uncertainty is empirical, not conceptual — no further prose review can answer what only contact with a real repo can. The spike tests the core bet (architecture rules + components + an agent + a real monorepo = value) before the architecture documents commit to anything.

**Goal**: 2–3 days, throwaway code explicitly permitted (isolated `spike/` directory; no tests required; no packages; will NOT become the foundation). Scope: syntactic per-file import scan (raw compiler API) → hardcoded components map for kluster → `no-dependency` + `no-cycles` evaluation → violations JSON → one minimal stdio MCP tool → Claude Code connected against kluster (read-only).

**Questions the spike must answer** (each answer maps to a plan adjustment at the re-audit):
1. Graph extraction wall-time and memory on kluster, cold — seconds or minutes?
2. Edge quality: how often do aliases, barrels, and dynamic imports force uncertainty in practice?
3. Does Claude Code discover and use the MCP tool unprompted, or does it just run `tsc` in bash?
4. Are arch violations + fix hints actionable enough for the agent to fix correctly?
5. Does the components model fit kluster's real layout, or does it fight it?
6. What does a realistic violation payload cost in tokens?

**Success Criteria**: a written spike report answering all six questions, followed by the **v1 re-audit** — every mechanism in this plan is marked **v1** or moved to the Design Reserve (below); Stage 0 documents are then written for the v1 set only.

**Status**: ✅ Complete — report at `spike/SPIKE_REPORT.md`; measured artifacts in `spike/out/`. Target was the writable copy `test-apps/kluster` (original untouched). Headline results: cold scan of 1,755 files / 456K LOC in **2.2 s, 136 MB peak heap** (scan-and-discard confirmed); uncertainty hit only **1.3% of files** (one true non-literal dynamic import in the whole repo); **pnpm workspace symlinks silently misclassified 898 inter-package edges (~11% of graph) as external with zero warnings** — the biggest false-green vector found, fixed via realpath classification; type-only imports are **32% of all edges**; cycle detection found **two real latent bugs** (one in shipped UI code) while all three no-dependency rules were green on the untouched repo; MCP oracle shape validated (cold check 2.3 s, warm 79 ms, red 5-rule response = 897 tokens; ~182 tokens/violation, half of it self-inflicted prose redundancy). **Live discovery test (probe 1) — COMPLETE, clean negative result**: given "are there architectural problems in this codebase?", Claude Code made **zero align calls**. It used the *mast* MCP server (which kluster's own CLAUDE.md mandates) plus 5 Explore subagents — ~363K tokens / 4.5 min. Decisive contrast: the agent used the MCP server the **project instructions told it to use** and ignored the one that was merely available — **discovery is configuration, not chance**. Therefore `align init` writing an agent-instructions block (CLAUDE.md/AGENTS.md: "run `align_check` after structural changes; red is blocking") is promoted to a **v1 adoption-critical mechanism** — tool descriptions alone lose to bash habits. Complementarity also confirmed: the 363K-token survey spotted the planted probe import (flagging it as unused/planted) but **missed both real cycles** align finds in 2.3 s / <900 tokens; conversely align cannot see the survey's DI violations, `as any` casts, or god files (some map to future metric/custom rules). align is the deterministic, repeatable loop anchor — not a survey replacement. Secondary finding: align's tools surfaced as *deferred* tools in the session — tool descriptions must carry searchable capability keywords for deferred-loading harnesses. **Fix-loop test (probe 2) — COMPLETE. Actionability confirmed; a v1 hard requirement discovered.**
- **The agent fixed all three violations correctly from tool payloads alone**: removed the probe import; broke the mock-idp barrel cycle by extracting shared crypto helpers to a new module; broke the `root-layout ↔ project-sidebar` cycle by extracting the nav-tab constants — the *exact* fix the spike report predicted as correct — with backward-compatible re-exports both times. A fresh scan verifies **all 5 rules green, 0 violations**. FixHints steered correctly; the agent needed only a few greps/reads per fix (the missing `snippet`/per-edge-line data cost reads but did not block).
- **VERIFICATION FRESHNESS is a v1 hard requirement (false-verdict class, demonstrated live)**: the spike server's scan-once session cache served byte-identical stale violations after the fixes. The agent detected the staleness in ONE iteration, concluded the tool was "static/canned … not a real dependency-graph analyzer," refused to continue the loop, and advised distrusting the tool entirely. Trust in an oracle is binary — one stale verdict destroyed it permanently. The oracle must NEVER answer from state older than the code it judges: rescan-on-check (probe 3 proved it costs ~1.4 s) or content-hash invalidation, no exceptions. Poetic convergence: the cache that probe 3 proved *unnecessary*, probe 2 proved *actively harmful*. (Spike server fixed accordingly: fresh scan per check.)
- **Agent-behavior bonus finding**: the agent independently verified its own fixes via grep and refused to burn edits against a broken feedback signal — external agents cross-check oracles, which raises the trust bar further and validates the plan's escalate-don't-force doctrine.

**Stage S is now fully complete** — all six questions plus both live probes answered with evidence. The v1 re-audit outcomes are folded into the stages and Design Reserve below.

**Extension probes (3/5/4) — also complete** (dated section in `spike/SPIKE_REPORT.md`): warm full-rescan is **1.37 s mean** (faster than cold; RSS stable) → **the MVP needs no incremental machinery at all**, promotion trigger empirically ~13 s/check at 3.2M-LOC class; type-only edges excluded from cycle default confirmed correct (adds only 2 benign type-loops); inferred starter rules → **~3 layer macros, not 49 pairwise rules** (87.5% of component pairs are zero-edge; seeded baseline for inferred dep-rules = 0); payload redundancy measured at **3.6x, not 2x** (182 → 51 tokens/violation structured-only; 200 violations = 10.2K tokens); **n8n (n=2): 3.23M LOC in 12.9 s / 231 MB**, auto-derived workspace components mapped 100% of files zero-config, **207 real runtime cycles found** (baseline machinery is v1-critical), and a new v1 mechanism emerged: **workspace-name resolver fallback** (resolve workspace specifiers from pnpm-workspace.yaml without installed node_modules — kills install-as-prerequisite; 54% of n8n's no-install "uncertainty" was exactly this).

---

## Stage 0: Architecture Finalization (docs only — for the post-re-audit v1 set)

**Goal**: Fully specified architecture, signed off before any implementation code. Deliverables:
- `ARCHITECTURE.md` — system design, component diagram, data flow.
- `docs/adr/` — ADRs for: DSL→IR contract & versioning; token-economy payload rules (what may/may not appear in an LLM-facing payload, per-surface budgets, priority ordering, dedup); the six-component cache key + false-green invariants; plugin contract; change-impact-analysis algorithm (transitive closure over reverse dependency edges); LLM pure-function I/O (zod `FixProposal` edit-block schema + the deterministic apply pipeline: validate-all-against-original, exact-match, ambiguity/overlap guards, engine-side bottom-up application, atomic per file); **rule-suggestion contract** (doc→RuleIR pure function + the deterministic validate→ground→dry-run→render pipeline shared by MCP and CLI surfaces); **rules-build contract** (`align build` lockfile pattern: section hashing, `.align/rules.lock.json` + `generated-rules.json` schemas incl. provenance meta (`sourceFile`/`sourceLineRange`/`sourceQuote`), precision ladder, impact-delta build gates, `--frozen-rules` CI semantics, two-way drift advisories, doc frontmatter versioning); **DSL authoring contract** (`defineProject` generic `ComponentContext<T>` typing, `ComponentToken`, reserved-name type guards, negation-free vocabulary table, `.because()` → IR hoisting, intent-template macro expansion); **rule-conflict doctrine** (normative category precedence, known-overlap registry of IR-kind ↔ eslint-rule pairs, load-time masking of lower-priority overlapping rules, `config-conflict` advisories, agent-loop oscillation detection); gate `error` semantics + **declared gate dependencies** (`dependsOn` metadata, text-level always-run carve-outs); terminal merge strategy.
- `docs/ir-schema.md` — IR JSON Schema draft (all rule kinds: `arch.*`, `lint.tool`, `format.tool`, `types.tool`, `tests.tool`, `security.secrets`, `security.tool`, flagged non-portable `ts.*` namespace, `custom.host`).
- Full TypeScript interface signatures for `@align/core` (Violation incl. `snippet`, LanguagePlugin + session contract, PluginRegistry, CheckContext, DependencyGraph incl. `type-only` edge kind + uncertainty markers, ComponentRef selectors / components registry, GateResult/GateStatus, CheckRun incl. `advisories`, BaselineStore (ruleId as queryable field), CacheStore, ConflictStore (learned shape-2 pairs), computeImpactScope + Conservative Graph Mode, ValidatedEdit + apply pipeline with locality-constrained fallback).

**Success Criteria**: User reviews and approves all documents; every later stage implements against them without re-litigating design. ADRs are written **only for mechanisms marked v1 at the post-spike re-audit** — Design Reserve mechanisms get a one-line pointer, not an ADR, until promoted.

**Tests**: N/A (documents). Review checklist: each ADR states decision, alternatives, trade-offs, and cites spike evidence where measured; IR schema covers the v1 rule kinds; token-economy ADR enumerates the normative payload rules with measured numbers.

**Status**: ✅ Complete — user signed off 2026-07-11. Deliverables: ARCHITECTURE.md, docs/adr/001–012, docs/ir-schema.md, docs/core-interfaces.md; scoped to the evidence-backed **arch-first v1** (no tool wrapping in v1 — live-test evidence; gate stack documented as the growth contract). Sign-off decisions: (1) **3 packages** for v1 (`@align/core` hosting the DSL at `@align/core/dsl`, `@align/plugin-typescript`, `@align/cli` hosting `align mcp`) — approved; (2) `dependsOn` stays on `GateResult` for now, evolve when necessary; (3) **`arch.naming` + `arch.metric` demoted to reserve-pending-evidence** (not spike-exercised) — v1 rule kinds are `arch.no-dependency`, `arch.no-cycles`, `arch.layers`, `custom.host`.

---

## Stage 1: v1 Walking Skeleton — the architecture oracle (restaged at Stage 0 sign-off)

**Goal**: Implement ARCHITECTURE.md's v1 in production quality — 3 packages (`@align/core` hosting `@align/core/dsl`, `@align/plugin-typescript`, `@align/cli` hosting `align mcp`). Port the spike's *proven* scanner into `plugin-typescript` per ADR 004 (realpath classification, workspace-name resolver fallback, type-only edges, nearest-tsconfig, asset/build-output vocabulary); components registry + typed DSL per ADRs 002/003 (`defineProject<T>`, negation-free verbs, `.because()`, layer macros); rule kinds **no-dependency / no-cycles (per-edge chain detail) / layers**; gates **parse + architecture** with `GateStatus` incl. `error` (ADR 008); baseline per ADR 006 (snippet-hash fingerprints, move detection, `accept --rule`, consent doctrine); **freshness per ADR 005** (rescan-on-check, no caching); CLI `init` / `check --json` / `baseline` / `explain` + `align mcp` (`align_check`, `align_violations`, `align_explain_rule`) with ADR 007 structured-only payloads; `init` performs components auto-detection, generates cycles-first starter rules (~3 layer macros), consent-aware baseline seeding, and writes the **CLAUDE.md agent-instructions block** (ADR 009).

**Success Criteria**: `align.config.ts` enforces align's own package dependency direction + cycle-freedom and `align check` is green on itself (dogfood); a seeded forbidden import in a fixture → red with exact file/line/specifier; fixing it → fresh green with no server restart (freshness); the pnpm-workspace false-green fixture proves inter-package edges exist; kluster copy: `init` → consent-seeded baseline → green; n8n: `init` + baseline accept (207 cycles) → green; a red 3-violation MCP response stays ≤ ~1K tokens.

**Tests**: unit — fingerprint stability, baseline move-detection, DSL→IR golden snapshots, Tarjan (self-loops, multi-node SCCs), realpath classification, workspace-name fallback, empty-selector-fails, reserved-component-name type guards (expect-type); integration — fixtures (clean / probe-violation / cycle / pnpm-workspace / orphaned-package); MCP contract tests via in-process SDK client (shapes, caps, pagination, priority sort); CLI smoke (exit codes, `--json` shape).

**Status**: ✅ Complete — verified 2026-07-11. 4 incremental commits; **78 tests passing** (core 51, plugin-ts 10, cli 17 incl. 6 MCP contract tests), all packages typecheck clean; dogfood `pnpm check` **green** on align itself; kluster copy green in 2.5 s (uncertainty matches spike exactly: 32/23); n8n init seeded **exactly 207 cycles** → green in 13.3 s; 3-violation MCP payload ≈ 465 tokens (budget ≤1K). Five documented deviations from core-interfaces.md, four accepted; **open item for Stage 2: baseline move detection not implemented** (v1 fingerprints include file identity → renames orphan baseline entries; ADR 006's move-transfer design should be implemented or the ADR amended).

## Stage 2: External validation + explain polish

**Goal**: Rerun both live probes against real v1 — Claude Code discovers align via the init-written CLAUDE.md block and drives the kluster copy red→green with no staleness; Mermaid cycle/path diagrams in `align_explain_rule`; advisories surfaced (dead aliases, uncertainty vocabulary); `align doctor` basics.

**Success Criteria**: probe-1 rerun → `align_check` called unprompted; probe-2 rerun → loop converges green in ≤2 iterations; documented clean n8n run. Also carries over Stage 1's open item: baseline move-transfer (ADR 006). **Status**: ✅ COMPLETE (probes 1+2 passed in user live session 2026-07-12) — 104 tests passing (core 60, plugin-typescript 17, cli 27, up from Stage 1's 78), all packages typecheck clean, dogfood green. Baseline move-transfer implemented (`BaselineStore.reconcileMoves`/`prune`, ruleId+snippet content fingerprint) and runs on every `align check`/MCP call, not just `baseline prune` — a renamed file's baselined violation stays green immediately, reported as an advisory ("N entries transferred (file moves)"); a genuinely new identical-snippet violation elsewhere is never swallowed. Mermaid diagrams shipped in `align_explain_rule` only (ADR 007 pull-on-demand), snapshot-tested for all three violation kinds. Uncertainty advisories now group by ADR 004 reason with per-reason file counts. `align doctor` shipped (dead-alias, uncertainty, unmapped-files, workspace-orphaned-package, empty-component advisories; always exits 0) and reproduced the spike's exact `@kluster/shared/*` dead-alias finding live against the kluster copy. `align init`'s CLAUDE.md-block append was already correct (verified against kluster's real SPECKIT-prefixed CLAUDE.md, no clobbering; regression test added) — no fix needed. Live probes: environment fully staged and validated end-to-end via a direct MCP client round-trip against the real server binary (kluster's `.mcp.json` now registers `align`; a probe cycle marked `// ALIGN STAGE2 PROBE` is seeded and red; freshness across process boundaries confirmed) — the actual `claude -p` headless probes could not run in this environment (`Credit balance is too low` on both attempts); exact reproduction commands are staged in `spike/out/stage2-probe{1,2}.txt`. n8n untouched (read-only `align check` only, still green with its 207-cycle baseline).

**Probe 1 rerun (user live session, 2026-07-12): PASS.** With the init-written CLAUDE.md block in place, the agent's FIRST action on "are there architectural problems in this codebase?" was `align_check`, self-described as "the repo's designated architecture checker" — vs. the pre-block run's 0 align calls / ~363K-token survey. It found the seeded probe cycle immediately, correctly identified it as planted from its header, respected red-is-blocking semantics, and independently surfaced the uncertainty blind-spot caveat (30 unresolvable specifiers). ADR 009's discovery-is-configuration thesis confirmed end-to-end.

**Probe 2 rerun (user live session, 2026-07-12): PASS — STAGE 2 COMPLETE.** Fix → fresh `align_check` → **green in ONE iteration**, same session, zero staleness (the exact path that killed trust in the spike server now works). The agent then drove `align doctor` unprompted-quality analysis: reproduced the spike's hand-built uncertainty decomposition independently (4 build-output config-gap specifiers → recommended the build-output exclude; 24 orphaned-`fold`-tree specifiers → traced to the pnpm-workspace gap doctor flags; 2 genuinely-absent `pg-copy-streams`), plus the 31-tsconfig dead-alias cleanup finding. Two DX findings for Stage 3 polish: (1) no command enumerates per-specifier uncertainty (agent had to script against the scanner API) — add per-specifier detail to `align doctor --json`, capped; (2) no installable `align` bin (agent tried bare `align` and npx before falling back to the node path) — packaging story, Stage 5.

## Stage 3: `align build` — markdown as buildable intent source (ADR 011)

**Goal**: MCP `align_propose_rules` (two-pass clarification; the client agent judges — no API key) + CLI `align build`: precision ladder, section-hash lockfile, `generated-rules.json` with provenance, dry-run + impact-delta gates, `--apply` + audit map, `--verify`/`--frozen-rules` CI.

**Success Criteria**: per ADR 011's acceptance list (one-section reword re-proposes only that section; IR-identical re-proposal → empty diff; violations of doc-built rules quote the doc's English). Also carries Stage 2 DX finding: `align doctor --json` with capped per-specifier uncertainty detail.

**Status**: ✅ Complete — 163 tests passing (core 100, up from 60; plugin-typescript 17; cli 46, up from 27), all packages typecheck clean. `@align/core/build` (new, exported from the main `@align/core` entrypoint) implements the precision ladder tiers 1+2 as pure functions: `parseMarkdownDoc` (heading-anchored sections + stable content hashes), `extractFencedAlignBlocks` (tier 1 — a JSON `RuleFragment` is a `RuleIR` variant's structural fields minus `id`/`provenance`, both always assigned by the pipeline), `parseBulletSentence`/`extractStructuredBullets` (tier 2 — deterministic regex grammar: "must not depend on" / "no cycles" / "may only depend on"), `groundFragment` (exact-match-only component grounding; ungroundable → `FlaggedProposal`, never written), `proposeRulesFromDoc` (orchestrates + resolves same-id conflicts), `diffGeneratedRules` (rule-level diff minimization — trivial because rule ids are content-addressed, same scheme as the DSL), `computeImpactDelta`, and `mergeGeneratedRules` (the config-integration mechanism, called from the CLI's `loadConfig`, not from `defineProject`). CLI: `align build [--doc] [--apply] [--if-changed] [--verify] [--accept-new-into-baseline]` and `align check --frozen-rules` (both backed by `verifyFrozenRules`, content-hashing the doc and `generated-rules.json` against `rules.lock.json`). MCP `align_propose_rules` implements the two-pass shape verbatim: `{doc_path}` → section list + tier classification + deterministic rules + empty prose `concerns` scaffolds; `{doc_path, proposals}` → validate/ground/dry-run diff (no write); `{..., apply: true}` → writes via the same pipeline as `--apply`, gated by the same baseline-as-debt consent doctrine (`accept_new_into_baseline`). Carried Stage 2 DX item shipped: `align doctor --json` returns capped (50) per-specifier uncertainty detail alongside grouped advisories.

Dogfood: `docs/ARCHITECTURE-RULES.md` (1 fenced block + 2 bullets, plus two prose sections that correctly surface as "needs judgment") built and applied against align's own repo; `mergeGeneratedRules` merged all three generated rules onto the pre-existing DSL-authored ones (identical content-addressed ids) rather than duplicating them — `align explain` now shows the hand-authored `.because()` concatenated with the doc's own "Enforced by docs/ARCHITECTURE-RULES.md:23: '...'" quote, and a temporarily-seeded violation (reverted immediately) confirmed violation messages quote the doc verbatim. `pnpm check` stayed green throughout (~0.5s). kluster copy: a 4-rule trial doc built and applied in ~2.7s, `align check` in ~1.9s — three guessed layering constraints all turned out to already hold on kluster's real layout (0 new violations), and a divergence experiment (hand-editing `generated-rules.json`) surfaced a real bug — `align check --frozen-rules`'s exit code was correct but the printed/JSON `verdict` field still read "green" during drift, a false-green class the project treats as severity-zero; fixed so the effective verdict flips to `red` (regression test added asserting the JSON payload's `verdict` field, not just the exit code).

## Stage 4: BYOK agent loop (ADR 010 + green≠correct guards)

**Goal**: unchanged in substance from the pre-restage design: group-by-file, memoized raw-API FixProvider, edit-block apply pipeline (exact match + `nearLine`), mechanical post-format before commit, oscillation detection, git rails, terminal merge (`--pr` default), exported-symbol surface diff + zero-coverage refusal. Carries two approved Stage 3 affordances: check-output line for active generated rules + init/build-written config comment (visibility for the implicit merge).

**Status**: ✅ Complete — 240 tests passing (core 117, up from 100 — 17 new for the apply pipeline; plugin-typescript 27, up from 17 — 10 new for export-symbol extraction; new `@align/agent` package 47 passing + 1 gracefully-skipped live smoke; cli 48, up from 46 — 2 new for the carried Stage 3 affordances), all four packages typecheck clean, dogfood green (`agent` added as a fourth dogfooded component: `agent canOnlyDependOn(core)`, `cli canOnlyDependOn(core, pluginTypescript, agent)`, `core cannotDependOn` any of the three). The deterministic apply pipeline (`FixProposal`/`EditBlock` zod schema + byte-offset `ValidatedEdit` engine: exact match, `nearLine` disambiguation, atomic per-file rejection with ±3-line re-anchoring `FailureContext`, descending-offset multi-edit application) lives in `@align/core/fix` per ADR 010's explicit "engine-side, no LLM dependency" instruction — `@align/agent` supplies only the `FixProvider` boundary (`AnthropicFixProvider`, raw tool-use, default model `claude-sonnet-5` per explicit task direction to favor Sonnet-tier over the `claude-api` skill's general Opus default for a high-volume background loop), an in-memory memoizing wrapper (`hash(input) → proposal`, tested: identical input never re-invokes the provider), and a pure state-machine core (`run.ts`) driving DISCOVER → GROUP → PLAN+FIX → APPLY → VERIFY → REPAIR → ESCALATE → DONE → TERMINAL MERGE against an injected `AgentEffects` interface. Real git/gh rails (`git.ts`, no prior git library in the monorepo — net-new `execFile`-based shell-out, never a shell string) validated end-to-end against a real temp git repo (`test/e2e-git.test.ts`): dirty-worktree refusal via real `git status`, real per-group commits, real revert-on-repair, and a real local-only fast-forward terminal merge with branch deletion. Green≠correct guards both implemented and tested: exported-symbol surface diff (escalates unless `--allow-symbol-removals`) and a documented reachability-heuristic zero-coverage refusal (escalates unless `--allow-untested`, never calls the FixProvider when refusing). Oscillation detection (`fix A introduces B, fix B reintroduces A`) escalates naming both rule ids, tested via a full attempt-history fixture. `suppressions` is zod-validated per ADR 010 but dormant — any proposal using it is rejected ("no suppressible rule categories active"), tested as such and documented in `packages/agent/README.md` alongside the plainly-stated behavioral-safety-bounded-by-tests limitation. `align agent run [--max-attempts N] [--pr|--auto-merge] [--allow-untested] [--allow-symbol-removals] [--model <id>] [--dry-run]` wired into the CLI (`packages/cli/src/commands/agent.ts` is the composition root: real `TypeScriptPlugin` scanner + real git + `AnthropicFixProvider`). One live-API call was attempted (`ALIGN_LIVE_SMOKE=1`, real `ANTHROPIC_API_KEY` present in this environment) — the request reached Anthropic's servers with correct auth/model/schema and failed only on `credit balance too low` (confirms end-to-end wiring; no output could be validated). Deferred/deviated from the superseded Stage 4 text as Design Reserve, unchanged: no whitespace-fallback apply ladder, no `maxViolationsPerFile`, no impact-scoped in-loop VERIFY (VERIFY and the terminal merge both run a FULL check), no `.align/conflicts.json` learned-conflict store. `condensedSymbolTable` is component-scoped (not full-graph-reachability-scoped) — documented simplification in `packages/agent/README.md`.

## Stage 5: Growth path & reserve promotions

**Elevated first items (user-proposed 2026-07-12): `align skill` + packaging.** `align skill [--topic authoring|fixing|all] [--install]` emits the LLM authoring/fixing guide from the binary itself — reference sections (rule kinds, DSL verbs, bullet grammar) GENERATED from the live zod schema registry so the skill can never drift from the installed version (a separately-installed skill would have stranded on the naming/metric demotion). Progressive disclosure: init's CLAUDE.md block stays small and points at the command; `--install` writes `.claude/skills/align/SKILL.md` via the proven idempotent delimited-block pattern; the MCP server carries the condensed form in its native `instructions` field (zero-file path). Pairs with the packaging/bin item (both live probes tried bare `align`/npx first). Evidence base: probe 1 proved instructions-drive-behavior; the kluster ruleset exercise's DX friction log is the requirements list.

Tool-wrapping gate stack (format/lint/types/security/tests — the superseded stage designs below are the reference material, governed by ADR 008's `dependsOn` contract), caching promotion (~10 s trigger), `align watch`, DX backlog, second language plugin → `@align/plugin-api` extraction. Everything promotes on evidence. **Status**: Not Started

---

# SUPERSEDED STAGING — reference designs for the growth path (Design Reserve detail; do not implement as written)

> The stages below predate the Stage 0 sign-off of the **arch-first v1**. They are retained in full because their mechanism designs (tool adapters, six-component cache key, CIA, tests gate, etc.) are the pre-thought reference for Stage 5 promotions — but the staging itself is superseded by Stages 1–5 above.

## [Superseded] Stage 1: Walking Skeleton — cached oracle for format + lint + types, dogfooded

**Goal**: `align check` runs on align's own repo reporting green/red/error across parse/format/lint/types gates with unified Violations, baseline support, and the full six-component cache. Minimal DSL (`gates.format()/lint()/types()`). CLI: `init`, `check [--json --files --no-cache --fail-fast]`, `baseline accept|prune|show`, `fix [--category format,lint]`.

**Incremental baseline adoption** (the "new rule on a mature repo" problem — adding `arch.no-dependency` to a 2-year-old monorepo must not force global re-acceptance):
- `align baseline accept --rule <ruleId>` — accepts only violations of that rule, leaving all other reds red. The baseline store carries `ruleId` as a queryable field, not just inside the opaque fingerprint.
- `align baseline accept --since <commit>` — accepts only violations new relative to that commit (implementation: check out the old tree in a temporary worktree, compute fingerprints there, accept the set difference — an explicit human-invoked command, so the full-check cost is acceptable).

**`align init` specification** (first impression — does the heavy lifting):
1. Creates a default `align.config.ts` (if absent): tool gates wired to the repo's *existing* prettier/eslint/tsc configs — zero DSL authoring required for day-one value — plus a commented-out starter architecture ruleset inferred from workspace layout (detected packages → suggested layer/no-dependency rules).
2. Creates `.align/` (`.align/cache/`, `.align/baseline.json`).
3. **Bootstraps the baseline**: runs a full `align check`. If violations exist (legacy debt), seeds the baseline so `align check` exits 0 immediately after init — no wall of red on day one. Consent-aware: interactive mode prints a loud summary ("Seeded baseline with N pre-existing violations — run `align baseline show`") and asks; non-interactive/CI requires an explicit `--accept-existing` flag, otherwise exits red.
4. Optionally installs a git pre-commit hook (`align check --changed`).

**Bootstrap protocol** (resolves the dogfooding paradox — you can't verify your own formatting with a tool that doesn't exist yet):
1. Scaffold workspace, `git init`.
2. Manually run `pnpm exec prettier --write .` and `pnpm exec eslint --fix .` so the repo is already clean.
3. First `align check` run verifies green against the pre-cleaned repo.
4. Dogfooding begins: intentionally break formatting/types to exercise the red path and `align fix`.

**Success Criteria**:
- Clean repo → exit 0. Seeded type error → exit 1 with a correctly-shaped Violation. Renamed eslint binary → gate `error`, run halts, environmental message to user, nothing LLM-shaped emitted.
- Second identical run shows cache hits and is measurably faster; touching mtime without changing content does NOT bust the cache; **editing an eslint/prettier/tsconfig config file DOES bust the affected gate's cache** (false-green invariant).
- `align init` on a deliberately-dirty fixture exits 0 with a loud seeded-baseline summary; with `--accept-existing` absent in non-interactive mode it exits red.
- `align fix --category format` mechanically repairs a mangled file. Gate output contains zero "passing" text — counts only.

**Tests**:
- Unit: violation fingerprint stability (edits above/below a violation don't change its id); baseline diff + move-detection (same snippet in renamed file transfers the entry); cache key correctness for all six components; **false-green invariant suite** — mutate each external config kind → assert cache bust; IR zod validation; gate ordering + dependency-driven skips (parse red → all skip; types red → tests/architecture skip, text-level gates still run) + error-halt.
- Integration: fixture mini-projects (`clean`, `type-error`, `lint-error`, `unformatted`, `legacy-debt`, `broken-toolchain`) through the full orchestrator.
- CLI smoke: vitest spawning the built binary, asserting exit codes and `--json` shape.

**Status**: Not Started

---

## [Superseded] Stage 2: Architecture Engine + Full DSL + Change Impact Analysis

**Goal**: dependency graph extraction with **nearest-tsconfig discovery** — for each source file, walk up to the first `tsconfig.json`, respect `extends` chains (e.g. `tsconfig.base.json`), resolve path aliases per package (correct behavior in pnpm monorepos; resolved chain feeds `configFingerprint`). **Cycle violations carry per-edge detail** (`{from, to, specifier, line}` per chain hop, naming the suggested break edge) — the spike showed chains without edge lines force the agent to grep every file in the chain. **`align init` rule defaults lead with `no-cycles`**: on the untouched, architecturally-healthy kluster, cycle detection found two real latent bugs (one in shipped UI code) while all no-dependency rules were green — cycles are the day-one value; no-dependency rules are the regression guardrail.

**Graph extraction strategy (memory + correctness commitments — spike-validated where marked ✓)**:
- ✓ **Lightweight per-file syntactic scan**: parse → extract edges → discard the AST. Spike measured 2.2 s / 136 MB peak on 456K LOC (~800 files/s incl. module resolution); the raw compiler-API scanner (not ts-morph) is the proven implementation. Cold rescans are cheap enough that a session cache is the right optimization — persistent graph caches move to the Design Reserve. The session caches the *graph* (nodes + edges), never ASTs.
- ✓ **Scaling confirmed at n=2**: n8n (17,708 files / 3.23M LOC) scanned in 12.9 s at 231 MB peak; auto-derived workspace-package components mapped 100% of files with zero configuration on a layout nobody hand-picked.
- **Workspace-name resolver fallback (v1, new from probe 4)**: workspace package specifiers resolve from `pnpm-workspace.yaml` package inventory even when node_modules is absent — 54% of n8n's no-install "uncertainty" was uninstalled *workspace* packages, resolvable from the workspace file alone. align must not require `pnpm install` before it can see a repo's architecture.
- ✓ **pnpm realpath classification (v1 HARD requirement, false-green severity-zero class)**: in pnpm workspaces, inter-package imports resolve *through* `node_modules` symlinks — `isExternalLibraryImport`/path-substring checks silently deleted 898 edges (~11% of kluster's graph, every cross-package edge) with zero warnings. Classify by realpath'd location. The false-green test suite gains a pnpm-workspace fixture asserting inter-package edges exist.
- **Package entry → source mapping**: cross-package imports resolve to `dist/**/*.d.ts`, which are not scanned nodes — without entry-point→source mapping (or package-level graph nodes), package-boundary cycles are invisible. v1 requirement.
- ✓ **Type-only imports are edges** — spike: 32% of all edges (2,665/8,338); dropping them discards a third of the graph. Edge kinds: `import | reexport | dynamic | type-only`.
- ✓ **Nearest-tsconfig discovery**: validated against ~90 tsconfigs with extends chains (NodeNext `.js`-extension imports, per-package options) at negligible cost with per-directory caching. ADR trap: strip `include`/`files` before `parseJsonConfigFileContent` or it enumerates input files per tsconfig.
- **Uncertainty vocabulary over uncertainty machinery** (spike: 1.3% of files, ONE true non-literal dynamic import in 456K LOC): keep Conservative Graph Mode's package-scope expansion for genuinely uncertain files (negligible cost at this rate); the ≥80%-of-edges heuristic stays in the Design Reserve. What the uncertainty list actually needs: an **asset-specifier category** (`.css`/`.svg` imports are not graph uncertainty) and **configurable build-output excludes** (`.stage/`, `dist-bundle/` polluted the spike's list). Fixture/generated-tree exclusion (e.g. kluster's `sdd/apps`) is a human consent decision surfaced in `align init` — no layout heuristic can distinguish generated app snapshots from real apps. Own engine for `arch.no-dependency`, `arch.no-cycles` (Tarjan SCC), `arch.layers`, `arch.naming`, `arch.metric` (LOC, fan-in/out, instability); `computeImpactScope` + `align check --changed` (git-diff-driven); fluent `projectFiles()`/`metrics()` DSL with empty-selector-fails-by-default (`.allowEmpty()` opt-out); flagged non-portable `ts.*` rule namespace + `custom.host`; `align export-ir` (minimal); Mermaid rendering of cycles/dependency paths in arch violation explanations.

**Semantic selectors (components registry — the stable abstraction that prevents rule drift)**: a top-level `components` map in the DSL/IR defines stable names once, bound to globs **and/or workspace package names**. **Spike correction**: path prefixes are the *load-bearing* selector; package names are a complement, not the primary — kluster had 13 workspace-orphaned `@fold/*` packages in no `pnpm-workspace.yaml` glob that package-name binding would have silently missed, plus a dead alias (`@kluster/shared/*` → nonexistent directory) that trusting tsconfig paths would have turned into a phantom component. Package-name selectors are validated against the tree at load (empty-selector-fails covers this); dead aliases surface as advisories. Rules reference components, never raw globs. A directory rename is a one-line fix at the component definition; empty-selector failures point at the component, not at N scattered rules; doc-proposed rules ground against component names rather than hallucinated paths. IR gains a `ComponentRef` selector variant alongside raw glob selectors.

**Typed authoring surface (the config file is a premium type-safe SDK, never stringly-typed)**:

```ts
export default defineProject({
  components: { api: 'package:@kluster/api', core: 'packages/core/*', cli: 'packages/cli/*' },
  // context is generically typed from the component keys — c.api autocompletes;
  // renaming a component turns every broken rule into a compile error
  rules: (c) => [
    c.arch.layer(c.api).canOnlyDependOn(c.core),
    c.arch.component(c.core).isIsolated(),
    c.arch.layer(c.api).cannotDependOn(c.cli)
      .because('The API must remain headless — no presentation-layer coupling.'),
  ],
});
```

- `defineProject<T extends Record<string, string>>` with `rules: (c: ComponentContext<T>) => RuleIR[]`; component keys colliding with reserved factory names (`arch`, `metrics`, `gates`, `security`, `custom`) are **compile errors** (type-level guard) so tokens can't shadow factories. The callback is optional — zero-DSL day-one value is unchanged.
- **Negation-free vocabulary** (a named DSL design principle, tabled in the Stage 0 DSL ADR): positive, asymmetric verbs — `isIsolated()`, `canOnlyDependOn()`, `cannotDependOn()` — no double-negative chains.
- **`.because(text)`** hoists into the IR and unifies with provenance: one field feeding terminal violation output, IDE hover, `ruleExplanations` in LLM fix prompts, and (for doc-built rules) auto-populated from the `sourceQuote`.
- **Intent-level templates** — macros expanding to multiple IR rules (`c.arch.layers({ domain: [c.core], infra: [c.cli, c.agent] })`) as the primary authoring surface; primitive rules remain for precision.
- **Component tooling**: `align components init` folded into `align init` (auto-detect workspace packages → component definitions); `align components list` (resolved files, LOC, fan-in/out — a graph query). JSDoc-rich DSL gives hover docs via standard TS tooling, no editor extension required.

**Success Criteria**:
- align's own config enforces its package dependency direction and cycle-freedom; adding `import '@align/cli'` inside core turns the build red pointing at the exact import, with a Mermaid diagram of the offending path.
- Editing one file re-checks only `changedFiles ∪ impactScope`, not the whole repo.
- **External validation (kluster)**: `align init && align check` runs green (post-baseline-seed) against `/Users/spikedpunchvictim/projects/kluster` read-only — correct graph extraction across its nested packages and tsconfig extends chains, no false-positive missing-import violations, init's inferred starter rules are sane for a repo align didn't grow up with.

**Tests**: graph-extraction fixtures (aliases, re-exports, `export *` barrels, dynamic imports incl. non-literal specifiers, **type-only imports**, nested tsconfig extends); Conservative Graph Mode tests (uncertain file → package-scope expansion; ≥80%-edges scope → full check + warning); components-registry tests (rules resolve via ComponentRef; package-name binding survives a directory rename fixture; empty component fails pointing at the definition); cycle detection (self-loops, multi-node SCCs); impact-scope transitive-closure tests; each `arch.*` rule kind against fixture graphs; **plugin session tests** (in-memory `replaceWithText` update reflected in next check without disk re-index; content-hash drift → session self-invalidates to full reload); DSL→IR golden JSON snapshots; Mermaid output snapshots; scripted kluster smoke run (non-CI, documented manual step).

**Status**: Not Started

---

## [Superseded] Stage 3: MCP Server + Security + Tests Gates

**Goal**: `align mcp` (stdio, @modelcontextprotocol/sdk) with token-budgeted tools: `align_status` (incl. advisories), `align_check`, `align_violations`, `align_explain_rule` (incl. Mermaid for arch), `align_fix_hints`, `align_autofix`, `align_baseline_accept` (gated behind `allowBaselineFromMcp`, default false — agents can't self-serve amnesty), and **`align_propose_rules`** — the connected agent reads an architecture doc, does the judgment, and submits proposed RuleIR JSON; align runs the deterministic pipeline (zod-validate → ground selectors against the file tree and components registry → dry-run with pass/violation counts → render commented DSL proposals with provenance comments into `align.config.ts`). No API key needed — the client agent supplies the judgment; align supplies validation and truth.

**Two-pass Clarification Mode (rule proposal is a conversation, not a dump)**: pass 1 — **Discovery**: the LLM reads the doc and outputs a short list of *concerns* ("layer isolation", "module size", "naming consistency"), no IR yet. The human confirms or skips each. Pass 2 — **Refinement**: IR is generated only for confirmed concerns, each selector grounded (preferring component names over raw paths) with a dry-run report before anything is written. Prevents the 20-unsolicited-rules overwhelm that would make users abandon the feature; ambiguous doc statements ("the system should be modular") surface as concerns for the human to interpret, not as hallucinated rules.

**Payload discipline** (applies to `align_violations` AND `align_check` previews):
- **Priority sort before pagination/truncation**: architecture → security → types → lint → format (format lowest — mechanical `align fix` handles it silently).
- **No redundant prose in machine payloads** (measured, probe 5c: **3.6x reduction — 182 → 51 tokens/violation** structured-only; 200 violations drop from 36.8K → 10.2K tokens): machine consumers get structured fields; human-facing `message` prose is rendered *at the surface* from those fields. Token Economy ADR norm. Caps/pagination remain mandatory; the first-N-per-rule cap kept a red response under 900 tokens.
- **Dedup — types vs instances (normative rule in the Token Economy ADR: dedup may remove repetition, never targeting data)**: collapse only *structural* duplicates (one rule, one cause, many lines — e.g., a file-wide visibility rule → single context block + target lines). Discrete errors (type errors, unused identifiers) group under a single header to save tokens but **always preserve per-instance identifier, line, and `snippet`** — the LLM cannot write a search block for a symbol it was never shown. The Violation model carries a `snippet` field to make this structural.

**Learned conflict store (emergent shape-2 conflicts outgrow any static registry)**: every escalated oscillation is recorded in `.align/conflicts.json` (rule pair + file context + graph shape), committed with the repo. Once recorded, the pair is handled *preemptively* on all future runs — precedence directive injected into prompts up front, or masked after human confirmation. Reactive on first occurrence, preventive forever after; the repo accumulates its own local registry alongside the static known-overlap one.

**Config-conflict detection & masking**: known-overlap registry (`arch.no-cycles` ↔ `import/no-cycle`, `arch.no-dependency` ↔ `no-restricted-imports`/`import/no-restricted-paths`, `arch.metric.loc` ↔ `max-lines`, …). At config load, when a registry pair is active, the **lower-priority rule is programmatically masked for that run** (adapter-level `overrideConfig` / violation filtering — memory-only; align never edits external tool configs on disk, and the agent never injects inline suppressions to win a rule fight). A `config-conflict` advisory in `CheckRun.advisories` still tells the human to reconcile configs permanently. **Boundary**: masking resolves shape-1 conflicts only (redundant overlap — same concern reported twice); shape-2 conflicts (true structural opposition, e.g. layer isolation forcing duplication that a duplication lint rule punishes) cannot be masked and terminate in the agent loop's oscillation detection + escalation.

Security gate: built-in secrets scanner (AWS keys, private keys, high-entropy tokens) + eslint-plugin-security. Tests gate: vitest adapter (JSON reporter), CIA-scoped test selection, failures-only normalization (assertion + trimmed stack head; pass count is a number). **Flaky-test handling**: configurable `retries` (default 2); red only if failing consistently across all retries; pass-on-retry → gate green + a `flaky` advisory in `CheckRun.advisories`, surfaced via `align_status` for human review — never sent to the LLM as fixable.

**Success Criteria**:
- Claude Code connected to `align mcp` takes a seeded-with-violations fixture repo to green using only MCP tools.
- A passing 400-test suite contributes roughly one line to any payload; a page of mixed violations always shows arch/security items before lint noise.
- **External validation (kluster)**: MCP server against kluster; Claude Code can query status/violations/explanations with sane payload sizes on a repo with real debt. Stage 4 does not start until this criterion passes.

**Tests**: MCP tool handlers via in-process SDK client (shapes, priority ordering, dedup counts, pagination cursors, baseline-accept gating); secrets-scanner corpus (true/false positives); CIA-scoped test-selection tests; flaky-retry state tests (fail-fail-pass → green + advisory; fail×N → red).

**Status**: Not Started

---

## [Superseded] Stage 4: Built-in Agent Loop

*Prerequisite: Stage 3 kluster validation passed. The agent is a generic `CheckRun` consumer — no gate- or rule-specific agent code.*

**Goal**: `align agent run [--max-attempts N --branch --pr|--auto-merge]` implementing:

```
DISCOVER → GROUP (by FILE first, then category — one prompt per file with ALL its violations)
→ MECHFIX (plugin autofix, zero LLM tokens)
→ PLAN+FIX (raw-API pure function, memoized by input hash; max-file-size guard)
→ APPLY (mechanical format/lint on LLM output BEFORE committing; git commit per group on work branch)
→ VERIFY (changedFiles ∪ impactScope, then cheap full status)
→ REPAIR (revert + retry with failure context, max 3/group;
          OSCILLATION DETECTION: fingerprint history per file — fix A introduces B,
          fix B reintroduces A → stop immediately, escalate "conflicting rules" report
          naming both rule IDs; never burn attempts ping-ponging)
→ ESCALATE (leave branch + report; never weaken rules, auto-accept baseline, or force past red)
→ DONE (all green) → TERMINAL MERGE
```

**FixProvider contract** (zod-validated, pure function, memoizable) — **search/replace edit blocks, never full files, never line-number diffs** (token economy: a 1-line fix in a 600-line file costs edit-block tokens, not file-sized output; also eliminates truncation and mid-file hallucination risk):

```ts
// input
{ violations: Violation[]; fileContent: string; condensedSymbolTable: string[];
  ruleExplanations: string[]; previousFailure?: FailureContext }

// output
const EditBlockSchema = z.object({
  search:  z.string(),            // exact, continuous block present in the file, with 1–2 lines of
                                  // untouched context above/below to guarantee a unique match
  replace: z.string(),            // replacement code; empty string = deletion
  nearLine: z.number().optional(),      // approximate location hint — used by the engine to
                                        // disambiguate multiple matches (closest wins) and to
                                        // bound the fallback locality window; never injected
                                        // into file content (no anchor-comment mutation)
  forViolations: z.array(z.string()).optional(), // violation ids this edit addresses — gives
                                        // VERIFY per-violation attribution for sharper REPAIR
});
const FixProposalSchema = z.object({
  files: z.array(z.object({ path: z.string(), edits: z.array(EditBlockSchema).min(1) })).min(1),
  suppressions: z.array(z.object({ ruleId: z.string(), file: z.string(), line: z.number() })).optional(),
  rationale: z.string(), // short — becomes the git commit body
});
```

**Deterministic apply pipeline** (in core — the LLM proposes, the engine applies):
1. **Scan the immutable original text** to find the unique starting byte offset of every `search` block (literal string matching, character-for-character — no line numbers). Produces `ValidatedEdit { startOffset, endOffset, replacement }[]`.
2. **Reject atomically**: any block with 0 or >1 matches, or any two spans overlapping → zero edits applied to that file; the failure feeds back as `FailureContext`. Preserves pure-function memoization semantics.
3. **Sort validated edits descending by original byte offset and apply sequentially** — modifications at the end of the file never alter the coordinates of earlier text. The LLM is NOT burdened with edit ordering (unverifiable and error-prone; ordering only matters at application time, which is the engine's job).

**Multi-match disambiguation**: when a search block matches more than one location, the engine uses the edit's `nearLine` hint to pick the closest match instead of rejecting — deterministic, and avoids burning a retry on files with repeated patterns (JSX, generated code, template-heavy files).

**Match-failure recovery ladder**:
- Retries 1–2: `FailureContext` includes the surrounding context (±3 lines) of the nearest candidate region **with line numbers for the LLM's eyes only — never for the engine's search** — so the retry can re-anchor character-for-character.
- Final retry only: **whitespace-normalized fallback**, guarded by three stacked constraints (fail any → no apply, escalate):
  1. **Eligibility minimum**: only for search blocks with ≥3 lines and ≥40 non-whitespace characters — short/repetitive blocks (bare `return`, standard error handling) are never fallback-eligible, so flattened-identical-string collisions can't arise from them.
  2. **Locality window**: candidate regions are bounded to a window around the violation's known `range` (tightened by `nearLine` when present). A normalized match outside the window is rejected even if unique — distant lookalike blocks are simply not candidates.
  3. **Unique within the window** — the fallback never guesses among candidates.
  Normalization is whitespace-stripping only (never character-distance fuzzing, never reordering); the replacement is re-indented from the target file's actual indentation, a **`fuzzy-apply` advisory** is logged so a human knows the LLM struggled, and APPLY's mechanical prettier pass immediately re-normalizes the result regardless. Silent logical corruption requires beating all three constraints at once and then surviving the scoped verify.

**Prompt directives** (appended to every PLAN+FIX payload): adhere strictly to the FixProposal schema; emit only the precise chunks requiring modification; `search` must match the file exactly including whitespace/indentation/newlines; include 1–2 lines of untouched context for uniqueness.

- **Max-file-size guard** (kept, more generous threshold): output cost no longer scales with file size, but *input* still does — files over a configurable LOC/byte threshold skip PLAN+FIX and escalate ("file too large for automated fix"). (Side effect: the tool's incentives align with its own `arch.metric` LOC rule.)
- **Symbol grounding**: prompt includes importable symbols from the dependency graph + instruction to use only existing imports; tsc gate catches stragglers.
- **Precedence directive in prompts**: when a file's violations include a known-conflicting pair, PLAN+FIX states the category precedence up front ("the architecture rule wins; resolve the lint violation by suppression per project convention") so the model never tries to satisfy both.
- **Declared suppressions for shape-2 conflicts**: when a lint rule structurally opposes a higher-precedence architecture rule, the LLM may propose a minimally-scoped suppression comment (`// eslint-disable-next-line <rule>`) — never deleting the architecture-enforcing code. Abuse guards: `FixProposal` gains an optional `suppressions: { ruleId; file; line }[]` field and every suppression must be declared there; suppressions are accepted **only for lower-precedence rules in a detected conflict — never architecture, never security**; VERIFY scans applied edits for *undeclared* disable-comments and rejects the patch (the declared list is the audit trail, not a suggestion). This does not contradict shape-1 masking: redundant overlaps are masked at load time; only true structural oppositions earn a declared, audited suppression.
- **Payload guard (`maxViolationsPerFile`, default 50)**: a file exceeding the cap gets mechanical autofix first (typically clears the unused-vars/prefer-const bulk), then a re-check; if still over the cap, PLAN+FIX receives the top 50 by severity plus an explicit note: "This file has N additional violations suppressed from this prompt; consider splitting it into smaller modules" — which is also exactly what the `arch.metric` LOC rule would say. Prevents a single 400-violation file from blowing the context window.

**Terminal merge strategy** (DONE is not a dangling branch):
1. Rebase `align/fixes-<date>` onto the current target branch (e.g. `main`). **Rebase conflict → escalate, never auto-resolve** — conflict resolution is judgment on code the agent didn't write.
2. Run a final full `align check` on the rebased tip.
3. `--auto-merge`: fast-forward merge and delete the branch. `--pr` (**default** — enterprise posture): push the branch and open a draft Pull Request summarizing violations fixed (from accumulated `rationale`s), leaving final approval to a human gatekeeper.

**Safety rails**: clean git worktree required; work branch `align/fixes-<date>`; every apply is a revertable commit; LLM may not edit `align.config.ts` or `.align/`; gate `error` status halts the loop and escalates (environmental, not fixable by code).

**Behavioral preservation (green ≠ correct — stated plainly, guarded cheaply)**: no gate verifies *behavior*; an agent can satisfy every form gate by making code do less (the cleanest fix for a forbidden import is deleting the import *and the feature that used it*). v1 guards: (1) **exported-symbol surface diff** — deletions of exported symbols across a fix become escalating advisories requiring explicit consent, never silently merged; (2) **coverage refusal** — PLAN+FIX declines files with zero test coverage unless explicitly flagged (`--allow-untested`), escalating with a "write tests first" note; (3) **honest documentation** — README and every escalation report state that behavioral safety is bounded by the target repo's test suite. The tests gate is the behavioral anchor; align does not pretend otherwise.

**Git is the transaction log — there is no backup/copy-back machinery**: rollback is `git revert`/reset (object-store operations, not file copies); writes per iteration are only the handful of edited files in one group. The loop's real disk cost is tool re-reads, which CIA-scoped checks, the cache, and in-memory plugin sessions already minimize. Scoped greens never gate a merge: **the terminal merge step always runs a FULL non-scoped check on the rebased tip** — impact-scoped verification exists only inside loop iterations.

**Success Criteria**:
- Mixed-violation fixture reaches green ≤ N attempts, all revertable commits; `--pr` produces a draft PR with a violations-fixed summary; `--auto-merge` leaves target branch green with the work branch deleted.
- Format gate never causes a retry (mechanical post-format guarantees it). Identical retry state → memo hit, not an API call.
- Unfixable rule escalates cleanly; oversized file escalates with the size report; injected rebase conflict escalates without auto-resolution.
- **`align build [--doc docs/ARCHITECTURE.md] [--apply] [--if-changed] [--verify] [--fallback-manual]`** (BYOK CLI counterpart of `align_propose_rules`, reusing FixProvider infrastructure and the deterministic validate→ground→dry-run→render pipeline; subsumes the earlier `rules from-doc` — that's simply the first build, when no lockfile exists and every section is "changed"):
  - **Pipeline**: hash check (`--if-changed` exits immediately on match) → precision ladder (verbatim ```align blocks → deterministic `- **Rule**:` bullets with LLM selector-grounding → prose via two-pass clarification for *new* concerns only) → grounding guard (components registry + file tree; ungroundable selectors flagged, never silently written) → **impact delta dry-run** ("adds N new violations / masks M baselined") → explicit consent.
  - **Default is dry-run; `--apply` writes**: `.align/generated-rules.json` (IR + per-rule `sourceFile`/`sourceLineRange`/`sourceQuote` provenance; imported by `align.config.ts`), updated `.align/rules.lock.json` (section hashes ↔ rule ids), and the audit map `.align/last-build-report.md` (rule ↔ source sentence ↔ IR ↔ dry-run impact — reviewers read bullets, not artifacts). New violations prompt for explicit baseline-as-debt consent, mirroring `align init`.
  - **Churn control**: rule-level diff minimization — re-proposals are diffed against existing rules; IR-identical rules keep ids verbatim, so a prose typo produces an empty diff even when its section re-proposes.
  - **`--verify`** (≡ `align check --frozen-rules` in CI): doc section hashes ≠ lockfile → red. Two-way drift: doc changed → `doc-drift` advisory; hand-edits to the generated artifact → divergence advisory. Doc frontmatter `align: { version }` versions the extraction logic; `--fallback-manual` prints the concerns scaffold for human compilation during LLM outages. Prompt templates + doc parsers stay a lazily-imported module (LLM deps optional at runtime); a separate `@align/docs` package only if weight demands.
  - Success criteria: fixture-doc first build produces reviewed provenance-annotated rules; a violation of a doc-built rule prints the source quote and line range; rewording ONE section re-proposes only that section's rules and an IR-identical re-proposal yields an empty diff; `--verify` fails after a doc edit until rebuild; a hand-edit to `generated-rules.json` raises the divergence advisory; build without `--apply` writes nothing.

**Tests**: state machine with scripted `FakeFixProvider` (no network); FixProposal schema-mismatch bounded-retry path; **apply-pipeline suite** (unique match applies; ambiguous/zero-match/overlapping-regions reject atomically with re-anchoring FailureContext; multi-edit bottom-up offset correctness; deletion via empty replace; `nearLine` disambiguation picks the closest of multiple matches; fallback constraint suite — sub-minimum block rejected, unique-but-outside-locality-window rejected, in-window unique match applies with `fuzzy-apply` advisory); suppression audit (declared suppression for a conflicting lint rule accepted; undeclared disable-comment → patch rejected; suppression targeting arch/security → rejected); `maxViolationsPerFile` flow (autofix-first, top-N truncation note); proposal memoization; max-file-size guard; git rails (dirty-tree refusal, rollback on failed verify, rebase-conflict escalation, ff-merge + branch deletion); optional live-API smoke behind an env flag.

**Status**: Not Started

---

## [Superseded] Stage 5: Hardening & Growth Seams (rolling)

**DX backlog** (real value, deliberately deferred until the DSL has proven itself on kluster — building meta-tools for an unused authoring surface is premature abstraction; the prerequisites they need — stable rule ids, provenance, doctor infrastructure — all exist by now): `align playground` (rule REPL: resolved selectors, dry-run violations, Mermaid, no full check); `align rule create` interactive wizard; `align doctor rules` (never-fires / fires-too-often / selector-drift heuristics, component update suggestions); config linter (unused components, unreachable/redundant rules, merge/split suggestions); rule evolution assistant (LLM-suggested rule updates as the repo evolves); VS Code extension (quick-fixes like "convert glob to component", provenance display — hover docs already work via JSDoc without it).

**Goal**: `align watch` — concrete semantics: event-driven via chokidar (never polling), **500ms debounce** on saves; **fast gates on save, heavy gates on idle** — format and lint run per save; types and architecture trigger only after ~1s idle, with a dim "⏳ Types paused (typing…)" indicator. Cache-first (a content-identical or comment-only save returns near-instant green); compact single-status-line terminal UI (`✅ Format | ✅ Lint | ⏳ Types…`) that never scrolls unless there's a new violation; tests gate excluded (too heavy for keystroke cadence — separate process if wanted). **Positioning**: watch catches architectural drift and formatting in near-real-time; the IDE's TS language server owns keystroke-latency type feedback — align watch does not compete with the compiler. Also: HTML dependency-graph reports; opt-in PATH-discovered semgrep adapter; IR migration machinery + `export-ir` polish (deferred from locked decision #1); `align rules infer` (describe the current graph as rules — status-quo capture, complementing doc-based intent capture); extraction of `@align/plugin-api` when a second language plugin starts; docs site.

**Success Criteria / Tests**: defined per item when scheduled.

**Status**: Not Started

---

## Design Reserve — addressable later if needed

Eight review rounds produced designs for many failure modes we have not yet met in practice. **Nothing is deleted** — every mechanism below is fully specified in the stage text above and stays there as a pre-thought fallback, but it is **not a v1 commitment**. The post-spike re-audit makes the final v1/reserve call per item; the burden of proof is on *promotion* (a mechanism enters v1 when evidence demands it, not because it was already designed).

**Promotion log**: `arch.metric` (max-LOC) **PROMOTED from reserve 2026-07-12, user-approved** — evidence from the kluster encompassing-ruleset exercise: two confirmed 2,100+-line files (`build-worker.ts` 2,109, a route file 2,220) structurally invisible to all 19 dependency/cycle rules; the encoded standards were incomplete without it. Scope of promotion: the `loc` metric only — `fan-in`/`fan-out`/`instability` remain reserved pending their own evidence. `arch.naming` remains in reserve (the 9-file duplicated-error-UI finding is a duplication smell, not a naming case).

**Re-audit outcomes (spike + extension-probe evidence applied)**:
- **Promoted to v1** — pnpm realpath edge classification; **workspace-name resolver fallback** (resolve workspace specifiers from pnpm-workspace.yaml without installed node_modules — kills install-as-prerequisite); baseline machinery (n8n has 207 real runtime cycles — no adoption without day-one baseline); package-entry→source mapping; per-edge cycle detail; asset/bundler-domain specifier categories + configurable build-output excludes; structured-fields-only machine payloads (measured 3.6x: 182→51 tokens/violation); type-only-excluded cycle default (type-only edges stay in the graph); `align init` generates ~3 layer macros, never pairwise rule explosions.
- **Newly moved TO reserve** — **content-hash cache + impact scoping (CIA)**: warm full-rescan measured at 1.37 s mean on 456K LOC and 12.9 s on 3.23M LOC — rescan-on-check is the MVP strategy, promotion trigger ≈ when checks exceed ~10 s on the target repo class; **plugin sessions** (same evidence); Conservative Graph Mode expansion + ≥80% heuristic (15 non-literal dynamics in 3.2M LOC); persistent graph caches.
- **Confirmed keep** — nearest-tsconfig discovery (fallback never needed), type-only edges (32% of graph), scan-and-discard (OOM retired: 231 MB peak at 3.23M LOC).

Likely reserve candidates (final call at re-audit):
- Whitespace-normalized fallback ladder (`fuzzy-apply`) — start with exact match + `nearLine` only; add the ladder if real retry data shows it's needed.
- Learned conflict store (`.align/conflicts.json`) — static registry + oscillation escalation may suffice for a long time.
- Predictive cache diagnostics / env-var fingerprint folding / `align doctor` — the base fingerprint may be enough.
- `maxViolationsPerFile`, max-file-size guard thresholds — needed only once real files hit them.
- `baseline accept --since <commit>` — `--rule` may cover the practical need.
- `--auto-merge` terminal mode — `--pr` default may be the only mode anyone uses.
- Conservative Graph Mode's 80%-of-edges heuristic — keep the package-scope expansion; the heuristic waits for evidence.
- Doc frontmatter versioning, `--fallback-manual` — build-pipeline insurance that can wait for the build pipeline to exist.
- Flaky-test retry machinery — until the tests gate exists and flakes appear.
- The entire Stage 5 DX backlog (playground, wizard, doctor rules, config linter, evolution assistant, VS Code extension).
- **`tests.quality` gate (mutation testing, user-approved reserve entry 2026-07-12)**: wrap a mutation runner (Stryker-class) and normalize surviving mutants into Violations (file, line, "mutant survived: <mutation> — zero tests failed", fixHint "add a test that kills this mutant") — deterministically catches BOTH incomplete edge-case coverage and false-positive "liar tests"; the agent loop then writes the missing tests (fix→verify→mutant dies). The honest upgrade for Stage 4's reachability coverage heuristic, and the only gate class that measures the green≠correct gap rather than assuming it. The shelved CIA/impact-scoping machinery is its enabling mechanism (mutate only changed files, run only reaching tests). Promotion trigger: `tests.tool` gate exists AND a repo demonstrates align-green-while-tests-lied in practice. Near-term cheap kin: `custom.host` test-reachability rules (expressible in v1 today); static test-smell rules (assertion-free tests, leftover `.only`, mock-of-SUT) with the lint-gate promotion. NOT for spec-level completeness — no deterministic oracle exists there; at most advisory via the prose/propose_rules path, never a hard gate.

Likely v1 (the moat + the skeleton): components registry + typed DSL, arch engine (`no-dependency`, `no-cycles`, layers), impact scope, baseline (+ `--rule`), edit-block apply pipeline (exact match + `nearLine`), MCP oracle, `align build` core loop (precision ladder, dry-run gates, provenance), gate dependencies, git rails.

## Key Risks

| Risk | Mitigation |
|---|---|
| **Adoption cliff — agents never reach for align unprompted (CONFIRMED by live test: 0 align calls; agent used the CLAUDE.md-mandated MCP server instead)** | `align init` writes an agent-instructions block into CLAUDE.md/AGENTS.md (v1 adoption-critical — project instructions drive tool use, availability does not); day-one value with zero DSL authoring; searchable capability keywords in tool descriptions for deferred-loading harnesses; cycles-first defaults (survey agents missed both real cycles align catches) |
| **Stale verdict destroys oracle trust (DEMONSTRATED live in probe 2: one stale response → agent concluded the tool was fake and permanently distrusted it)** | Verification freshness is a v1 hard requirement: the oracle never answers from state older than the code it judges — rescan-on-check (~1.4 s measured) in the MVP; any future caching requires content-hash invalidation + the false-green invariant suite |
| **False-green from stale cache (external tool config changed)** | Six-component cache key incl. per-adapter `configFingerprint` + `pluginAdapterHash`; false-green invariant test suite; treated as severity-zero bug class |
| **Portability tax without a second plugin** | IR kept for its non-portability jobs (cache hash, explain payload, baseline contract); "portability never vetoes a TS feature" + first-class flagged `ts.*` namespace; migration machinery deferred |
| **Two fix loops, one redundant** | Agent loop is a generic `CheckRun` consumer (zero agent-side work per new gate); Stage 4 gated on Stage 3 kluster validation |
| **Green ≠ correct: agent satisfies form gates by deleting capability** | Exported-symbol surface diff with consent-gated deletions; PLAN+FIX refuses zero-coverage files unless flagged; limitation documented plainly — behavioral safety is bounded by the repo's test suite |
| **Design saturation: mechanisms outpace evidence** | Kluster spike before Stage 0 docs; v1 re-audit with promotion-on-evidence burden; Design Reserve holds pre-thought fallbacks without committing to them |
| Environmental tool failure misread as code failure | `GateStatus 'error'` halts + escalates to user; never enters LLM payloads |
| **Lint rule opposes an architecture rule → agent fix ping-pong** | Normative category precedence (arch > security > types > lint > format); known-overlap registry → lower-priority rule masked at load time (memory-only) + `config-conflict` advisory; oscillation detection escalates structural (shape-2) conflicts instead of burning attempts; precedence directive injected into conflicting-pair prompts |
| **Edit-block search fails to match (LLM whitespace drift)** | `nearLine` disambiguation for multi-matches; retries carry line-numbered ±3-line FailureContext (LLM's eyes only); final-retry whitespace-normalized fallback gated by eligibility minimums + violation-locality window + in-window uniqueness, logged as `fuzzy-apply` advisory — never character-distance fuzzing |
| **Incomplete graph → scoped verify false-greens (barrels, dynamic imports, type-only edges)** | Type-only edges mandatory; Conservative Graph Mode expands uncertain files to package scope; ≥80%-of-edges scopes promote to full check with warning; terminal merge always runs a FULL non-scoped check |
| ~~Graph extraction OOM on deep monorepos~~ **RETIRED by spike evidence** | Scan-and-discard measured at 136 MB peak / 2.2 s on 456K LOC; extrapolates safely to 10x |
| **pnpm symlinks misclassify workspace edges as external (silent false-green)** | Realpath-based classification (v1 hard requirement); pnpm-workspace fixture in the false-green invariant suite — spike caught 898 silently-dropped edges (~11% of graph) |
| **Selector drift (renames/reshuffles silently no-op rules)** | Components registry: rules reference stable component names bound to globs and/or workspace package names; empty-selector failure points at the component definition |
| **Rule-proposal overwhelm kills the from-doc feature** | Two-pass Clarification Mode: concerns first, human confirms, IR only for confirmed concerns with grounded selectors + dry-run report |
| **LLM-built rulesets are non-reproducible (build lottery)** | Lockfile pattern: section-hash incrementality + rule-level diff minimization (IR-identical rules keep ids), memoized proposals, human-reviewed build diffs + audit map, `--frozen-rules` in CI, precision ladder (verbatim blocks / deterministic bullets before prose) |
| **LLM API outage blocks ruleset rebuilds** | `--fallback-manual` prints the concerns scaffold for human compilation; MCP path needs no API key; deterministic tiers (blocks/bullets) build without any LLM |
| **A doc edit silently blows up CI with new rules** | Build gates: dry-run + impact delta by default, `--apply` + explicit baseline-as-debt consent required before any rule takes effect |
| **Stale in-memory AST (plugin session) → wrong verdict** | Disk is source of truth; session validates content hashes each verify, self-invalidates to full reload on drift |
| **Agent abuses suppression comments to silence rules** | Suppressions must be declared in `FixProposal.suppressions`, only for lower-precedence rules in a detected conflict (never arch/security); VERIFY rejects patches containing undeclared disable-comments |
| LLM hallucinates non-existent imports | Symbol-table grounding + explicit instruction; tsc gate catches stragglers |
| Flaky tests burn agent tokens | Retry-based consistency check; pass-on-retry → green + `flaky` advisory for humans, never an LLM-fixable violation |
| IR portability pressure (TS concepts leaking into IR) | Tool-category rules stay shallow; language-specific logic via flagged `ts.*` / `custom.host` |
| eslint programmatic API churn (v9 / flat config) | Pin major; all eslint contact isolated in one adapter file with its own fixtures |
| tsc program creation cost on big repos | `createIncrementalProgram` + persisted buildinfo from day one; adapter owns program lifecycle |
| semgrep is Python — breaks pure-Node story | No semgrep dependency in v1: built-in secrets scanner + eslint-plugin-security; opt-in PATH-discovered adapter in Stage 5 |
| MCP SDK drift | Thin one-file wrapper over core; contract tests via the SDK's own client |
| ts-morph memory/perf on large graphs | Import/export extraction only; `DependencyGraph` interface hides the impl |
| Violation fingerprint instability → baseline churn | Snippet-hash (not line-based) + move-detection + dedicated stability test suite |
