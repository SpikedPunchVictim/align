# Bug Hunt — align (full codebase)

**Date:** 2026-07-27 · **Scope:** full codebase (`packages/*/src`), prioritized by consequence · **Lenses:** all 9 · **Runtime context:** server / Node CLI + MCP stdio server + published library (`@spikedpunch/align-core` etc.). No browser, no DB. Code dead in *every* shipping runtime is OK; code live in the *library* runtime counts.

**Method:** 6 parallel candidate-generation passes (one per subsystem), all reading current source with full-function reads + empirical `node -e` checks against the real `dist` build. **Step-5 adversarial refutation and Step-6 fix-verification were done in the main thread** — the top findings were re-confirmed against the real modules here, and two subagent findings were refuted/downgraded (see Refutation Log).

## Guard Map (files grepped before every absence claim / confirmation)
- `packages/core/src/types/ir.ts` — zod IR schema, the constraint authority · `packages/core/src/types/branded.ts` — branded casts
- `packages/core/src/components/registry.ts` — component validation / classifyFile · `packages/core/src/components/glob.ts` — the **canonical** glob matcher
- `packages/core/src/plugin/registry.ts` — reference-validity guard · `packages/core/src/fix/schema.ts` + `build/schema.ts` — zod for edit blocks / rule fragments
- `packages/cli/src/config.ts` (sibling-export validation), `errors.ts`, `index.ts`/`program.ts` top-level catch
- Sibling implementations: `components/glob.ts` vs `plugin-typescript/{scanner,doctor}.ts` `globLikeMatch`; `packageNameFromSpecifier` (core `deep-imports.ts` vs plugin `tsconfig-resolver.ts`); `computeBaselineDebt` (check.ts / server.ts / builder.ts); the rule-kind exhaustive switches
- Tests as guards: `baseline.test.ts`, `orchestrator.test.ts`, `oscillation.test.ts`, `run.test.ts`

## Summary
**BUG: 11 · FRAGILE: 3 · REVIEW: 2 · Clean (verified): 10 · Needs-review (Suspected): 3.** No security-boundary leak (untrusted mode ADR 014 verified clean); no command injection (git rails use `execFile` arg-arrays).

---

## Issue Rating Table (most severe first)

| # | Finding | Lens | Confidence | Consequence (No Fix) | Blast Radius | Fix Effort |
|---|---|---|---|---|---|---|
| 1 | `applyMoves` transfers an orphaned baseline entry onto the *first* same-snippet violation → swallows a genuinely-new violation | 4/8 | Confirmed-emp | **False-negative** (hides what the tool exists to catch) | 1 file + baseline-semantics decision | design work |
| 2 | `globLikeMatch` is a broken 2nd glob dialect (trailing-slash, `{a,b}`, mid-`**`, literal-space) — excludes silently no-op *or* over-match | 8/9 | Confirmed-emp | **False-red or false-green**; documented ADR examples fail | 2 files (scanner+doctor) | low |
| 3 | `readBaseline` returns `[]` on a corrupt `baseline.json` (siblings throw) | 4 | Confirmed | Silent debt loss + lying `0→0` trailer; false-green after `baseline accept` | 1 file | low |
| 4 | Workspace resolver candidate exts (`.ts/.tsx/.js`) diverge from scanner's `SOURCE_EXTENSIONS` | 1/8 | Confirmed | Cross-package edge to `.mjs/.cjs/.mts/.cts/.jsx` vanishes → false-green in no-install repos | 1 file | low |
| 5 | `findAllOccurrences` infinite loop on `search === ''` → `RangeError` crash / hang | 3/6 | Confirmed-emp | Process hang → crash (engine is public API; not reachable via shipped provider) | 1 file | trivial |
| 6 | Tarjan `extractCycleChainNodes` returns a non-closing chain → `suggestedBreakEdge`/`fixHint` may not break the cycle | 3 | Confirmed-emp | Misleading remediation → wasted fix cycle (detection itself correct) | 1 file | medium |
| 7 | Agent VERIFY→`error` escalates **without reverting** the group's commit | 2/5 | Traced | Stray commit poisons the final check → blocks *all* good fixes from merging + litters work branch | 1 line | trivial |
| 8 | `align agent run --auto-merge` from detached HEAD → `branch -d` fails → uncaught crash after all work done | 7/5 | Confirmed-emp | Crash; base branch never receives fixes | 1–2 files | low (guard) |
| 9 | Doc-authoring (`build/schema.ts` `RuleFragment`) can't express `external()` (never widened for ADR 017 Part A) | 8 | Confirmed-emp | Markdown/MCP rule authoring can't express browser-safety/core-purity rules (fails safe) | 2 files | medium |
| 10 | Tier-2 bullet splitter mishandles Oxford commas → `"and X"` token | 1/8 | Confirmed-emp | Natural `A, B, and C` list silently fails to author a rule (fails safe) | 1 file | low |
| 11 | Agent zero-coverage guard checks only the group's file, not all `touchedPaths` | 1/3/4 | Traced | Untested collateral file committed in a "done" group | 1 file | low |
| 12 | MCP `cursor` accepts negative int → `slice(-n)` returns wrong page | 3 | Confirmed-emp | Wrong pagination to the calling agent | 2 files | trivial |
| 13 | Non-`doctor` commands raw-trace on a config-validation error (my `readStringArrayExport` doc comment over-claims "check reports cleanly") | 5 | Confirmed-emp | Ugly stack trace instead of a clean message | 1–2 files | low |
| 14 | `sourceLineRange` has no `endLine >= startLine` check (MCP schema even looser) | 1 | Confirmed-emp | Backwards range renders `...:100-1` (display only) | 2 files | trivial |

