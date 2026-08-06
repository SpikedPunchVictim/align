# Bug-Hunt Fix Plan — align (2026-07-27)

Dependency-ordered, phased plan derived from `2026-07-27-bug-hunt-full.md`. Phases group by subsystem + ships-with sets; each phase ends with `npm run build && npm run test` green before the next. Effort: trivial (<15 min) · low (~30 min) · medium (~1–2 h) · design (needs a decision first). Almost everything is pre-existing code — none blocks the current PR.

---

## Phase 1 — Silent-correctness fixes (false green/red/negative + crash). Independent, cheap, highest ROI.

1. **#2 — Collapse the excludes glob onto core `globMatch`.** `plugin-typescript/src/scanner.ts` + `doctor.ts`.
   - Delete `globLikeMatch`; match excludes via core's `expandBraces`+`globMatch`. Normalize a trailing slash on both the pattern and the directory-prefix comparison. Route `excludes` through `lintGlobPattern` at config load (loud validation like selectors).
   - Tests: exclude patterns `dist-bundle/`, `**/*.{spec,test}.ts`, `a/**/b`, `my folder/**` each match/don't-match correctly; an invalid exclude errors at load.
   - Effort: low. Ships-with: none. *(Collapses two divergent glob dialects into one — the root of #2.)*

2. **#3 — `readBaseline` must not swallow corruption.** `cli/src/align-dir.ts`.
   - Throw (or surface a `baseline-corrupt` advisory that forces red/error) on a parse/shape failure, mirroring `readRulesetIr`. Make `writeBaseline` atomic (temp file + `rename`).
   - Tests: a truncated/invalid `baseline.json` → advisory/non-green, never a silent `[]`; a valid one still loads.
   - Effort: low.

3. **#4 — Resolver candidate extensions from `SOURCE_EXTENSIONS`.** `plugin-typescript/src/workspace.ts`.
   - Derive `OWN_ENTRY_CANDIDATES` and the subpath candidate list from the scanner's `SOURCE_EXTENSIONS`; add `src/<subpath>.<ext>` / `src/<subpath>/index.<ext>` variants for all extensions.
   - Tests: a cross-package import to a `.mjs`/`.cjs`/`.mts` workspace file resolves to an edge (not `uncertain`) with no `node_modules`.
   - Effort: low.

4. **#5 — Guard empty search in the apply engine.** `core/src/fix/apply.ts`.
   - `if (search.length === 0) return [];` (or throw a descriptive error) at the top of `findAllOccurrences` — defense-in-depth, independent of the zod schema.
   - Tests: `applyEditsToFile` with `{search:'', replace:'X'}` returns cleanly (no hang/crash).
   - Effort: trivial.

## Phase 2 — Agent-loop robustness. One subsystem (`packages/agent`), ship together.

5. **#7 — Revert the commit on the VERIFY-error path.** `agent/src/run.ts:200-201`.
   - `await effects.git.revertCommit(sha);` before the escalation return, mirroring the still-red path at `:212`.
   - Tests: a mid-group VERIFY that returns `verdict:'error'` leaves no commit on the work branch.
   - Effort: trivial.

6. **#8 — Refuse on detached HEAD.** `agent/src/run.ts` (+ `cli/commands/agent.ts`).
   - In `runAgentLoop`, refuse (beside the dirty-worktree check) when `currentBranch()` returns literal `"HEAD"`. (Optional follow-up: give `ffMergeAndDeleteBranch` a Result type like its siblings — interface change, defer.)
   - Tests: detached-HEAD → `refused`, no git mutation.
   - Effort: low.

7. **#11 — Coverage guard over all `touchedPaths`.** `agent/src/run.ts:178-196`.
   - When `!allowUntested`, after computing `touchedPaths`, re-run `isFileCovered` per path; escalate (no write) if any uncovered, mirroring the symbol-removal revert-then-escalate at `:189`.
   - Tests: a multi-file proposal touching an uncovered collateral file escalates without committing.
   - Effort: low.

## Phase 3 — MCP / IR input validation. Shared `server.ts` + `ir.ts` surface — one pass.

8. **#12 — Clamp MCP `cursor`.** `core/src/payload/builder.ts` + `cli/src/mcp/server.ts`.
   - `Math.max(0, parsed)` in `buildMcpCheckPayload`; `cursor: z.string().regex(/^\d+$/).optional()` in the tool schema.
   - Tests: `cursor:'-1'` → first page (or empty), never a tail slice.
9. **#14 — `sourceLineRange` order + positivity.** `core/src/types/ir.ts` + `cli/src/mcp/server.ts:119`.
   - `.refine(r => r.endLine >= r.startLine)`; add `.min(1)` + the same refine to the MCP `proposalInputSchema.sourceLineRange`.
   - Tests: a backwards/zero range is rejected at parse.
10. **R2 — `ruleId` min length.** `core/src/types/ir.ts:53` → `z.string().min(1)` (defense-in-depth, same file).
    - Effort (8–10): trivial, one shared schema pass.

## Phase 4 — DX / authoring quality. Lower urgency.

11. **#13 — Clean config-error output + fix the over-claiming comment.** `cli/src/config.ts` + `index.ts`.
    - Correct the `readStringArrayExport` doc comment (it wrongly says `check` reports cleanly). Add a `ConfigError` type that `index.ts` renders without a stack trace — also fixes the pre-existing "any config error raw-traces" gap for check/build/baseline/agent/export-ir.
    - Tests: `align check` on a malformed `excludes`/`compositionRoots` prints a clean one-line error, exit 1.
    - Effort: low.
12. **#10 — Oxford-comma tolerance.** `core/src/build/tier2.ts:34-39`.
    - Strip a leading `and `/`or ` from each token after the split.
    - Tests: `"a may only depend on b, c, and d"` grounds to `[b,c,d]`.
    - Effort: low.
13. **#6 — Tarjan: always return a closing cycle.** `core/src/rules/tarjan.ts:74-102`.
    - On dead-end, search for any back-edge into the `seen` set (not only a direct edge to `scc[0]`) so the chain is a true elementary cycle before deriving `suggestedBreakEdge`.
    - Tests: the SCC `{A:[],B:[A,C,E],C:[B],D:[A,B],E:[A,B,C,D]}` (seed-55 case) yields a closing chain whose break edge actually breaks a cycle.
    - Effort: medium.

## Phase 5 — Design-work items (need a decision before code). Draft each as a mini-proposal.

14. **#1 + F2 — Unambiguous, domain-scoped `applyMoves`.** `core/src/baseline/store.ts` + `orchestrator.ts`.
    - **Decision needed:** transfer only when a content-key group is an unambiguous 1:1 pairing (else leave as new — never guess), AND scope `orphaned` to the domain being reconciled. Step-6 check-3: no stored-baseline migration (entries re-match each run), but prove the change can only *reduce* suppression. **HIGH consequence (false-negative) — do this design work first.**
15. **F1 — Memoize `inferSurface`.** `core/src/surface/inferSurface.ts`.
    - **Decision needed:** cache per-file symbol resolution while preserving per-path `reachableVia`/confidence-degradation semantics the tests assert. Library-only (no CLI caller) → lower urgency.
16. **#9 — `external()` in doc-authoring.** `core/src/build/schema.ts` + `ground.ts`.
    - **Product call:** widen `RuleFragment.to`/`canDependOn` to the `ComponentRef | ExternalSelector` union + pass externals through ungrounded, OR document the v1 limitation with a clear error.
17. **R1 — `passCount` definition.** `core/src/orchestrator.ts:172-174,245-247`.
    - **Owner ruling:** is a baseline-tolerated (green) rule a "pass"? If yes (the `host-rules.ts:12` comment leans this way), compute `rulesWithNoViolations` from `newViolations`. Pure derived field, no persistence impact.

---

### Suggested execution order
Phase 1 → 2 → 3 → 4 deliver 13 verified fixes with clean tests and no cross-dependencies (each phase independently shippable). Phase 5 is gated on the four decisions above; **#1 (applyMoves) is the highest-consequence item overall** and should get its design pass first even though it lands last in code.