### Fragile
- **F1 — `inferSurface` barrel walk has no memoization** → exponential path blow-up on a diamond DAG (50 nodes/24 levels = 9.1s). Library-only (not wired into the CLI), so live in the *library* runtime, dead in the CLI runtime. Fix requires design work (memoize per-file while preserving per-path `reachableVia`).
- **F2 — `reconcileMoves` scans the whole store cross-domain** (`orchestrator.ts` calls it for security *and* architecture against one store; `applyMoves` treats every other-domain entry as orphaned each call). Same root as #1; only triggers a wrong transfer on a cross-domain `ruleId`+snippet collision (contrived). Fix folds into #1's domain-scoping.
- **F3 — `revertCommit` uses `git reset --hard sha~1`** — fails if `sha` is the repo's first commit ever (no parent). Very low likelihood (base branch would need zero prior commits).

### Review (design ruling needed, not clearly a bug)
- **R1 — `passCount` is computed from *pre*-baseline `allViolations` while gate `status` uses *post*-baseline `newViolations`** (`orchestrator.ts:172-174,245-247`). A rule whose only violations are baselined is green but excluded from `passCount`. Confirmed inconsistency; whether it's *wrong* depends on `passCount`'s undefined meaning ("fully clean rules" vs "rules the gate passes"). The `host-rules.ts:12` comment ("a rule reporting green — and even count toward passCount") leans toward the latter → would make it a bug. **Owner ruling needed on the definition**; if "green ⇒ counts," change to `newViolations`.
- **R2 — `ruleId = z.string()`** has no `.min(1)`/format unlike every other IR string field. No proven wrong-behavior path (all producers emit non-empty ids), but defense-in-depth for the "constraint authority."

---

## Fix Plan & Interactions

**Ships-with / ordering:**
- **#2 and F2/#1 are the two "same-invariant-implemented-twice" classes** — fix each by collapsing to one implementation: #2 → route excludes through core `globMatch` (delete `globLikeMatch`); #1+F2 → one domain-scoped, unambiguous-pairing `applyMoves`.
- **#1 needs an existing-data decision (Step-6 check 3):** existing `.align/baseline.json` files were written by the current ambiguous logic. The fix only changes *future* transfers (no migration of stored entries needed — entries are re-matched each run), so no data migration, but the fix must be conservative (leave ambiguous groups un-transferred → surface as new) so it never *newly* hides a violation.
- **#12 and #14 share the MCP schema surface** (`server.ts`) — tighten both in one pass (`cursor` regex + `sourceLineRange` positivity/order).
- **#5** (engine empty-search guard) is independent and trivial; do it regardless — it hardens the public `@spikedpunch/align-core` API surface.
- **#13** interacts with my own earlier commit: the `readStringArrayExport` doc comment is factually wrong today; at minimum correct the comment, ideally add a `ConfigError` type `index.ts` renders cleanly (also covers the pre-existing "any config error raw-traces" gap).

**Fixes deferred to design work (did NOT pass all 8 Step-6 checks as a one-liner):** #1 (needs a pairing/scoping policy + confirm no new false-negatives), F1 (memoization must preserve `reachableVia`-per-path semantics the tests assert), #9 (union-widen vs document-limitation is a product call).

---

## Detailed findings (mechanism + verified fix or "requires design work")

**#1 — `applyMoves` ambiguous transfer** (`packages/core/src/baseline/store.ts:112-156`). `matchIdx = candidates.findIndex(v => v.file !== entry.file)` picks the first same-`(ruleId,snippet)` violation in a *different* file, with no uniqueness/closeness check. When a rename target and an unrelated brand-new violation share the snippet (import lines are commonly duplicated), the new one can absorb the baseline entry and be silently suppressed. Re-confirmed against current `dist`: `Moved idA-orig→idZ-new; isBaselined(Z-new)=true; isBaselined(A2-real-target)=false`. **Fix (design work):** only transfer when the content-key group is an unambiguous 1:1 (or partition by domain and pair deterministically); otherwise leave all orphans/candidates untouched (surface as new — never guess). Confirm the change can only *reduce* suppression, never add it.

**#2 — `globLikeMatch` broken excludes dialect** (`plugin-typescript/src/scanner.ts:199-214`, dup `doctor.ts:35-48`). Four confirmed divergences from core `globMatch`: (a) trailing slash — `dist-bundle/` → `startsWith("dist-bundle//")` + no `*` → never matches (and ADR 004:62-63 / core-interfaces.md:267 use exactly `.stage/`, `dist-bundle/` as examples; the walk has no dotdir skip, so both fail); (b) `{a,b}` brace groups escaped as literals; (c) mid-pattern `**` requires a literal extra `/`; (d) `**`→`' '`→`.*` placeholder also rewrites *literal spaces* in the pattern (`my folder/**` matches `myXfolder/x.ts`). All verified against core `globMatch`. **Fix:** delete `globLikeMatch`; route excludes (dir + file) through core's `expandBraces`+`globMatch`, adding trailing-slash directory-prefix normalization; route `excludes` through `lintGlobPattern` for loud validation like selectors.

**#3 — `readBaseline` swallows corruption** (`cli/src/align-dir.ts:56-65`). `catch { return []; }` with no signal, vs sibling `readRulesetIr` (`:141-148`) which *throws* with a doc comment ("a corrupted artifact must never be treated as absent … the same false-green class"). A merge-conflicted/truncated `baseline.json` (writeBaseline is a single non-atomic `writeFileSync`) → all accepted debt silently lost, `baselineDebt` prints `0→0`, and a subsequent `baseline accept` re-baselines old + new together → false-green. **Fix:** throw or surface a `baseline-corrupt` advisory forcing red/error; make `writeBaseline` atomic (temp+rename).

**#4 — resolver extension gap** (`plugin-typescript/src/workspace.ts:163-186`). `OWN_ENTRY_CANDIDATES` + the subpath candidate list try only `.ts/.tsx/.js`; `SOURCE_EXTENSIONS` (scanner) is wider (`+.mjs/.cjs/.mts/.cts/.jsx`). When `ts.resolveModuleName` fails (no `node_modules`/unbuilt — the fallback's raison d'être) a cross-package import to a `.mjs` workspace file → `undefined` → `uncertain` → edge lost → false-green for edge-reading rules. **Fix:** derive both candidate lists from `SOURCE_EXTENSIONS`; add the `src/<subpath>.<ext>`/`src/<subpath>/index.<ext>` variants.

**#5 — empty-search infinite loop** (`core/src/fix/apply.ts:47-57`). `findAllOccurrences` advances by `Math.max(search.length,1)` but `indexOf('', from)` clamps to `text.length`, so `idx` sticks while `offsets.push` fires forever → `RangeError`. Gated on the shipped path by `editBlockSchema.search.min(1)` + `AnthropicFixProvider` pre-validation, but the engine is exported public API and doesn't self-enforce. **Fix:** `if (search.length === 0) return [];` (or throw) at the top of `findAllOccurrences`. *(Found independently by two subagents.)*

**#6 — tarjan non-closing chain** (`core/src/rules/tarjan.ts:74-102` → `evaluators.ts:143-181`). Greedy first-unseen walk can dead-end (a node whose only path back to start runs through `seen` nodes) and return a partial chain; `evaluators.ts` takes its last hop as `suggestedBreakEdge`/`fixHint.suggestedEdge`. Confirmed against real module: SCC `[D,E,C,B]` → chain `[D,B,C]` (non-closing), `suggestedBreakEdge B→C`, but the surviving `B→E→D→B` cycle doesn't use `B→C`. **Fix:** on dead-end, search for *any* back-edge into the `seen` set (not only a direct edge to `scc[0]`) so the returned chain is always a true elementary cycle; only then derive the break edge.

**#7 — VERIFY-error no-revert** (`agent/src/run.ts:200-201`). The `verdict==='error'` path returns escalated without `revertCommit(sha)`, unlike the still-red path (`:212`). `performTerminalMerge` runs regardless of escalation and does a **final full check** (`:237-238`) that a broken commit turns non-green → merge aborts (`final-check-red`) — so it is *not* smuggled into a PR (refuted), but it blocks every good `done`-group fix from merging and leaves a stray commit. **Fix:** `await effects.git.revertCommit(sha);` before the line-201 return, mirroring `:212`.

**#8 — detached-HEAD auto-merge crash** (`agent/src/git.ts` `ffMergeAndDeleteBranch` + `cli/commands/agent.ts` `currentBranch()` as `baseBranch`). `currentBranch()` returns literal `"HEAD"` when detached; `ffMergeAndDeleteBranch` (the one `GitEffects` method with no Result type) then hits `git branch -d <work>` which fails ("checked out"), throwing uncaught to `index.ts` (only handles `AlignCoreMissingError`). Reproduced with real git. **Fix (a, cheap):** refuse early if `currentBranch()==='HEAD'`, beside the dirty-worktree refusal. **(b, design):** give `ffMergeAndDeleteBranch` a Result type like its siblings.

**#9 — `external()` not expressible in doc-authoring** (`core/src/build/schema.ts:23-46` vs `ir.ts:64-75`). ADR 017 Part A widened `to`/`canDependOn` to `ComponentRef | ExternalSelector` in the IR + DSL, but `RuleFragment` still types them as `z.string()` and `groundFragment` only calls `groundComponentRef`. A tier-1 block with `"to":{"kind":"external",...}` → `ruleFragmentSchema` rejects (`Expected string, received object`). Fails safe. **Fix:** widen `RuleFragment.to`/`canDependOn` to the union + pass external selectors through ungrounded — or document the v1 limitation with a clear error (product call).

**#10 — Oxford-comma splitter** (`core/src/build/tier2.ts:34-39`). `/\s*,\s*|\s+and\s+|\s+or\s+/i` — the comma before "and" consumes the whitespace, leaving `"and pluginTypescript"`. Confirmed against real `dist`. Fails safe (flagged ungroundable). **Fix:** strip a leading `and `/`or ` from each token post-split.

**#11 — coverage guard scope** (`agent/src/run.ts:133-143` vs `:178-196`). Zero-coverage refusal runs once, pre-loop, against the group's single `file` — never the actual `touchedPaths`. A multi-file proposal's collateral edit to an untested file that removes no export and adds no violation is committed. **Fix:** after computing `touchedPaths`, when `!allowUntested`, re-run `isFileCovered` for each; escalate (no write) if any uncovered.

**#12 — MCP cursor** (`core/src/payload/builder.ts:68` + `server.ts:80`). `Number.parseInt(cursor,10) || 0` accepts `"-1"` → `slice(-1)`. **Fix:** `Math.max(0, parsed)` + `cursor: z.string().regex(/^\d+$/).optional()`.

**#13 — config raw-trace** (`cli/src/config.ts:56-63` + `index.ts`). Only `doctor` catches `loadConfig` throws; `check`/`export-ir`/`baseline`/`build`/`agent` raw-trace. **My `readStringArrayExport` doc comment claims "check reports a clean config error" — it does not.** **Fix:** correct the comment now; add a `ConfigError` type `index.ts` renders cleanly (also fixes the pre-existing general case).

**#14 — backwards sourceLineRange** (`core/src/types/ir.ts:41-44`; MCP `server.ts:119` even looser). No `endLine >= startLine`. Renders `...:100-1`. **Fix:** `.refine(r => r.endLine >= r.startLine)`; tighten MCP `proposalInputSchema.sourceLineRange` to match (+`.min(1)`).

---

## Already Guarded (verified clean — do not re-investigate)
- **Untrusted mode (ADR 014):** corrupt/missing `.align/ruleset-ir.json` → hard refuse (exit 1); `custom.host` in IR → hard refuse before orchestrator construction; `runUntrustedCheck` never references `loadConfig`; `--untrusted`+`--frozen-rules` rejected. No code-exec leak.
- **Command injection:** all git/gh via `execFile` arg-arrays; no `shell:true`/`exec(`/`execSync`.
- **Oscillation:** `detectOscillation` compares latest vs *every* prior fingerprint → catches n-cycles, not just 2-state.
- **`packageNameFromSpecifier`** replicas (core `deep-imports.ts` vs plugin `tsconfig-resolver.ts`) byte-identical (two agents independently confirmed).
- **External-selector guards** (`typeof x === 'string'`) consistent across all 5 rule-kind read sites — zod discriminated union makes it safe.
- **Core `glob.ts`** escapes all metachars before compiling; `lintGlobPattern` rejects unsupported syntax at load.
- **`registry.ts`** package-selector prefix check safe (`workspace.ts` guarantees trailing-slashed `dir`).
- **Fingerprint write/read** symmetric — `RepoRelativePath` normalizes `\`→`/` both sides; deterministic path sort in the scan walk.
- **`payload/{builder,mermaid}.ts`** deterministic (stable sort, escaped labels); **`computeBaselineDebt`** has exactly one shared guarded copy (no 4th).
- **`doctor` exit-0:** `findDeadAliases`/`findOrphanedPackages` guard every fs/parse call.

## Refutation Log (killed or downgraded — evidence of rigor)
- **Agent "broken commit smuggled into PR/auto-merge" → REFUTED / downgraded (#7).** `performTerminalMerge`'s final full check (`run.ts:237-238`) gates any non-green tree; the un-reverted commit blocks the merge rather than riding into it. Corrected mechanism: stray commit blocks good fixes + litters the branch.
- **`passCount` "Confirmed BUG" → downgraded to REVIEW (R1).** Mechanism confirmed, but "wrong" depends on an undefined spec for `passCount`; classified as a design ruling, not a bug.
- **Detached-HEAD "silent data loss" → REFUTED** (by the agent subagent itself): `git checkout HEAD` while on the work branch stays put, so `branch -d` *fails loudly* — a crash (#8), not silent loss.
- **`registry.ts` directory-prefix collision → REFUTED:** `dir` is always trailing-slashed (`workspace.ts:88`).

## Needs Human Review (Suspected — not traced to certainty)
- `tsconfig-resolver.ts:38` cache key `` `${dir} ${specifier}` `` (space join) — collision only with literal spaces in a specifier; essentially never happens.
- `run.ts` feeds each group the DISCOVER-time `initialViolations` snapshot (never re-scanned per group) while `buildInputForFile` re-reads fresh — a later group's prompt *could* describe stale violations if an earlier fix changes them via cross-file attribution; no concrete rule kind traced.
- `revertCommit` `reset --hard sha~1` on the repo's very first commit (F3) — very low likelihood.
