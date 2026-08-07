# Bug Hunt Report: align — full codebase

**Date:** 2026-08-03
**Scope:** Full codebase (135 non-test source files across `packages/{core,cli,plugin-typescript,agent,create-align}`). Prioritized by consequence, not size: (1) fingerprint/baseline identity — the mechanism that decides whether a violation is enforced or silently accepted; (2) component classification and glob matching — decides what is even in scope; (3) rule evaluators; (4) the scanner; (5) CLI persistence; (6) the agent's write path.
**Lenses Applied:** All 9 (Assumptions, State Machines, Boundaries, Data Lifecycle, Error Paths, Time & Concurrency, Environment Divergence, Cross-Implementation Divergence, Write/Read Asymmetry)
**Runtime context:** Server / Node CLI (`engines.node >= 20`), ESM. No browser, mobile, or desktop target. `test-apps/`, `docs/evidence/`, `node_modules/`, `dist/` treated as fixtures/vendored, not shipping code.
**Files read in full:** 18 — `core/rules/{evaluators,tarjan,external-match,host-rules,manifest-evaluators}.ts`, `core/components/{glob,registry}.ts`, `core/baseline/{store,fingerprint}.ts`, `core/{orchestrator}.ts`, `core/gates/ungoverned-edges.ts`, `core/fix/{apply,schema}.ts`, `core/types/branded.ts`, `cli/{config,align-dir}.ts`, `cli/commands/{check,baseline}.ts`, `plugin-typescript/src/{scanner,workspace}.ts`, plus targeted reads of `agent/src/run.ts` and `core/types/ir.ts`.

**Follow-up investigation (2026-08-03, same day):** an independent adversarial pass re-tested every `Traced` finding against the compiled `dist` output and settled both Needs-Review items. Net result: six findings promoted `Traced → Confirmed (empirical)`; Needs-Review #1 promoted to **BUG #9**; one statement in the original report found **wrong** and corrected in place (see BUG #9's "Correction" note); two findings understated and strengthened; one Already-Guarded evidence citation corrected. Findings are numbered stably — #9 is appended rather than renumbering #1–#8.

**Second follow-up (2026-08-03): `align init`'s agent-instruction write path.** Targeted verification of which `CLAUDE.md` `align init` updates and whether the update is safe. Additional files read in full: `cli/src/init/claude-md.ts`, `cli/src/init/config-comment.ts`, `cli/src/commands/init.ts`, `cli/src/skill/install.ts`. Result: the *target* is correct, but the marker-splicing mechanism has three defects (**BUG #10, #11, #12**) shared by two sibling writers, and command scoping is added as Needs-Review #2.

## Guard Map

Guard locations consulted during verification (Step 4.2) and refutation (Step 5.2):

- **migrations / DDL:** none — no SQL, no ORM, no migrations directory (`git ls-files | grep -Ei 'migration|\.sql$|schema\.prisma|\.dbml'` → empty). The persisted-state equivalents are `.align/baseline.json`, `.align/generated-rules.json`, `.align/ruleset-ir.json`, `.align/telemetry-state.json`.
- **schemas (zod, parse-don't-validate):** `core/src/types/ir.ts`, `core/src/fix/schema.ts`, `core/src/build/schema.ts`, `core/src/types/manifest.ts`, `core/src/telemetry/types.ts`
- **validation modules:** `core/src/components/registry.ts` (`validateSelectorSyntax`, `validateComponents`, `validateClassifiedComponents`), `core/src/rules/component-refs.ts`, `core/src/rules/host-rules.ts` (`validateHostRules`, `assertNoCustomHostRules`), `cli/src/config.ts` (`readStringArrayExport`)
- **guard/interception points:** `core/src/orchestrator.ts:119-137` (the vacuous-green guard step), `core/src/gates/advisories.ts`, `cli/src/commands/check.ts:220-226` (`persistMovedBaseline`)
- **config defaults & limits:** `core/src/types/branded.ts`, `core/src/types/ir.ts:10-12` (component-name regex), `plugin-typescript/src/scanner.ts:42-78` (`SOURCE_EXTENSIONS`, `DEFAULT_EXCLUDED_DIR_NAMES`, `ASSET_EXTENSIONS`), `core/src/gates/deep-imports.ts` (`DEFAULT_ALLOWLIST`)
- **sibling implementations (the highest-yield guard source here):** **three** glob matchers, not two as originally recorded (`core/components/glob.ts`, `plugin-typescript/scanner.ts:206`, and — missed in the original sweep, found during BUG #4's implementation — `plugin-typescript/doctor.ts:35-48`); nine `computeFingerprint` call sites across three evaluator families; three `.align/` artifact readers (`readBaseline` / `readGeneratedRules` / `readRulesetIr`); three marker-delimited block writers (`init/claude-md.ts`, `init/config-comment.ts`, `skill/install.ts`)
- **tests:** `core/test/{glob,evaluators,baseline,orchestrator,components-registry}.test.ts`, `cli/test/{check,check-false-green,untrusted,baseline-debt}.test.ts`, `agent/test/run.test.ts`

## Summary

| Status | Count |
|--------|-------|
| Bugs Found | 13 |
| Fragile Code | 2 |
| OK (Already Guarded) | 10 |
| Needs Review | 2 |
| Killed in Refutation | 8 |

All 13 bugs and both fragile findings are **Confirmed (empirical)** — every one has a reproduction against real compiled code, not a trace alone.

## Implementation Status

All work below is **uncommitted, in the working tree on branch `fix`**. Gate baseline as of the last verified run: **827 tests passing** (core 408, cli 256, agent 53 +1 skipped, plugin-typescript 64, create-align 46), typecheck clean 5/5, `align check` **green**.

| # | Status | Where |
|---|---|---|
| **#1** | ✅ **Implemented + verified** | new `core/src/baseline/schema.ts` (+ core index export); `cli/src/align-dir.ts` `readBaseline` throws; caller sweep across `commands/baseline.ts`, `commands/check.ts`, `commands/build.ts`, `mcp/server.ts`. Tests: `core/test/baseline/schema.test.ts` (10), `cli/test/baseline-corruption.test.ts` (11). Back-compat (legacy entries lacking `contentFingerprint`, unknown keys) independently re-verified. |
| **#10 / #11 / #12** | ✅ **Implemented + verified** | new `cli/src/init/marker-block.ts` (`locateBlock`, `spliceOrAppendBlock`, `assertBlockWellFormed`); `claude-md.ts` + `config-comment.ts` both use it; pre-flight validation added to `commands/init.ts` and `commands/build.ts` so a malformed file aborts before any write. Tests: `cli/test/init/{marker-block,claude-md,config-comment}.test.ts` + additions to `init.test.ts` / `build.test.ts`. |
| **#13** | ✅ **Implemented + verified** | `agent/src/git.ts` `createBranch` is idempotent with a `currentBranch()` post-condition; `cli/src/commands/agent.ts` catches. Tests: 3 in `agent/test/run.test.ts` (via `FakeGitEffects.createBranchMode`), 2 real-git in `agent/test/e2e-git.test.ts`. |
| **#2 + #4** | ✅ **Implemented + verified** | `core/src/components/glob.ts` interior `**/` → `(?:.*/)?`; `plugin-typescript/src/scanner.ts` `globLikeMatch` deleted in favour of core's `globMatch` (literal-prefix arms kept). Tests: 8-row boundary table in `core/test/glob.test.ts` (3 pre-existing assertions untouched and passing), 3 real-scan exclude tests in `plugin-typescript/test/scanner.test.ts`. **BUG #4 ships at two divergences, not three** — see Refutation Log #8. |
| **#3** | ✅ **Implemented + verified** | `core/src/rules/host-rules.ts` drops `String(range.startLine)`; author guidance added to `HostViolation`'s doc comment and mirrored in `docs/core-interfaces.md`. 3 tests in `core/test/rules/host-rules.test.ts`. Migration note lives in the commit body — this repo has no CHANGELOG and no changesets; commit-message-only is its established convention (checked against `338453c` and `6d6c9c1`). This repo's own baseline has zero `custom`-kind entries, so it needed no re-accept. |
| **#5** | ✅ **Implemented + verified** | `plugin-typescript/src/scanner.ts` counts real lines; `wc -l` divergence pinned by a comment and a test. 8 tests in `plugin-typescript/test/scanner.test.ts`. One existing assertion in `cli/test/check.test.ts` corrected (`8 lines` → `7 lines`) — the fixture visibly has 7 lines, so the old assertion had baked in the buggy value. `baseline prune` instruction is in the commit body. **Note for future checks:** this repo's `arch.metric` rule lives in doc-generated `.align/generated-rules.json`, NOT `align.config.ts` — grepping only the config would miss it. |
| **#6** | ✅ **Implemented + verified** | `core/src/fix/schema.ts` `.refine()` uniqueness on `files[].path`, with the why-reject-not-merge reasoning kept inline. 4 tests in `core/test/fix/schema.test.ts`. `safeParse` at `anthropicFixProvider.ts:194` confirmed, so rejection re-prompts the model rather than throwing. **Follow-up worth considering:** `FIX_PROPOSAL_JSON_SCHEMA` (the tool definition sent to Anthropic, `anthropicFixProvider.ts:40`) is hand-written and NOT derived from the zod schema, so the model only learns this constraint by failing once and reading the correction. A line in that JSON Schema's description would save the wasted attempt. |
| **#15** | ✅ **Implemented + verified** | `plugin-typescript/src/doctor.ts` `globLikeMatch` deleted in favour of core's `globMatch` (literal-prefix arms kept). 3 tests in `plugin-typescript/test/doctor.test.ts` via `findDeadAliases`. No existing test needed changing, so this repo's own `doctor` output is unaffected. |
| **#14** | ⬜ Not started — **Step 6 pass complete, blocked on one decision** | Catch around `loadConfig` at 7 CLI command entries (NOT MCP — the SDK already converts throws to `isError`; NOT `doctor`/`telemetry` — they handle failure deliberately). Blast radius corrected 1–2 files → 8. Blocked on: introduce a shared error helper, or add a ninth bespoke catch? 19 bespoke sites in 4 incompatible shapes exist today. |
| **#7 / #8 / #9** | 🔵 Blocked on design decisions | Not implementable as written; each needs a product call. See their sections. |
| **Needs Review 1 / 2** | 🔵 Blocked on product decisions | Root-workspace-package support; repo-scoped vs directory-scoped commands. |

## Issue Rating Table

| # | Finding | Lens | Confidence | Urgency | Risk: Fix | Risk: No Fix | ROI | Blast Radius | Fix Effort |
|---|---------|------|-----------|---------|-----------|--------------|-----|--------------|------------|
| 10 | `cli/src/init/claude-md.ts:37-47` + `config-comment.ts:37-47` — a malformed marker state (START without END) makes the next run splice from the first START to the appended END, silently deleting everything between; in `align.config.ts` that is the user's entire hand-authored ruleset | Cross-Impl / Boundaries | Confirmed (empirical) | 🔴 Critical | 🟡 High | 🔴 Critical | 🟠 Excellent | 2 files + 3 call sites | Small |
| 13 | `agent/src/run.ts:311-313` + `git.ts:39-41` — `defaultWorkBranchName` is date-only, so a second `align agent run` on the same day collides; `createBranch` rejects and nothing catches it, crashing with a raw Node stack trace | Time & Concurrency / Error Paths | Confirmed (empirical) | 🟡 High | 🟡 High | 🟡 High | 🟠 Excellent | 2 files + test double | Small |
| 1 | `cli/src/align-dir.ts:59-64` — a corrupt `baseline.json` is silently read as empty; `baseline accept`/`prune` then overwrite the file, permanently destroying every accepted entry | Cross-Impl / Error Paths | Confirmed (empirical) | 🔴 Critical | 🟡 High | 🔴 Critical | 🟠 Excellent | 6 files (core schema + align-dir + 8 call sites across 4 command/server files) | Small |
| 2 | `core/src/components/glob.ts:16-21` — `**` compiles to `.*`, crossing path-segment boundaries: `src/**/index.ts` classifies `src/notindex.ts` | Boundaries | Confirmed (empirical) | 🟡 High | 🟡 High | 🟡 High | 🟠 Excellent | 1 file + baseline churn (re-accept required) | Trivial |
| 9 | `core/src/rules/tarjan.ts:88-101` — the greedy cycle walk can strand and return a NON-CLOSED chain, which `evaluateNoCycles` renders as a cycle violation with a fingerprint over the phantom path | Boundaries / State Machines | Confirmed (empirical) | 🟡 High | 🟡 High | 🟡 High | 🟢 Good | 1 file + shared re-accept note | Small |
| 3 | `core/src/rules/host-rules.ts:165` — `custom.host` fingerprint folds in a line number, violating `fingerprint.ts:9`'s "never line numbers"; 8 of 9 sibling call sites comply | Cross-Impl | Confirmed (empirical) | 🟡 High | 🟡 High | 🟡 High | 🟠 Excellent | 1 file + one-time re-accept (no auto-transfer) | Trivial |
| 4 | `plugin-typescript/src/scanner.ts:206-214` — the exclude matcher diverges from core's dialect in 3 ways despite a comment claiming parity; a literal space in a pattern becomes a wildcard | Cross-Impl | Confirmed (empirical) | 🟡 High | 🟡 High | 🟡 High | 🟠 Excellent | 1 file + baseline churn (ships with #2) | Small |
| 7 | `core/src/baseline/store.ts:131-153` — move-transfer can silently baseline a genuinely new violation when one is fixed and an identical-snippet one appears elsewhere in the same commit | Data Lifecycle | Confirmed (empirical) | 🟡 High | 🔴 Critical | 🟡 High | 🟡 Marginal | 2 files + contract change | requires design work |
| 5 | `plugin-typescript/src/scanner.ts:228,357` — `loc` counts a phantom trailing line, so `arch.metric max: N` fires on a file of exactly N lines and reports N+1 | Boundaries | Confirmed (empirical) | 🟢 Medium | ⚪ Low | 🟢 Medium | 🟠 Excellent | 1 file (fingerprint unaffected) | Trivial |
| 6 | `agent/src/run.ts:167,180` — a `FixProposal` listing the same path twice writes both results in sequence; the first entry's edits are silently lost and the partial result is committed | Data Lifecycle | Confirmed (empirical) | 🟢 Medium | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 8 | `core/src/rules/evaluators.ts:283` — `arch.metric` fingerprint excludes the measured value, so a file baselined at `max+1` can grow without bound and stay green | Data Lifecycle | Confirmed (empirical) | 🟢 Medium | 🟡 High | 🟢 Medium | 🟡 Marginal | 1 file + full metric re-accept | requires design work |
| 14 | `cli/src/config.ts:128` — `readGeneratedRules` correctly throws on a corrupt `.align/generated-rules.json`, but `loadConfig` doesn't catch and neither does any command, so every `loadConfig`-based command dies with a raw Node stack trace | Error Paths | Confirmed (empirical) | 🟢 Medium | 🟡 High | 🟢 Medium | 🟢 Good | 8 files / 7 call sites + a shared helper | Medium |
| 11 | `cli/src/init/claude-md.ts:39` + `config-comment.ts:39` — an END marker positioned before a START marker fails the `endIdx > startIdx` guard and falls through to append, adding a fresh block on **every** run, unboundedly | Boundaries | Confirmed (empirical) | 🟢 Medium | 🟡 High | 🟢 Medium | 🟢 Good | same fix as #10 | covered by #10 |
| 12 | `cli/src/init/claude-md.ts:37-38` + `config-comment.ts:37-38` — with two complete marker pairs, `indexOf` finds the first START and the first END, so only the first block is ever refreshed and the second goes stale permanently | Boundaries | Confirmed (empirical) | ⚪ Low | 🟡 High | ⚪ Low | 🟢 Good | same fix as #10 | covered by #10 |

## Fix Plan & Interactions

**Ships-with sets** (never split across phases):

- **#10 + #11 + #12** — three symptoms of one branch condition (`startIdx !== -1 && endIdx !== -1 && endIdx > startIdx`, duplicated verbatim in `claude-md.ts:39` and `config-comment.ts:39`). One fix closes all three. Splitting them means shipping a partial marker validator, which is worse than none — it would legitimize the malformed states it doesn't reject. **Both files must change together**: fixing only `claude-md.ts` leaves the higher-consequence `align.config.ts` writer defective.
- **#2 + #4** — both change which files are in scope or which component claims them. Shipping them in separate releases means two independent waves of baseline churn for every user. One release, one migration note, one `align baseline prune && align baseline accept` instruction.

**Ordering constraints:**

- **#10 first, before everything else.** It is the only finding that destroys hand-authored source (`align.config.ts`, `CLAUDE.md`) rather than machine-regenerable state, and it fires from `align init` and `align build --apply` — two commands a user is *more* likely to run while working through the rest of this report. Fixing anything else first means asking people to run those commands with the destructive path still live.
- **#1 second.** Same reasoning one level down: #2/#4 produce the baseline churn that makes users run `baseline accept`, the exact command that triggers #1's data loss.
- **#5 before #7 is dangerous; sequence it deliberately.** Fixing `loc` resolves, in one shot, every `arch.metric` violation on files sitting at exactly `max` real lines. Each resolved violation orphans a baseline entry. With #7 unfixed, `reconcileMoves` runs on the very next `align check` and looks for a transfer target by `ruleId + snippet` — and a metric violation's snippet is just *the file's first line* (`evaluators.ts:297` ← `scanner.ts:359`). Two over-long files sharing a first line (a license header, `import * as fs from 'node:fs';`) is common. **Mitigation: ship #5 together with an instruction to run `align baseline prune` immediately, before any `align check`.** That deletes the orphans instead of letting them transfer.
- **#2/#4 only after #1 has landed** (see above — they generate the `baseline accept` traffic that #1 turns destructive).

**Shared migration / one-time user action** (write it once, in the earliest phase that needs it):

- #2, #3, #4 all invalidate existing baseline fingerprints. **One combined release note** covering all three: "`align check` may report previously-accepted violations as new after this upgrade; run `align baseline prune && align baseline accept` once." #3 specifically will *not* self-heal via move-transfer — `applyMoves` requires `matched.file !== entry.file` (`store.ts:134`), and a `custom.host` fingerprint change keeps the same file.

**Deferred to design work:**

- **#7** — every candidate fix changes ADR 006's accepted semantics and needs a product decision. Sketch below, not a patch.
- **#8** — same: any fix invalidates all existing `arch.metric` baseline entries and needs a policy call on what "accepted debt" means for a growing file.

**Interaction to note when #9 is eventually fixed:** correcting the chain changes the `no-cycles` fingerprint (`evaluators.ts:164` hashes the chain's `from>to:specifier` sequence), so any `arch.no-cycles` violation baselined off a phantom chain will orphan. Same re-accept class as #2/#3/#4 — fold it into whichever release carries it.

---

## Detailed Findings

### BUG #1 — A corrupt `.align/baseline.json` is silently read as empty, and the next `baseline accept` destroys it

**Lens:** Cross-Implementation Divergence + Error Paths
**File:** `packages/cli/src/align-dir.ts:56-65`, `packages/cli/src/commands/baseline.ts:19-21`
**Confidence:** Confirmed (empirical) — reproduced end-to-end with the real CLI; see "Reproduction" below

**Assumption:** `baseline.json` is always machine-written, therefore always valid JSON.

**Violation scenario:** `.align/baseline.json` is a committed file that multiple developers append to via `align baseline accept`. A git merge produces conflict markers (`<<<<<<< HEAD`) inside it — the single most common way this file becomes invalid JSON. Then:

1. `readBaseline` (`align-dir.ts:59-64`) catches the `JSON.parse` error and returns `[]`. No warning, no advisory, no exit code.
2. `align check` now reports every previously-accepted violation as new → CI turns red with no explanation of why.
3. A developer runs `align baseline accept` to "re-accept" them. `baselineAccept` (`baseline.ts:19-21`) builds the store from that same silent `[]`, accepts only the currently-visible violations, and calls `writeBaseline(rootDir, store.snapshot())` — a **full overwrite**.
4. Every baseline entry for a violation not visible in *this* scan (a different rule's debt, a gate that errored, a file behind a feature branch) is gone from disk permanently.

**Consequence:** Silent, unrecoverable loss of accepted-debt state — recoverable only from git history, which is exactly what the merge conflict was already disturbing.

**Guard-map evidence — this is a Lens 8 finding, not a novel risk.** The codebase has three `.align/` artifact readers, and the guard exists in two of them:

| Reader | Corrupt-input behavior | Stated doctrine |
|---|---|---|
| `readRulesetIr` (`align-dir.ts:145-149`) | **throws** | "A file that exists but fails to parse as JSON or fails schema validation throws — a corrupted or hand-mangled artifact must never be treated as 'absent' (that would silently drop rules…)" |
| `readGeneratedRules` (`align-dir.ts:88-93`) | **throws** + zod-validates | "silently dropping generated rules would be a false-green" |
| `readTelemetryState` (`align-dir.ts:~195`) | returns empty | explicitly justified: "a soft, regenerable cache… not a portable ruleset artifact" |
| **`readBaseline` (`align-dir.ts:59-64`)** | **returns `[]` silently, no schema** | **none — the divergent sibling** |

The doctrine is not just documented, it is *tested* for the IR path (`cli/test/untrusted.test.ts:175`: "refuses on a corrupted JSON artifact instead of silently treating it as absent"). `readBaseline` is unlike `readTelemetryState` in the way that matters: it is not regenerable — it holds irreplaceable human consent decisions.

**Negative-claim receipt (rule 3):** searched for a baseline schema across the guard map — `grep -rn "baselineEntrySchema|baseline.*Schema|BaselineEntry" packages/core/src/types/*.ts packages/core/src/index.ts` → **zero results**; `grep -rn "corrupt|invalid JSON|not valid JSON" packages/cli/test/*.ts` → only `untrusted.test.ts:175-182`, none for baseline. There is no zod schema for `BaselineEntry` anywhere and no corrupt-baseline test.

**Current code:**
```ts
// align-dir.ts:56-65
export function readBaseline(rootDir: string): BaselineEntry[] {
  const file = baselinePath(rootDir);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as BaselineEntry[]) : [];   // no schema; non-array → silently []
  } catch {
    return [];                                                    // corrupt → silently []
  }
}
```

**Verified fix:** mirror `readRulesetIr`'s discipline — throw on invalid JSON and on a non-array root, with a message that names the merge-conflict cause, plus a permissive zod schema.

```ts
// core/src/baseline/schema.ts (new) — the missing third sibling of fix/schema.ts and build/schema.ts
export const baselineEntrySchema = z.object({
  fingerprint: z.string().min(1),
  ruleId: z.string().min(1),
  file: z.string().min(1),
  acceptedAt: z.number(),
  acceptedBy: z.enum(['init-seed', 'accept-existing', 'manual']),
  contentFingerprint: z.string().min(1).optional(),   // MUST stay optional — see check 3
}).passthrough();                                      // MUST stay open — see check 3
export const baselineFileSchema = z.array(baselineEntrySchema);
```
```ts
// align-dir.ts
export function readBaseline(rootDir: string): BaselineEntry[] {
  const file = baselinePath(rootDir);
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
      'A corrupted baseline is never treated as empty — that would silently discard accepted ' +
      'debt, and the next `align baseline accept` would overwrite the file. Most likely cause: ' +
      'an unresolved git merge conflict. Resolve it, or restore the file from git.',
    );
  }
  // NOTE (corrected during implementation): `as BaselineEntry[]` alone does NOT compile. The
  // schema's inferred element type has plain `string` fields; `BaselineEntry` brands them
  // (`ViolationId`/`RuleId`/`RepoRelativePath`), and TS rejects the cast as insufficiently
  // overlapping. The boundary cast must route through `unknown`, matching every other
  // brand-construction site (`types/branded.ts`'s `toXxx` helpers).
  return baselineFileSchema.parse(parsed) as unknown as BaselineEntry[];
}
```

**Step 6 checklist:**
1. *Boundary arithmetic:* none introduced.
2. *Mirror path:* the write side is `writeBaseline` (`align-dir.ts:67-71`), which serializes `store.snapshot()` — always a valid `BaselineEntry[]`. The schema accepts everything that writer can emit. ✅
3. *Existing data:* **the load-bearing check.** `.align/baseline.json` files written before `contentFingerprint` existed are explicitly supported (`store.ts:12-15`: "Optional so `.align/baseline.json` files written before this field existed still parse"). The schema **must** keep `contentFingerprint` optional and **must** use `.passthrough()` — a strict schema would turn every existing repo's `align check` into a hard error on upgrade. Both are encoded above. No data migration needed. ✅
4. *Constraint values:* the authoritative shape is `BaselineEntry` at `core/src/baseline/store.ts:6-16`; the `acceptedBy` enum's three members are read from line 11, not guessed. ✅
5. *Failure modes:* throws (loud), matching the two siblings. Cannot reintroduce the silent-empty class for any input — every non-throwing path now returns a schema-validated array. ✅
6. *Interactions:* enables safe execution of the #2/#4 migration (see Fix Plan ordering). ✅
7. *Caller contract:* **changes `readBaseline` from never-throwing to throwing — 8 call sites must be checked.** Verified list: `mcp/server.ts:30`, `commands/agent.ts:51`, `commands/baseline.ts:19,39,62`, `commands/build.ts:116,253`, `commands/check.ts:79,200`. Critically, **`doctor.ts` is NOT among them** (verified by the grep above), so the "`align doctor` always exits 0" contract documented at `cli/src/config.ts:55` is not at risk. The remaining callers are all command entry points that already surface config errors as a non-zero exit; each needs a one-line confirmation that the throw reaches the command's error boundary rather than an unattributed stack trace. This is why the fix is scoped **Small, 6 files**, not a one-liner. **Corrected during implementation — the original estimate of 3 files was low.** The 8 call sites span `align-dir.ts`, `commands/baseline.ts`, `commands/check.ts` (both the trusted and `--untrusted` paths), `commands/build.ts`, and `mcp/server.ts`. Two of them the line-list did not separately flag: `writeBuildArtifacts`'s conditional `readBaseline` is reached from **two** unguarded callers (`runBuild`'s apply path and the MCP `align_propose_rules` apply branch), and each needed its own catch. The MCP sites additionally need `{ isError: true }` responses rather than a crashed tool call.
8. *Empirical re-test:* n/a for the fix itself, but **the bug is now reproduced end-to-end** — see below.

**Reproduction (follow-up pass, throwaway repo, real CLI):**

1. `align baseline accept` → 2 entries (`arch.metric:loc:ui`, `arch.no-dependency:api->ui`); `align check` → `verdict: green`.
2. Insert `<<<<<<< HEAD` / `=======` / `>>>>>>> feature-branch` markers mid-file in `.align/baseline.json`.
3. `align check` → `verdict: red`, both violations reported as new, **`baselined debt: 0 → 0`**, and **zero** warning on stdout or stderr that the file is corrupt. The silent-`[]` path at `align-dir.ts:59-64` confirmed live.
4. `align baseline accept --rule arch.metric:loc:ui` → `Accepted 1 violation(s)`. The resulting `baseline.json` contains **only** the metric entry. The `arch.no-dependency` entry (fingerprint `b26ffb86865fc059`) is gone, and the file is valid JSON again — so nothing downstream will ever flag the loss.

**Two aggravations the original trace understated:**

- **A scoped `--rule` accept is equally destructive.** The original scenario needed a violation "not visible in this scan" to lose data. It doesn't: `baselineAccept` filters `targeted` by rule (`baseline.ts:18`) but writes `store.snapshot()` unconditionally (`baseline.ts:21`), so with a silently-empty store a scoped accept persists *only that rule's* entries and drops every other rule's debt. This makes destruction routine rather than situational.
- **Consent provenance is silently rewritten even for surviving entries.** `store.accept` stamps `acceptedAt: Date.now()` and `acceptedBy: 'manual'` (`store.ts:77-86`), so an entry originally recorded as `init-seed` is re-attributed with no record of the original decision.

---

### BUG #2 — Core's `**` crosses path-segment boundaries, misclassifying files into components

**Lens:** Boundary Conditions
**File:** `packages/core/src/components/glob.ts:16-21`
**Confidence:** Confirmed (empirical)

**Assumption:** the module doc comment states the supported vocabulary as "`**` (zero or more **segments**)" and `registry.ts:6-7` repeats it verbatim in the user-facing error message. The compilation does not implement that.

**Violation scenario:** `**` compiles unconditionally to `.*`, which matches across `/`. Any component selector with an **interior** `**` therefore claims files it should not:

```
$ node glob.mjs      # verbatim copy of globToRegExp, run in the scratchpad
"src/**/index.ts"  -> /^src\/.*index\.ts$/
  vs "src/notindex.ts"  → true      ← WRONG (no segment boundary before `index.ts`)
  vs "src/a/index.ts"   → true      ← correct
"app/**/model.ts"  -> /^app\/.*model\.ts$/
  vs "app/datamodel.ts" → true      ← WRONG
"packages/**/api/**"
  vs "packages/xapi/foo.ts" → true  ← WRONG
```

**Consequence:** files land in the wrong component. Because classification is first-match-wins in declaration order (`registry.ts:37-48`), an over-broad selector *steals* files from a later component. Two downstream effects, both in the false-green family this codebase is explicitly built to prevent:
- The stolen file's edges are evaluated under the **wrong component's** rules — its real rules never see it.
- If a later component loses *every* file this way, `validateClassifiedComponents` throws (`registry.ts:174-193`) — a hard `align check` error whose message blames a stale selector rather than the matcher.

**Guard-map sweep:** `lintGlobPattern` (`glob.ts:91-115`) rejects character classes, extglobs, alternation, negation, and nested/range braces — it does **not** examine `**` placement, and nothing else does. `glob.test.ts:5-8` has exactly one `**` test, titled "matches `**` as zero or more path segments", and all three of its assertions use a **trailing** `**` (`packages/core/**`). No test covers interior `**`. The over-match is unasserted and undocumented — not an intentional design.

**Verified fix:** compile `**/` (a `**` that owns a whole segment) to an optional whole-segment run; leave trailing `**` as `.*`.

```ts
if (c === '*') {
  if (normalized[i + 1] === '*') {
    if (normalized[i + 2] === '/') { out += '(?:.*/)?'; i += 3; continue; }  // interior: whole segments only
    out += '.*'; i += 2; continue;                                            // trailing `**`: unchanged
  }
  out += '[^/]*'; i += 1; continue;
}
```

**Step 6 checklist:**
1. *Boundary arithmetic:* the fix reads `normalized[i+1]` and `normalized[i+2]`. Past end-of-string both are `undefined`, which falls through to the trailing-`**` branch — no out-of-range read, no fixed-width parse. Verified at 0, 1, and end-of-pattern in the table below. ✅
2. *Mirror path:* the "write" side of a selector is `lintGlobPattern`; `**` remains valid in the dialect, so the lint needs no change. ✅
3. *Existing data:* **yes — a behavior change, not just a bug fix.** Tightening `**` un-classifies files that were previously (wrongly) claimed. Two consequences to state in the release note: (a) a component relying on the loose match may drop to zero files and turn `align check` **red→error** via `validateClassifiedComponents`; (b) reclassified files produce different violation fingerprints, orphaning baseline entries. No data migration in the DB sense; the user action is `align baseline prune && align baseline accept`. Ships with #4 so this happens once. ✅
4. *Constraint values:* the authoritative statement of intent is `glob.ts:1-7` and the `SUPPORTED_GLOB_VOCABULARY` string at `registry.ts:6-7`; the three regression assertions are `glob.test.ts:6-8`. All cited, none guessed. ✅
5. *Failure modes:* pure string compilation, no throw path added. Cannot reintroduce segment-crossing for any input — every `**` is now either segment-owning or trailing. ✅
6. *Interactions:* ships with #4 (same churn class). ✅
7. *Caller contract:* `globMatch` has four call sites, all verified: `registry.ts:28` (component classification — the intended target), `external-match.ts:19` (matches against `packageName`, where patterns are `@scope/*` or bare names — no interior `**` possible in practice), `deep-imports.ts:84` (`DEFAULT_ALLOWLIST` is `typescript/lib/*`, `mocha/lib/*` — no `**`), `plugin/registry.ts:27` (`fileMatch` patterns are `**/*.ts`-shaped — leading `**/`, verified below to be unchanged in behavior). Only component classification changes. ✅
8. *Empirical re-test:* the fix was run against the same harness, including all three existing `glob.test.ts` assertions:

```
ok   "packages/core/**"   "packages/core/src/index.ts" got true  want true    ← glob.test.ts:6
ok   "packages/core/**"   "packages/core/index.ts"     got true  want true    ← glob.test.ts:7
ok   "packages/core/**"   "packages/other/index.ts"    got false want false   ← glob.test.ts:8
ok   "src/**/index.ts"    "src/notindex.ts"            got false want false   ← the bug, fixed
ok   "src/**/index.ts"    "src/index.ts"               got true  want true
ok   "src/**/index.ts"    "src/a/b/index.ts"           got true  want true
ok   "app/**/model.ts"    "app/datamodel.ts"           got false want false   ← the bug, fixed
ok   "**/*.ts"            "a.ts"                       got true  want true
ok   "**/*.ts"            "x/y/a.ts"                   got true  want true
ok   "**"                 "anything/at/all.ts"         got true  want true
ok   "packages/*/src/**"  "packages/a/src/b.ts"        got true  want true
```
✅ 11/11, no existing assertion regressed.

---

### BUG #3 — `custom.host` violation fingerprints fold in a line number, against the documented invariant

**Lens:** Cross-Implementation Divergence
**File:** `packages/core/src/rules/host-rules.ts:165`
**Confidence:** Confirmed (empirical) — real `evaluateCustomHost`, identical violation, only `range.startLine` 5→6:
```
fingerprint at line 5: 4d07ef45605a29ca
fingerprint at line 6: 9d37f5670a16fe70
content fingerprints identical (only the file check can block transfer): true
reconcileMoves transferred: []
is the shifted violation baselined after reconcile? false
```
The no-rescue sub-claim is confirmed too: content fingerprints match, so the *only* thing blocking transfer is `matched.file !== entry.file` (`store.ts:134`) — same file, no transfer, orphan stays, violation resurfaces red.

**Assumption:** every violation fingerprint is line-independent, so a baseline entry survives reformatting.

**Violation scenario:** `normalizeHostViolation` builds the fingerprint as:

```ts
const id = computeFingerprint(['custom', rule.id, hv.file, String(range.startLine), hv.message]);
```

Insert a comment or an import above a `custom.host` violation — anything that shifts its line — and the fingerprint changes. The old baseline entry orphans; the violation reappears as new; CI turns red on a purely cosmetic edit. This is precisely the "baseline churn" failure mode `fingerprint.ts` exists to prevent.

**Guard-map sweep — the guard matrix, all 9 `computeFingerprint` call sites:**

| Call site | Fingerprint parts | Line number? |
|---|---|---|
| `evaluators.ts:56` no-dependency | rule.id, from, to, specifier | no ✅ |
| `evaluators.ts:95` no-dependency-external | rule.id, from, to, specifier | no ✅ |
| `evaluators.ts:164` no-cycles | rule.id, chain `from>to:specifier` | no ✅ |
| `evaluators.ts:205` layers | rule.id, from, to, specifier | no ✅ |
| `evaluators.ts:247` layers-external | rule.id, from, to, specifier | no ✅ |
| `evaluators.ts:283` metric | rule.id, node.file | no ✅ |
| `manifest-evaluators.ts:52` source-hygiene | rule.id, manifest.file, dep.name | no ✅ |
| `manifest-evaluators.ts:90` new-dependency | rule.id, manifest.file, dep.name | no ✅ |
| **`host-rules.ts:165` custom** | rule.id, file, **`String(range.startLine)`**, message | **YES ❌** |

The authoritative doctrine is `core/src/baseline/fingerprint.ts:8-9`: *"Callers pass the violation's `snippet` plus whatever structurally-relevant fields identify it … — **never line numbers**."* `manifest-evaluators.ts:40-43` re-states it independently for its own family ("never the specifier value or a line number — so a git-ref bump or manifest reformatting doesn't reset baseline consent"). One implementation out of nine breaks the invariant that the other eight uphold and that two doc comments assert.

**Verified fix:** drop the line number from the parts array.

```ts
const id = computeFingerprint(['custom', rule.id, hv.file, hv.message]);
```

**Step 6 checklist:**
1. *Boundary arithmetic:* none.
2. *Mirror path:* the read side is `isBaselined(v.id)` (`store.ts:72`); the write side is `accept()` storing `v.id` (`store.ts:79`). Both consume the same computed id — symmetric by construction. ✅
3. *Existing data:* **yes.** Every currently-baselined `custom.host` entry orphans on the first check after upgrade. It will **not** self-heal: `applyMoves` only transfers when `matched.file !== entry.file` (`store.ts:134`), and the file is unchanged here — so these become unmatched orphans, which `reconcileMoves` deliberately leaves in place (`store.ts:29-34`). Required user action: one `align baseline prune && align baseline accept`. Folded into the #2/#3/#4 combined release note. ✅
4. *Constraint values:* the "never line numbers" constraint is read from `fingerprint.ts:9`, not assumed; the sibling behavior is read from all eight call sites listed above. ✅
5. *Failure modes:* **a real trade-off, stated rather than hidden.** Removing the line makes two `HostViolation`s in the same file with the *same message* on different lines hash identically — they collapse to one baseline entry. This is consistent with the rest of the family (two identical no-dependency edges from the same file with the same specifier already collide at `evaluators.ts:56`), but it is a semantic change for predicate authors. The fix should ship with a one-line note in the `hostRules` authoring docs: *a predicate emitting per-line findings must put distinguishing detail in `message`, not rely on the line number.* ✅ (with documentation)
6. *Interactions:* shares the #2/#4 migration note. No code interaction. ✅
7. *Caller contract:* `normalizeHostViolation` is module-private (`host-rules.ts:154`); its only caller is `evaluateCustomHost` at line 214. Return type unchanged. ✅
8. *Empirical re-test:* n/a — the finding is a static guard-matrix comparison, fully verified by reading all nine call sites.

---

### BUG #4 — The scanner's exclude matcher diverges from core's glob dialect three ways, despite a comment claiming parity

**Lens:** Cross-Implementation Divergence
**File:** `packages/plugin-typescript/src/scanner.ts:204-214`
**Confidence:** Confirmed (empirical)

**Assumption:** stated in the code itself at `scanner.ts:204-205` — *"reuses the same small pattern vocabulary as core's component globs."* It does not; it is a second, independent implementation.

**Violation scenario:** three concrete divergences, all confirmed by running both implementations side by side:

```
pattern                file                    core globMatch   plugin globLikeMatch
"**/*.generated.ts"    "foo.generated.ts"      true             FALSE      ← divergence 1
"**/*.generated.ts"    "src/foo.generated.ts"  true             true
"**/*.test.ts"         "a.test.ts"             true             FALSE      ← divergence 1
"{dist,build}/**"      "dist/x.ts"             true (via        FALSE      ← divergence 2
                                                expandBraces)
"test apps/**"         "testXapps/secret.ts"   —                TRUE       ← divergence 3
```

1. **Root-level files escape a leading `**/` exclude.** `globLikeMatch` rewrites `**` → `' '` → `.*` *without* consuming the following `/`, so `**/*.generated.ts` compiles to `^.*/[^/]*\.generated\.ts$` — the `/` is mandatory. A generated file at the repo root is scanned despite the exclude. Consequence: spurious violations on files the user explicitly excluded.
2. **No brace expansion.** `expandBraces` is core-only (`glob.ts:53`). `{dist,build}/**` works in a component selector and silently matches nothing in `excludes` — a *silently ineffective exclude*, the worse direction.
3. ~~**A literal space in a pattern becomes a wildcard.**~~ **RETRACTED — this sub-claim was wrong. See the Refutation Log entry #8.** The placeholder is not a space; it is a literal **NUL byte** (`\x00`), which both `Read` and `cat -e` render as a space. `od -c` on the pre-fix file shows `'\0'`. NUL cannot appear in a real path or pattern, so the placeholder is safe and the substitution is sound. My "empirical" evidence for this sub-claim tested a hand-retyped copy of the function in which I had transcribed the invisible NUL as a space — I was measuring my own transcription, not the code. Divergences 1 and 2 above were re-verified against the real NUL-based implementation and both hold.

**Verified fix:** delete `globLikeMatch` and call core's `globMatch`. The plugin already imports from `@spikedpunch/align-core` (`scanner.ts:11-27`), so this adds no dependency and makes the comment's parity claim true.

```ts
// scanner.ts
import { globMatch, /* …existing… */ } from '@spikedpunch/align-core';

function isExcludedPath(relPath: string, excludes: readonly string[]): boolean {
  if (relPath === '') return false;
  return excludes.some(
    (pattern) => relPath === pattern || relPath.startsWith(`${pattern}/`) || globMatch(pattern, relPath),
  );
}
// globLikeMatch deleted
```

**Step 6 checklist:**
1. *Boundary arithmetic:* none introduced — the fix removes an implementation rather than adding one.
2. *Mirror path:* `isExcludedPath` has two call sites in the scanner — the directory-walk side (`walkSourceFiles:175,190`) and the edge-resolution side (`scanFile:259`). Both go through this one function, so the fix applies to both symmetrically; there is no second exclude path to keep in sync. The literal-prefix arms (`relPath === pattern`, `startsWith(pattern + '/')`) **must be kept** — core's `globMatch` has no implicit directory-prefix semantics, so removing them would break plain `dist` excludes. Encoded above. ✅
3. *Existing data:* **yes.** Excludes change meaning: root-level files matching `**/…` become excluded (fewer violations — a repo could go red→green), brace patterns start working, space-containing patterns stop over-matching. Same baseline-churn class as #2 — **this is why they ship together**, so users re-accept once rather than twice. ✅
4. *Constraint values:* the dialect is read from `glob.ts:1-7` and `lintGlobPattern`; the current behavior was measured empirically rather than assumed. ✅
5. *Failure modes:* `globMatch` never throws — `expandBraces` returns the pattern unchanged on malformed input (`glob.ts:65`, deliberate: "on malformed input this returns the pattern unchanged so it merely fails to match rather than throwing on the scan hot path"), and `globToRegExp` escapes every regex metacharacter. Cannot reintroduce the space-corruption class: core uses no placeholder substitution. ✅
6. *Interactions:* ships with #2. Note that after both fixes, excludes and component selectors are guaranteed to agree — which also means #2's `**` tightening applies to excludes too. That is the intended, consistent outcome, and it is one more reason to ship them as a set. ✅
7. *Caller contract:* `globLikeMatch` is module-private (not exported — verified by reading the full file); `isExcludedPath` keeps its exact signature and return type. ✅
8. *Empirical re-test:* core's `globMatch` behavior on the divergent table is the "core" column above, produced by the same harness — it is correct on all five rows (with `{dist,build}/**` correct via `expandBraces`, which `globToRegExp` alone does not perform).

---

### BUG #5 — `loc` counts a phantom trailing line, so `arch.metric` fires one line early

**Lens:** Boundary Conditions
**File:** `packages/plugin-typescript/src/scanner.ts:228` and `:357`
**Confidence:** Confirmed (empirical)

**Violation scenario:** `const lines = text.split('\n')` then `loc: lines.length`. For any file ending in a newline — i.e. essentially every file written by an editor or formatter — `split('\n')` yields a final empty string that is not a line.

```
$ node -e '…'
"a\nb\nc\n"  →  align loc = 4     (real lines: 3)
"a\nb\nc"    →  align loc = 3     (real lines: 3)
```

`evaluateMetric` (`evaluators.ts:281`) then tests `node.loc <= rule.max`. With `arch.metric max: 300`, a file of exactly 300 real lines reports `loc = 301` and **violates**. The violation payload also carries `value: node.loc` (`evaluators.ts:297`), so `align check` tells the user their 300-line file is 301 lines.

**Consequence:** an off-by-one false positive at exactly the threshold, plus a user-visible wrong number in every metric violation. Low blast radius but trivially wrong, and `arch.metric` was promoted specifically on file-size evidence (`docs/ir-schema.md:12-14`), so the number is the whole point of the rule.

**Guard-map sweep:** `docs/ir-schema.md:399` specifies the semantics only as "`loc > max`" — it never defines how a line is counted, so there is no spec to appeal to. No test exercises the scanner's line counting: `core/test/evaluators.test.ts` builds nodes through `helpers.ts:13`, which takes `loc = 10` as a **parameter**, so every metric test asserts against a hand-supplied number; and `grep -rn "loc" packages/plugin-typescript/test/*.ts` returns no line-count test at all. Unguarded and unasserted.

**Verified fix:**
```ts
// scanFile, replacing `loc: lines.length`
const loc = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
```

**Step 6 checklist:**
1. *Boundary arithmetic:* evaluated by hand and empirically at 0, 1, and around the boundary, with and without a trailing newline (table in check 8). The one risky construction is the `lines.length - 1` index; `split` always returns a non-empty array, so `lines[lines.length - 1]` is never an out-of-range read even for `''`. ✅
2. *Mirror path:* the same `lines` array feeds `snippetAt(line) = lines[line - 1]` (`scanner.ts:235`), which is 1-based over real lines and is unaffected by how the array's *length* is interpreted. The read side, `evaluateMetric`'s `node.loc <= rule.max`, needs no change. ✅
3. *Existing data:* **no migration, and this is worth stating precisely.** The `arch.metric` fingerprint is `['metric', rule.id, node.file]` (`evaluators.ts:283`) — it excludes the measured value, so correcting `loc` does **not** change any existing fingerprint. Baselined metric violations stay baselined. **However**, files sitting at exactly `max` real lines stop violating, orphaning their entries — see the ordering constraint against #7 in the Fix Plan. That is a sequencing requirement, not a migration. ✅
4. *Constraint values:* the comparison `node.loc <= rule.max` is read from `evaluators.ts:281`; the spec wording from `docs/ir-schema.md:399`. Not guessed. ✅
5. *Failure modes:* pure arithmetic, no throw. Note the fix intentionally does **not** match `wc -l`: for a file whose last line lacks a trailing newline, `wc -l` reports 2 for `"a\nb\nc"` while this reports 3. Three lines of code is the correct answer for a LOC metric; `wc -l` counts newline characters, not lines. Stated so nobody "fixes" it toward `wc -l` later. ✅
6. *Interactions:* **interacts with #7** — see the Fix Plan's ordering constraint. This is the one interaction in the report with a real chance of causing harm if ignored. ✅
7. *Caller contract:* `loc` is a field on `DependencyGraphNode`; its consumers are `evaluateMetric` (`evaluators.ts:281,297`) and the doctor/build reporting surfaces. Type unchanged, semantics corrected — no signature or throw-behavior change. ✅
8. *Empirical re-test:* the fix expression run against the boundary table:

```
ok   ""           old(buggy)= 1   fixed= 0   want= 0
ok   "a"          old(buggy)= 1   fixed= 1   want= 1
ok   "a\n"        old(buggy)= 2   fixed= 1   want= 1
ok   "a\nb\nc\n"  old(buggy)= 4   fixed= 3   want= 3
ok   "a\nb\nc"    old(buggy)= 3   fixed= 3   want= 3
ok   "\n"         old(buggy)= 2   fixed= 1   want= 1
ok   "\n\n"       old(buggy)= 3   fixed= 2   want= 2
```
✅ 7/7.

---

### BUG #6 — A `FixProposal` listing the same file twice silently discards one entry's edits, then commits the partial result

**Lens:** Data Lifecycle
**File:** `packages/agent/src/run.ts:162-180`, `packages/core/src/fix/schema.ts:38-40`
**Confidence:** Confirmed (empirical) — real `fixProposalSchema` + `applyFixProposalFiles`, two entries for `src/target.ts` editing different imports:
```
schema accepts duplicate-path proposal? true
validated results: 2 [ {ok:true, path:'src/target.ts'}, {ok:true, path:'src/target.ts'} ]
--- first entry edit  survived? false
--- second entry edit survived? true
```
Replaying `run.ts:180`'s write loop leaves only the second entry's edits.

**Assumption:** `FixProposal.files` contains each path at most once.

**Violation scenario:** LLMs routinely emit one entry per logical change, which for two changes in one file means two entries with the same `path`. Nothing rejects that:

1. `fixProposalSchema` (`fix/schema.ts:38-40`) validates `files: z.array(fixProposalFileSchema).min(1)` — **no uniqueness constraint** on `path`.
2. `run.ts:162-166` builds `originals` as a `Map`, so both entries read the *same* original text.
3. `applyFixProposalFiles` (`apply.ts:229`) maps over the `files` **array**, producing two independent `ValidatedFile` results for the same path, each computed against that same original — neither sees the other's edits.
4. `run.ts:180` — `for (const v of validated) if (v.ok) await effects.writeFile(v.path, v.content)` — writes the first result, then **overwrites it with the second**. The first entry's edits are gone.
5. `run.ts:197` commits anyway.

**Consequence:** a silently partial fix is committed. `apply.ts:178-182`'s stated contract — *"Rejects the ENTIRE file patch atomically on any failure — a proposal either fully applies or fully doesn't"* — holds per array entry but is violated for the file. The VERIFY step catches the still-present violation and retries, so this burns attempts rather than shipping a wrong green; but the intermediate commit contains half-applied edits.

**Negative-claim receipt (rule 3):** `grep -rn "dedup|new Set(proposal|uniq" packages/agent/src/*.ts` → only prompt prose in `anthropicFixProvider.ts:28,84`, no dedup logic. No uniqueness refinement anywhere in `core/src/fix/schema.ts` (read in full).

**Verified fix:** reject at the schema boundary — the earliest point, and the one place that covers every provider.

```ts
// core/src/fix/schema.ts
export const fixProposalSchema = z.object({
  files: z.array(fixProposalFileSchema).min(1)
    .refine((files) => new Set(files.map((f) => f.path)).size === files.length,
      'each file may appear at most once — put every edit for a file in that file\'s `edits` array'),
  suppressions: z.array(suppressionSchema).optional(),
  rationale: z.string().min(1),
});
```

**Step 6 checklist:**
1. *Boundary arithmetic:* none. `Set` size vs array length is total over 0, 1, and N entries.
2. *Mirror path:* the read side is `applyFixProposalFiles`'s `files.map`; the write side is `run.ts:180`'s loop. Rejecting at parse means neither ever sees a duplicate — both sides fixed by one guard rather than patching the write loop alone. ✅
3. *Existing data:* none — `FixProposal`s are transient in-memory values, never persisted. ✅
4. *Constraint values:* the existing `.min(1)` constraints are read from `fix/schema.ts:38-40`; the message directs the model to the real affordance (`edits` is already an array, `fix/schema.ts:27`). ✅
5. *Failure modes:* rejection is loud but **not** a crash — the parse site is `anthropicFixProvider.ts:194`, which uses `safeParse`, not `parse` (verified). A refinement failure therefore returns `{ success: false }` into the provider's existing malformed-proposal path and the agent's retry loop, rather than throwing through `run.ts`. This was the check most likely to sink the fix; it passes. ✅
6. *Interactions:* none with #1–#5. ✅
7. *Caller contract:* `fixProposalSchema`'s inferred type is unchanged (`.refine` narrows validity, not the TS type), so `FixProposal` consumers compile unchanged. The only behavior change is at the one `safeParse` site. ✅
8. *Empirical re-test:* n/a — traced. Merging duplicates instead of rejecting was considered and rejected: two independently-resolved edit sets can produce overlapping spans that `applyEditsToFile`'s atomic overlap check (`apply.ts:191-202`) would have caught within one entry, so merging trades a silent loss for a silent corruption.

---

### BUG #9 — The cycle walk can strand and report a non-cycle as a cycle

**Lens:** Boundary Conditions / State Machines
**File:** `packages/core/src/rules/tarjan.ts:74-102`, consumed at `packages/core/src/rules/evaluators.ts:143-181`
**Confidence:** Confirmed (empirical)
**Status:** promoted from Needs-Review #1 in the original pass, where it was left `Suspected` after six hand-built topologies failed to reach it.

**Assumption:** the chain `extractCycleChainNodes` returns always closes back to its start, so `evaluateNoCycles` can render it as a cycle without checking.

**Violation scenario:** the greedy walk marks nodes `seen` (`tarjan.ts:86,98`) and picks the *first* unseen in-SCC neighbor (`tarjan.ts:94`). If that greedy choice enters a dead-end branch, the walk can reach a node whose only remaining in-SCC neighbors are already seen and which has no edge back to `start` — it `break`s at `tarjan.ts:96` and returns the "partial chain (still informative)" the comment at `tarjan.ts:101` acknowledges. `evaluateNoCycles` never checks closure; it builds the violation from whatever it got.

Brute force over all 4-node digraphs × 24 node-insertion orders × 4 edge orders, running the **real** `tarjanScc` + `extractCycleChainNodes` (so `scc[0]` is only ever what Tarjan actually produces):

```
$ node charge1-bruteforce.mjs
SCCs (size>1) checked: 349440
non-closed chains found:  6372          (~1.8% of configurations)
```

Minimal instance: `n0→[n3,n1]`, `n1→[n2]`, `n2→[n0]`, `n3→[n0]` — strongly connected (`n0→n3→n0` and `n0→n1→n2→n0`). Tarjan yields `scc[0] = n2`. Walk: `n2→n0`; at `n0` the first unseen neighbor is `n3` (the dead-end branch) rather than `n1` (the live one); at `n3` the only neighbor `n0` is seen and `n3` has no edge to `n2` → break. Chain `[n2, n0, n3]` — **last ≠ first**.

**Why the original pass missed it:** the close-first check at `tarjan.ts:90-92` rescues any walk that *touches* a node with an edge back to start. Stranding additionally requires the SCC's start-predecessor to be bypassed by the greedy `find` — i.e. two overlapping cycles through one node *plus* a specific neighbor ordering. Neighbor order comes from import order in the file (`evaluators.ts:134`), so it is entirely ordinary input, not a contrived one.

**Not swallowed downstream — user-visible.** The `edgeByPair.get(...) === undefined → continue` guards at `evaluators.ts:153-162` never fire: every hop the walk takes is a real edge from the same edge set that built both `adjacency` and `edgeByPair` (`evaluators.ts:130-139`). Demonstrated through the real `evaluateNoCycles` with an ordinary layout (`a.ts` imports `./d` then `./b`; `b→c`, `c→a`, `d→a`):

```
$ node charge1-e2e.mjs
violation kind:      no-cycles
rendered path:       c.ts -> a.ts -> d.ts
closes back to start? false
suggestedBreakEdge:  a.ts -> d.ts
fingerprint:         3ea48afeec39957b
```

**Consequence:** a non-cycle path is reported to the user as a cycle, with a `suggestedBreakEdge` pointing at an edge whose removal breaks nothing. Worse, the fingerprint (`evaluators.ts:164`) is computed over the phantom chain — so baselining that violation accepts a fabricated identity, and any change to import order re-rolls it.

> **Correction to the original report.** Needs-Review #1 closed with: *"the defensive `if (chain[0] !== chain[chain.length - 1]) continue;` in `evaluateNoCycles` costs nothing and closes it either way."* **That is wrong, and the suggestion must not be shipped.** In the reaching instance above, that `continue` would emit **zero** violations for an SCC containing two genuine cycles (`a↔d` and `a→b→c→a`) — converting a wrong-but-visible violation into a silent false green, the exact class this codebase exists to prevent.

**Fix: RESOLVED and implemented (2026-08-07).** The greedy walk is deleted and replaced by a BFS for the shortest cycle through `scc[0]` — which cannot strand, because in an SCC of size ≥2 every node is mutually reachable. Self-loops keep the `[a, a]` two-element contract (returning `[a]` would produce zero hops and silently drop the violation — the same false-green class as the rejected skip-the-SCC mitigation).

**The scope decision was settled by measurement, not judgment.** The open question was whether BFS should *replace* the greedy walk or only *back it up* on strand, since `evaluators.ts:164` fingerprints over the chain's edge sequence and any change orphans baseline entries. Measured across six real repos (align, kluster, n8n, directus, otel-js, fluxify — ~23,000 files) using the real compiled scanner and the real compiled `tarjanScc`:

| | runtime kinds | with `includeTypeOnly` |
|---|---|---|
| multi-node SCCs | 221 | 285 |
| **stranded (the live bug)** | **9 (4.1%)** | 16 (5.6%) |
| closed chains identical under BFS | 209 (98.6%) | 264 (98.1%) |
| **closed chains that would differ** | **3 (1.4%)** | 5 (1.9%) |

Three findings decided it:

1. **The premise of the back-up-only option was false.** It was proposed on the grounds that "no user re-accepts anything" — but stranded SCCs churn under *any* correct fix, so a repo with cycle debt including a stranded SCC re-accepts either way. Its true saving is 3 entries out of 212, not "all of them."
2. **Stranding is worse in the wild than synthetically estimated** — 4.1% measured vs ~1.8% from brute force. n8n renders 6 phantom non-cycles today; directus 3.
3. **The "huge phantom chain" legibility argument does not hold at this scale** and should not have been relied on: real SCCs do get large (244 nodes in n8n) but reported chains stay short — max 11 greedy hops, median 2. The close-first shortcut at `tarjan.ts:90-92` kept them short. BFS still wins on legibility in the divergent cases (8 hops → 4, 3 → 2), which improves `suggestedBreakEdge` and the fix agent's target — but that is a smaller argument than it was made to sound.

**Also corrected:** `tarjan.ts`'s module header credited the whole file to the kluster spike as a "proven algorithm". That credit was only ever earned by the iterative Tarjan (stack safety); the walk carried this defect *from* that same source (`docs/evidence/kluster-spike/src/rules.ts:178` has the identical strand defect). The header now scopes the attribution to the SCC algorithm and marks the chain extraction as align's own. The vendored evidence file is left untouched.

**Migration:** the 9 stranded fingerprints and 3 divergent ones change, so this folds into the same combined `align baseline prune && align baseline accept` note as #2/#3/#4. Move-transfer cannot rescue them — `store.ts:134` requires a different file, and a re-derived chain keeps `violation.file = scc[0]`; the snippet usually changes too, so `contentFingerprint` shifts as well.

### BUG #10 / #11 / #12 — The marker-splice branch mishandles every malformed state: silent deletion, unbounded duplication, and a permanently stale block

**Lens:** Cross-Implementation Divergence + Boundary Conditions
**Files:** `packages/cli/src/init/claude-md.ts:36-47` and `packages/cli/src/init/config-comment.ts:34-47` — the same 12 lines, duplicated. `config-comment.ts:6` names the duplication explicitly ("same 3-branch pattern as the CLAUDE.md agent-instructions block").
**Confidence:** Confirmed (empirical)
**Reached from:** `runInit` calls both on **every** `align init` (`init.ts:81-82`); `align build --apply` calls the config one again (`build.ts:250`).

**Assumption:** the file contains either zero markers or exactly one well-formed `START … END` pair. The code tests only `startIdx !== -1 && endIdx !== -1 && endIdx > startIdx` and treats *everything else* as "no block here — append", which is wrong for every malformed arrangement.

**Violation scenarios**, all run against the real compiled `writeAgentInstructions` / `writeGeneratedRulesNote`:

| Initial state | Run 1 | Run 2 | Defect |
|---|---|---|---|
| Human content, no markers | append, human kept | idempotent | — (correct) |
| **START present, END missing** | appends → 2 starts / 1 end | **human content deleted** (`humanKept=false`) | **#10** |
| **END before START** | appends → 2 starts / 2 ends | appends again → 3 / 3, unbounded | **#11** |
| **Two complete pairs** | only the first refreshed; second retains stale `old2` | — | **#12** |

**#10 mechanism:** run 1 leaves two STARTs and one END. On run 2, `indexOf(START_MARKER)` returns the *first* start and `indexOf(END_MARKER)` returns the *only* end, which is now after it — so `endIdx > startIdx` passes and the splice takes `before = slice(0, firstStart)` and `after = slice(end + len)`, discarding everything in between. That "everything in between" is the human's content.

**In `align.config.ts` the same defect destroys the ruleset.** Starting from a config whose note block lost its END marker:

```
initial config has rules?   true
after run 1  rules present? true
after run 2  rules present? false   defineProject present? false
```

The file is reduced to the import line plus the note block — components and rules gone.

**Severity: Critical** (raised from High on review, deliberately). The mitigations are real but do not carry the weight I first gave them: yes, the config case fails loudly immediately afterward (`loadConfig` throws "must have a default export", `config.ts:115-117`), and yes, a committed file is git-recoverable. But this is the only finding in the report that destroys **hand-authored source** rather than machine-regenerable state — the user's ruleset is not reconstructible from anything align holds, and uncommitted edits are simply gone. The `CLAUDE.md` variant loses only prose, but loses it *silently*, with nothing downstream ever flagging it. "Loud afterward" mitigates diagnosis, not loss.

**Constraint violated (Step 6.4 / Step 5.4):** both modules promise exactly the opposite in their own doc comments. `claude-md.ts:23-26`: *"Idempotent … re-running `align init` never duplicates or corrupts human-authored instructions around the block."* `config-comment.ts:26-29`: *"re-running never duplicates or corrupts the rest of `align.config.ts` … **Never touches file content it doesn't own.**"* #10 corrupts, #11 duplicates, and #10 touches content it doesn't own.

**Negative-claim receipt (rule 3):** `grep -rn "align:start|align:end|marker" packages/cli/test/*.ts` returns only `init.test.ts:34` (asserting the marker is present) and `doctor.test.ts:279-317` (skill version stamps, all well-formed). `init.test.ts` has exactly three CLAUDE.md tests — create (`:27`), idempotent re-run (`:44`), append-preserving-human-content (`:52`). **No test covers any malformed marker state**, in either module.

**Verified fix (one fix, all three defects, both files).** Count markers instead of locating them; accept only the two states that are unambiguous, and refuse the rest rather than guessing which content belongs to whom:

```ts
const occurrences = (s: string, marker: string): number => s.split(marker).length - 1;

/** Returns the splice bounds for exactly one well-formed pair, `undefined` when the file has no
 * block yet (append), and throws on any malformed arrangement — align must never guess which
 * content is the human's. */
function locateBlock(existing: string, filePath: string): { start: number; end: number } | undefined {
  const starts = occurrences(existing, START_MARKER);
  const ends = occurrences(existing, END_MARKER);
  if (starts === 0 && ends === 0) return undefined;
  if (starts === 1 && ends === 1) {
    const start = existing.indexOf(START_MARKER);
    const end = existing.indexOf(END_MARKER);
    if (end > start) return { start, end };
  }
  throw new Error(
    `${filePath} has a malformed align block: ${starts} \`${START_MARKER}\` and ${ends} ` +
      `\`${END_MARKER}\` marker(s). align refuses to rewrite the file rather than guess which ` +
      `content is yours. Restore exactly one START…END pair, or delete both markers to let align ` +
      `append a fresh block, then re-run.`,
  );
}
```

**Step 6 checklist:**

1. *Boundary arithmetic.* `split(m).length - 1` evaluated at 0/1/2 occurrences: `""` → `[""]` → 0; one → 2 parts → 1; two → 3 parts → 2. ✅ `indexOf` is consulted **only** when the count is exactly 1, so it is unambiguous by construction — this is what removes the first-match hazard behind #10 and #12. `end + END_MARKER.length` at end-of-file yields `slice()` → `""`, not an out-of-range read. ✅ Neither marker is a substring of the other in either module (`<!-- align:start -->` / `<!-- align:end -->`; `// align:generated-rules-note:start` / `…:end`), so the counts can't contaminate each other — checked, not assumed. ✅
2. *Mirror path.* The read side is the marker scan; the write side is the create branch (`claude-md.ts:31-34`), which emits a well-formed pair — so align never generates a malformed state itself; malformed states arrive from human edits, merge resolutions, or an interrupted `writeFileSync`. Both sibling modules must take the fix together or the divergence persists — encoded as a ships-with set. ✅
3. *Existing data.* **Yes, and it cuts both ways.** A repo already in a malformed state now gets a hard error where it previously got silent corruption — that is the point, but it changes `align init` and `align build --apply` from always-succeeding to fallible. Users are told exactly what to do (restore one pair, or delete both markers). **No migration is possible for repos already damaged by this bug** — the deleted content is gone; only git can recover it. Say so in the release note rather than implying the fix is retroactive. ✅
4. *Constraint values.* The authoritative promises are quoted above from `claude-md.ts:23-26` and `config-comment.ts:26-29`; the accepted-state definition ("exactly one pair") is derived from the create branch's own output, not invented. ✅
5. *Failure modes.* Throws (loud) on malformed; appends on clean-absent; splices on exactly-one-pair. The deletion class is unreachable for **any** input, because the splice branch now requires `starts === 1 && ends === 1` — there is no input for which `before`/`after` can span human content. ✅
6. *Interactions.* #10/#11/#12 are one fix, and it has no interaction with #1–#9. **⚠️ Correction, found during implementation — this check was originally marked ✅ and was wrong.** The fix introduces a new throw point *in the middle of a multi-write sequence*. In `writeBuildArtifacts` (`build.ts:225-275`) the order is: (1) `writeGeneratedRules` writes `.align/generated-rules.json`, (2) `writeGeneratedRulesNote` — the newly-throwing call, (3) the conditional `writeBaseline`, (4) `writeRulesLock`. A malformed config now aborts at (2), so `align build --apply` reports failure while leaving `generated-rules.json` on disk — which `loadConfig` merges on the next check (`config.ts:128-141`), putting doc-built rules silently in force despite the reported failure, with no lockfile so `generatedRulesSummary` (`check.ts:25-30`) doesn't even print the "+N rules from doc" line. With `--accept-new-into-baseline`, the new violations also go unbaselined and the next check is red for violations the user believes they consented to. The write-ordering weakness pre-dates this fix (an fs error at step 2 could always have caused it), but the fix makes it reachable through an ordinary user-caused condition. **Correct resolution: validate the config's marker state up front, before any write, rather than reordering the writes** — reordering leaves the same window open for genuine I/O errors and merely narrows it. Tracked as part of #10's fix, not deferred.
7. *Caller contract.* **Changes both functions from `void`-and-never-throwing to throwing.** Full caller list verified: `writeAgentInstructions` ← `init.ts:82` (sole caller); `writeGeneratedRulesNote` ← `init.ts:81` and `build.ts:250`. Neither is wrapped in a `try`/`catch`, and `program.ts:59-67`'s action handler awaits `runInit` and assigns its return to `process.exitCode` — so an uncaught throw would surface as an unhandled rejection rather than a clean CLI error. **The fix is not complete without catching at those three call sites** and converting to a printed message + non-zero exit, matching how `runInit` already reports other refusals (`init.ts:112-117`). This is why the effort is Small / 3 call sites, not a two-line patch. ✅
8. *Empirical re-test.* The fixed logic run against all seven states, checking both the throw/no-throw verdict and idempotency-on-rerun for the non-throwing ones:

```
ok   1. file absent                   want=create             got=ok     idempotent   humanPreserved=true
ok   2. human content, no markers     want=append, keep HUMAN got=ok     idempotent   humanPreserved=true
ok   3. exactly one well-formed pair  want=splice, keep HUMAN got=ok     idempotent   humanPreserved=true
ok   4. START only, no END            want=THROW              got=THROW  n/a          humanPreserved=true
ok   5. END only, no START            want=THROW              got=THROW  n/a          humanPreserved=true
ok   6. END before START              want=THROW              got=THROW  n/a          humanPreserved=true
ok   7. two complete pairs            want=THROW              got=THROW  n/a          humanPreserved=true

7/7 states correct under the proposed fix
```
✅ The three previously-correct states stay correct and stay idempotent; all four malformed states are refused instead of silently mangled.

### BUG #13 — A second `align agent run` on the same day crashes on a branch-name collision

**Lens:** Time & Concurrency + Error Paths
**Files:** `packages/agent/src/run.ts:311-313` (name construction), `packages/agent/src/run.ts:298` (unguarded call), `packages/agent/src/git.ts:39-41` (the failing exec)
**Confidence:** Confirmed (empirical) — user-reported reproduction with a full stack trace; mechanism traced to source below.

**Assumption:** the work-branch name is unique per run.

**Mechanism:**
```ts
export function defaultWorkBranchName(now: () => number = Date.now): string {
  const iso = new Date(now()).toISOString().slice(0, 10);   // ← DATE ONLY: 2026-08-03
  return `align/fixes-${iso}`;
}
```
`.slice(0, 10)` truncates the ISO timestamp to `YYYY-MM-DD`, so every run in the same repo on the same calendar day produces the identical name. `runAgentLoop` then calls `createBranch` with no guard (`run.ts:298`), which shells out to `git checkout -b <name>` (`git.ts:40`). Git exits 128, `execFileAsync` rejects, and nothing between there and `program.ts:219`'s action handler catches it:

```
Error: Command failed: git checkout -b align/fixes-2026-08-03
fatal: a branch named 'align/fixes-2026-08-03' already exists
  code: 128
```

**Consequence:** `align agent run` is unusable a second time in a day without manual git surgery, and the failure presents as a raw Node stack trace rather than a CLI error — the same unhandled-rejection class as BUG #10's caller-contract gap (`runAgentCommand` at `cli/src/commands/agent.ts:172-189` has no try/catch, and `program.ts:219` merely assigns the return value to `process.exitCode`).

**Negative-claim receipt (rule 3):** `grep -rn "already exists|createBranch" packages/agent/test/*.ts` returns only `fakeEffects.ts:46`, whose `createBranch` is a no-op that never rejects — so no existing test could have caught this, in either the collision or the crash-presentation dimension.

> **⚠️ Do not fix this by ignoring the error.** The obvious patch — swallow the rejection and continue — is actively unsafe and would turn a fail-safe crash into silent data loss. When `git checkout -b` fails, **the working tree stays on whatever branch you were already on**, typically `main`. The loop then commits LLM-authored changes to that branch (`run.ts:197`), breaking the guarantee the CLI advertises verbatim at `program.ts:197`: *"every apply is a commit on a fresh `align/fixes-<date>` branch."* A crash here is annoying; committing generated fixes straight to `main` is not recoverable by re-running.

**Verified fix — land on the intended branch or fail loudly, never proceed on an unintended one.** Make `createBranch` idempotent by falling back to a plain checkout of the existing branch:

```ts
async createBranch(name: string): Promise<void> {
  try {
    await git(rootDir, ['checkout', '-b', name]);
    return;
  } catch {
    // Branch already exists (a prior run the same day — `defaultWorkBranchName` is date-granular).
    // Resume onto it rather than creating a second one; NEVER swallow and continue, which would
    // leave the caller committing to whatever branch it started on (typically main).
    await git(rootDir, ['checkout', name]);
  }
  const current = await this.currentBranch();
  if (current !== name) {
    throw new Error(
      `align agent could not switch to work branch '${name}' (still on '${current}'). Refusing to ` +
        `continue — every apply must land on the work branch, never on your current branch.`,
    );
  }
}
```

**Step 6 checklist:**
1. *Boundary arithmetic.* None. The `.slice(0, 10)` that causes the collision is left alone deliberately — see check 5.
2. *Mirror path.* The read side is `currentBranch()` (`git.ts:34-37`), now used as the post-condition assert. Symmetric: the function no longer returns success without the caller actually being on `name`. ✅
3. *Existing data.* Resuming onto an existing `align/fixes-<date>` branch means landing commits alongside the prior run's. That is coherent — the loop refuses a dirty worktree and commits per fix — and is arguably the desired "continue where I left off". No migration. Worth one release-note line so nobody is surprised that a second run appends to the first run's branch. ✅
4. *Constraint values.* The advertised contract is quoted from `program.ts:197`; the branch-name format from `run.ts:313`. ✅
5. *Failure modes.* Throws (loud) when neither checkout lands. Cannot reintroduce the commit-to-main class for any input, because the post-condition is checked against `currentBranch()` rather than inferred from an exit code. **Deliberately not fixed by making the name unique** (e.g. appending `HHMMSS`): that would dodge the collision but leaves the underlying defect — a `createBranch` that can fail while the caller proceeds regardless — live for every other cause (invalid ref name, detached HEAD, permissions). Fix the guarantee, not the symptom. ✅
6. *Interactions.* None with #1–#12. ✅
7. *Caller contract.* `createBranch` already returned `Promise<void>` and could already reject; the fix narrows *when* it rejects. The one caller is `run.ts:298`. Separately, `runAgentCommand` (`cli/src/commands/agent.ts:172`) should catch and print rather than let any rejection escape as an unhandled Node error — that is the crash-presentation half of this finding and is part of the fix, not optional. The test double `agent/test/fakeEffects.ts:46` needs a failure mode so the new behavior is testable at all. ✅
8. *Empirical re-test.* The user's stack trace is the pre-fix reproduction. **Implemented and verified** — 5 tests: three at the loop level via `FakeGitEffects.createBranchMode` (`agent/test/run.test.ts`: collision resumes instead of crashing; the loop lands on the work branch before any commit; a stuck switch aborts with `commitLog` empty and `branch` still `main`), and two against real git (`agent/test/e2e-git.test.ts`: `createBranch` called twice with the same name is idempotent; a branch checked out in another worktree makes it throw with HEAD untouched). Suite 801 → 806, `align check` green.

    **Constraint found during implementation, worth recording:** the CLI-level assertion — that `runAgentCommand` returns 1 with a printed message rather than rejecting — cannot be unit-tested inside `packages/cli/test/`. Driving real git from there requires importing `node:child_process`, which align's own dogfood ruleset forbids for the `cli` component (`arch.no-dependency:cli->external:node:child_process` — "the CLI composition root has zero legitimate child_process need today"). A first attempt at that test turned the repo's self-check red, correctly. No other `packages/cli/test/` file imports `child_process`; the two that mention it do so only in comments and test-data strings. The real-git coverage therefore lives in `packages/agent/test/e2e-git.test.ts`, where those rails legitimately belong. The CLI catch itself **was** verified manually before the test was relocated — a throwaway probe confirmed `code: 1`, no rejection, and stderr `align agent run: … 'align/fixes-…' is already checked out at …` — but it is covered by manual verification plus the agent-level tests, not by a CLI-level regression test. Worth a follow-up if a portable seam for driving git from CLI tests ever appears.

    *Behavioral note:* in the worktree case the message that surfaces is git's own (`fatal: '<branch>' is already checked out at '<path>'`) rather than the post-condition's crafted message, because the fallback `checkout` itself rejects before the assert is reached. Still caught, still exit 1, still nothing committed — and git's message is arguably the more actionable of the two, so this was left as-is rather than wrapped.

### BUG #14 — A corrupt `.align/generated-rules.json` crashes every command with a raw stack trace

**Lens:** Error Paths
**Files:** `packages/cli/src/align-dir.ts:108-118` (throws, correctly), `packages/cli/src/config.ts:128` (`loadConfig`, doesn't catch)
**Confidence:** Confirmed (empirical)
**Found:** during BUG #1's caller sweep — same class, different reader.

**Mechanism:** `readGeneratedRules` throwing on corrupt JSON is *correct and deliberate* (silently dropping doc-built rules would be a false-green — that discipline is what BUG #1 was fixed to match). The defect is purely on the caller side: `loadConfig` calls it unguarded at `config.ts:128`, and `loadConfig` is the entry step of nearly every command (`check`, `build`, `agent`, `baseline`, `mcp`). Nothing between there and `program.ts`'s action handler catches it.

**Reproduction** (run against this repo, real file backed up and restored):
```
$ printf '{ this is not valid json' > .align/generated-rules.json
$ node packages/cli/dist/index.js check
Error: /…/.align/generated-rules.json is not valid JSON: Expected property name or '}' …
    at readGeneratedRules (…/align-dir.js:97:15)
    at loadConfig (…/config.js:65:23)
    at async runTrustedCheck (…/commands/check.js:41:57)
    at async Command.<anonymous> (…/program.js:67:22)
```

**Consequence:** cosmetic but broad — the message itself is accurate and actionable, it is simply wrapped in a Node stack trace instead of presented as a CLI error. Not a data-loss or false-green risk, which is why this is Medium and not High.

**Note on what BUG #1's fix did and didn't cover:** `runTrustedCheck` now catches `readBaseline` (line 79-84) but the `loadConfig` call on the line immediately above it is still unguarded — the sweep guarded the baseline read and left the config load exposed. `align doctor` is the exception and already handles this: `config.ts:49-55` documents that its catch turns a config error into a `config-error` advisory with exit 0.

**Fix:** catch around `loadConfig` at each **CLI command** entry, converting to a printed message plus a non-zero exit. A single catch per call site covers the whole failure family rather than just this reader.

**The `loadConfig` failure family** (enumerated during the Step 6 pass, `config.ts` read in full):

| Failure | Site | Thrown type | Message already actionable? |
|---|---|---|---|
| syntax error in `align.config.ts`, or any non-`ERR_MODULE_NOT_FOUND` import failure | `config.ts:104-114`, rethrown `:113` | native `SyntaxError` etc., unwrapped | Node's own wording, not align-authored |
| `@spikedpunch/align-core` not installed in the target repo | `config.ts:106-113` → `errors.ts:24-40` | `AlignCoreMissingError` | yes — gives two fix commands |
| no `default` export | `config.ts:115-117` | `Error` | yes |
| malformed `excludes`/`compositionRoots`/`knownPublicDeepImports` | `config.ts:56-63` | `Error` | yes |
| corrupt `generated-rules.json` JSON | `align-dir.ts:112-116` | `Error` | yes |
| `generated-rules.json` fails zod | `align-dir.ts:117` | **raw `ZodError`** | **no** — prints zod's issue array |

`mergeGeneratedRules` and `toHostPredicateRegistry` were checked and cannot throw.

**Step 6 checklist (completed 2026-08-06):**
1. *Boundary arithmetic.* None introduced. ✅
2. *Mirror path.* The write side (`writeGeneratedRules`) always emits schema-valid content, so the reader's strictness cannot reject align's own output. ✅
3. *Existing data.* None — no migration, no baseline churn, no fingerprint change. This is purely presentational. ✅
4. *Constraint values.* The failure family above is read from source, not assumed. ✅
5. *Failure modes.* Catch must print and **exit non-zero** — never swallow. A swallowed config error would be a false green, strictly worse than the current crash. ✅
6. *Interactions.* Nothing is masked: no test anywhere calls `loadConfig` directly or asserts it rejects (`grep -rn "loadConfig" packages/*/test` → comments only), and the one adjacent test (`doctor-deep-imports.test.ts:82-99`) asserts the *opposite* — that a config failure becomes a clean advisory at exit 0. ✅
7. *Caller contract.* **9+ call sites across 8 files, not the "1–2 files" originally estimated — a ~4× undercount.** Seven genuinely crash raw today: `check.ts:78`, `explain.ts:9`, `export-ir.ts:26`, `baseline.ts:25`, `baseline.ts:57`, `init.ts:105`, `agent.ts:173`. **Two must NOT be changed**, because they handle failure deliberately and differently: `doctor.ts:105` (→ `config-error` advisory, exit 0) and `telemetry.ts:151` (swallows to `[]` so the rest of the report still prints). ⚠️
8. *Empirical.* Pre-fix crash reproduced (above). Doctor's exit-0 contract verified live: corrupt file → `config-error (1): Could not load align.config.ts: … is not valid JSON`, **exit 0**, file restored, `align check` green again. ✅

**Two scope corrections the Step 6 pass produced — both narrow the fix:**

- **The MCP surface does not need this fix.** The original finding implied `mcp/server.ts` was exposed. It isn't: `@modelcontextprotocol/sdk`'s `McpServer` wraps *every* tool call in its own try/catch and converts any uncaught throw into `createToolError(...)`, byte-identical in shape to the manual `{ isError: true }` responses in `server.ts`. Verified by driving the real server over stdio with a corrupt file — `align_explain_rule` returned a clean `isError` response despite having **no** local catch. The manual catches added by BUG #1's sweep are defense-in-depth and message consistency, not crash prevention. Scope this fix to CLI commands in `program.ts` only.
- **`build.ts`'s `recordBuildTelemetry:64` looks like a gap and is not.** Investigated and empirically refuted: `align build` with a corrupt file fails earlier, in `computeBuildResult`'s *direct* `readGeneratedRules` call (`build.ts:105`), inside `runBuild`'s existing catch (`build.ts:406-416`) — so it prints cleanly and exits 1, and `recordBuildTelemetry` is never reached with a corrupt file.

**Open design question — needs a decision before implementing.** There is **no shared "print a config error and exit non-zero" helper** in `packages/cli`. `err instanceof Error ? err.message : String(err)` appears **19 times across 8 files**, in at least four mutually incompatible shapes: `console.error` + `return 1` (`check`, `build`, `agent`); `console.log` + `return 1` (`init.ts:96`); a local `{ok, code}` discriminated union (`baseline.ts:16-21`); an MCP content object; an advisory push (`doctor`); and a swallow-to-`[]` (`telemetry`). The original sketch's "the same shape already used" is therefore **not accurate** — there is no single shape to copy. Implementing #14 means either picking one shape per surface or introducing a genuine shared helper. **Recommendation: introduce the helper**, since this fix would otherwise make it nine files and twenty-odd bespoke sites.

**One related defect noted, deliberately not folded in:** the zod-parse step throws a raw `ZodError` in all three `.align/` readers (`readGeneratedRules`, `readBaseline`, `readRulesetIr`), so a schema-invalid — as opposed to JSON-invalid — artifact prints zod's issue array rather than align-authored prose. Systemic, not specific to #14, and it survives this fix. Worth its own finding.

### BUG #15 — A third copy of the divergent glob matcher, in `align doctor`, still unfixed

**Lens:** Cross-Implementation Divergence
**File:** `packages/plugin-typescript/src/doctor.ts:35-48` (`isExcluded` + `globLikeMatch`)
**Confidence:** Confirmed (empirical)
**Found:** during BUG #4's implementation — **this is a gap in the original audit, not a new regression.**

BUG #4's guard map recorded "two glob matchers" and its finding named only `scanner.ts:206-214`. There are three. `plugin-typescript/src/doctor.ts` carries a near-identical `isExcluded`/`globLikeMatch` pair with **three** divergences from core's dialect:

1. a leading `**/` does not consume the following `/`, so `**/*.generated.ts` fails to match a root-level `foo.generated.ts`
2. no brace expansion, so `{dist,build}/**` silently matches nothing
3. **a literal space in a pattern becomes a wildcard** — and this is the one worth reading twice. `doctor.ts`'s copy uses an ordinary space (`0x20`) as its intermediate placeholder for `**`, then converts *every* space to `.*`. `scanner.ts`'s copy used a NUL byte for the same job. **The two functions were never byte-identical — they differed by exactly this one byte**, which is why this divergence is real here and was correctly retracted for BUG #4. An exclude pattern naming a directory with a space in it (`test apps/**`) compiles to `^test.*apps/.*$` and over-matches. Verified with `od -c` on both files.

All three verified against the real implementation. See Refutation Log #8 for the full history of how divergence 3 was first claimed, retracted, and then found to be true of this file after all.

**Consequence:** `align doctor` applies a different, laxer exclude vocabulary than `align check` does. The function's own doc comment states the intent it fails to meet: *"a repo's own align.config.ts excludes … must apply here too, or `align doctor` reports noise the repo owner already told align to ignore."* Advisory-only surface, so no false-green in the gate — hence Medium, not High.

**Fix:** identical to BUG #4 — delete `globLikeMatch`, call core's `globMatch`, keep the two literal-prefix arms in `isExcluded`. Deliberately left out of BUG #4's commit rather than swept in, because it was outside the scoped, checklisted work that had been verified; it gets its own entry and its own verification instead.

**Why the original sweep missed it:** the Lens 8 pass searched for *implementors of a shared interface* and for the specific pair `core glob` vs `scanner glob`. `doctor.ts`'s copy is a private module-level function with no shared type binding it to the others — invisible to an interface-based sweep, findable only by grepping the function body or the `.replace(/\*\*/g` idiom. A duplicated-body grep belongs in the Lens 8 checklist alongside the interface sweep.

## Fragile Code

### FRAGILE #7 — Move-transfer can silently baseline a genuinely new violation

**File:** `packages/core/src/baseline/store.ts:112-156`
**Confidence:** Confirmed (empirical) — real `evaluateNoDependency` + `InMemoryBaselineStore`; baseline `a.ts`'s violation, then a scan containing only a textually identical violation in `b.ts`:
```
reconcileMoves result: [{"from":"2cdc5290c3d8efae","to":"1638b25dc6aa7d04"}]
b.ts new violation silently baselined? true
=> CI verdict for the b.ts violation would be: GREEN (suppressed)
```
The trigger is unconditional: `reconcileMoves` runs on every check (`orchestrator.ts:168,242`) and `persistMovedBaseline` writes it to disk (`check.ts:88,205,220`).
**Breaks under this foreseeable change:** a single commit that fixes a violation in one file and introduces a textually identical one in another — routine during a refactor or a copy-paste.

**Mechanism, verified clause by clause:**
- `applyMoves` collects orphans: baseline entries whose structural fingerprint is absent from the current violations (`store.ts:113-114`).
- It indexes candidate targets by `computeContentFingerprint(ruleId, snippet)` — `ruleId` + snippet text only, no file (`fingerprint.ts:28-30`).
- For each orphan it takes the first candidate with `v.file !== entry.file` (`store.ts:134`) and transfers the baseline entry to it (`store.ts:143-152`).
- `reconcileMoves` runs on **every** `align check` (`orchestrator.ts:168`), and `persistMovedBaseline` (`check.ts:220-226`) writes the result to disk.

So: fix `import { db } from './db'` in `a.ts`, add the same line in `b.ts`, one commit. `a.ts`'s entry orphans; `b.ts`'s brand-new violation has the identical content fingerprint and a different file; the entry transfers; `b.ts` is silently pre-accepted and CI stays green.

**Why this is FRAGILE and not BUG:** the design comment at `store.ts:59-63` addresses the adjacent case explicitly — *"a genuinely new violation with an identical snippet in a second location, **while the original violation/file still exists**, is never mistaken for a move."* The authors reasoned about this and guarded the case where the original survives. The unguarded case is the one where it doesn't. That reads as an accepted ADR 006 trade-off with an undocumented edge, not an oversight — which is exactly why it needs a human decision rather than a patch.

**Fix: requires design work.** Checks 3, 6, and 7 all fail for the obvious patch.
- *Candidate direction:* gate the transfer on the orphan's recorded `file` no longer being a node in the current graph — a *real* rename — rather than merely "some other file has the same text."
- *Why it isn't a patch:* `reconcileMoves(currentViolations)` does not receive the graph (`store.ts:35`); `prune` does and ignores it (`store.ts:101`). Adding it is an interface change to `BaselineStore`, which `docs/core-interfaces.md` pins as a published contract.
- *Existing-data risk:* tightening the rule means renames that transfer today would stop transferring, so genuine renames start showing red for one cycle — the exact regression ADR 006 was written to prevent. Whether that trade is right is a product call.
- *Compounding factor to weigh in that decision:* `custom.host` and `arch.metric` violations are the most exposed, because their snippets are **defaults**, not the violating line — `arch.metric` uses the file's first line (`evaluators.ts:297` ← `scanner.ts:359`) and `custom.host` falls back to the node's first line (`host-rules.ts:164`). Two over-long files sharing a license header or a common first import collide trivially.

### FRAGILE #8 — `arch.metric` fingerprints exclude the measured value, so baselined files can grow without bound

**File:** `packages/core/src/rules/evaluators.ts:283`
**Confidence:** Traced
**Breaks under this foreseeable change:** any file whose over-length was accepted once and that then keeps growing.

**Mechanism:** the fingerprint is `['metric', rule.id, node.file]` — no `value`, no `threshold`. Accept a 2,100-line file into the baseline and it stays accepted at 2,100, at 5,000, at 20,000. The ratchet that `computeBaselineDebt` reports (`check.ts:231-241`) counts *entries*, not lines, so the debt number never moves either.

This is defensible as "baseline means the human accepted that this file is over the limit," and it is consistent with `security.manifest.source-hygiene`, which deliberately excludes the specifier so a git-ref bump doesn't reset consent (`manifest-evaluators.ts:40-43`). But the two cases differ in kind: a git ref changing is not *more* debt, whereas a file doubling in size is. `arch.metric` was promoted precisely because two 2,100-line files were structurally invisible (`docs/ir-schema.md:12-13`) — and a baselined metric violation makes them invisible again.

**Fix: requires design work.** Any value-sensitive fingerprint (bucketing on `Math.floor(loc / 500)`, or folding in `threshold`) invalidates **every** existing `arch.metric` baseline entry (check 3 fails) and needs a policy decision on what re-accepting should mean — a question about product intent, not code. A lower-risk alternative worth evaluating first: keep the fingerprint stable and surface growth as an **advisory** (`gates/advisories.ts`) — "3 baselined metric violations grew by >20% since acceptance" — which changes no fingerprint and needs no re-accept.

---

## Already Guarded

Candidates that verification cleared, with the guard's location:

| Candidate | Guard |
|---|---|
| An `EditBlock` with an empty `search` matches at every offset; `findAllOccurrences` would return `text.length + 1` matches and a zero-width edit would be applied as an arbitrary insertion | `core/src/fix/schema.ts:15` — `search: z.string().min(1, 'search must be non-empty')` |
| Zero-length spans slip past `spansOverlap` (`a.start < b.end && b.start < a.end` is false when `start === end`), so two insertions at the same offset both apply | same `min(1)` guard — `endOffset = start + search.length` is always `> startOffset` |
| Two `EditBlock`s resolving to the same span both apply | `apply.ts:191-202` — sorted adjacent-pair overlap scan rejects the whole file patch |
| A component name containing `::` collides with `PAIR_SEP` in `ungoverned-edges.ts:33` | `core/src/types/ir.ts:12` — `^[A-Za-z][A-Za-z0-9_-]*$` |
| `arch.layers` ignores `edge.kind` on internal edges while gating external edges on `includeTypeOnly` | Documented at `evaluators.ts:79-81` and `226-241`. **Evidence correction:** the original entry claimed this was pinned by a named regression test; it is not. Re-attacked in the follow-up pass — a type-only *internal* import does produce a violation (`arch.layers`: 1, `arch.no-dependency`: 1, run against the real evaluators), and nothing user-facing promises otherwise (`docs/ir-schema.md:298-320` scopes `includeTypeOnly` to external selectors; `cli/src/skill/rule-kinds.ts:25` mentions it only for `arch.no-cycles`), so the OK verdict stands. But every `type-only` assertion in `core/test/evaluators.test.ts:120-357` covers no-cycles' exclusion or external opt-in — **none** asserts the internal behavior. Net: guarded by a comment, documented nowhere user-facing, tested by nothing. The undocumented asymmetry (type-only import of an external package is out of scope by default; of a sibling component is always a violation) is worth one doc sentence. |
| `external('fs')` matching the Node builtin as well as a hypothetical npm package named `fs` | Intentional, documented at `external-match.ts:6-14` as "an accepted, documented simplification, not a bug" |
| `computeBaselineDebt` fabricating a debt drop on an errored run | `check.ts:238` — explicit `verdict === 'error'` early return, with the failure it was written for documented at `231-237` |
| `readTelemetryState` treating a corrupt file as empty (the same shape as BUG #1) | Deliberate and justified in `align-dir.ts` — "a soft, regenerable cache … not a portable ruleset artifact whose silent loss would under-enforce a rule." Correctly distinguished from `readBaseline`, which is neither soft nor regenerable |
| `align init` writing to the user's **global** `~/.claude/CLAUDE.md` instead of the project's | Cannot happen — `writeAgentInstructions` builds its path as `path.join(rootDir, filename)` (`claude-md.ts:28`) and `rootDir` is only ever `process.cwd()`. No `homedir()`/`os.homedir`/`~` expansion anywhere in the write path. The file targeted is always project-local (which project is Needs-Review #2, but it is never the global one) |
| `align skill --install` clobbering human content, the same way BUG #10 does | Not applicable by design, and correctly reasoned: `writeSkillFile` (`skill/install.ts:47-55`) fully regenerates `.claude/skills/align/SKILL.md` on every run because the file is entirely align-generated. `install.ts:22-30` states the distinction from `claude-md.ts` explicitly — CLAUDE.md is human-owned and gets the preserve-around-the-block treatment; SKILL.md is not. Markers are retained there for debuggability only, and are never used to splice, so #10/#11/#12 do not reach it |

## Refutation Log

Findings and sub-claims killed in Step 5, and what killed them:

1. **"An empty `search` in an `EditBlock` inserts text at an arbitrary offset."** REFUTED — `fix/schema.ts:15` enforces `.min(1)`. I traced the exploit through `findAllOccurrences`' `from = idx + Math.max(search.length, 1)` before checking the schema; the schema makes it unreachable.
2. **"Zero-length edit spans bypass the overlap check."** REFUTED by the same constraint — a corollary of #1 that would have survived into the report had the schema not been read.
3. **"`WorkspacePackage.dir` may lack a trailing slash, so a `package:` selector prefix-matches a sibling directory (`packages/core` claiming `packages/core-utils/foo.ts`)."** REFUTED — `plugin-typescript/src/workspace.ts:88` normalizes unconditionally: ``dir: rel.endsWith('/') ? rel : `${rel}/` ``. This was the single producer of `WorkspacePackageIndex` (verified: `grep -rn "WorkspacePackageIndex|workspacePackages" packages/*/src` shows consumers only in `registry.ts`, producer only in `scanner.ts:111-113` from `loadWorkspacePackages`).
4. **"`computeBaselineDebt` reads the pre-frozen `run`, under-reporting debt under `--frozen-rules`."** REFUTED — the function's only verdict-sensitive branch is `verdict === 'error'` (`check.ts:238`), and `--frozen-rules` only ever flips `green → red` (`check.ts:99`), never to `error`. `run` and `effectiveRun` are indistinguishable to this function.
5. **"`persistMovedBaseline` can write a truncated baseline when the parse gate errored."** REFUTED — `applyMoves` deletes an entry only when it has a matched replacement to `set` (`store.ts:143-144`); unmatched orphans are pushed to `unmatchedOrphans` and left in the map by `reconcileMoves` (`store.ts:97-99`). `snapshot()` is never lossy on that path.
6. **"Tarjan propagates a child's lowlink to its parent before the SCC-root check, corrupting parent lowlinks."** REFUTED — that is classical Tarjan's order. When the child is an SCC root, `child.lowlink === child.index > parent.index`, so `Math.min` is a no-op. Traced against `tarjan.ts:51-57`.
8. **"A literal space in an exclude pattern becomes a wildcard" (BUG #4, divergence 3).** REFUTED **for `scanner.ts`** — but see the correction at the end of this entry, because the claim turned out to be true of a *different* copy I hadn't yet found. The failure mode was mine, not the code's. `globLikeMatch`'s intermediate placeholder for `**` is a literal **NUL byte**, not a space; `Read` and `cat -e` both render `\x00` as a space, and `od -c` on the pre-fix file confirms `'\0'`. NUL is unrepresentable in a real path, so the substitution is safe. The reason I reported it as real is that my empirical harness *retyped* the function by hand rather than importing it, and the retyped copy had a genuine space where the original had NUL — so the test that "confirmed" the bug was exercising my transcription. Re-run against the real implementation: `"test apps/**"` vs `"testXapps/secret.ts"` → `false` (correct), where my copy returned `true`. **Lesson for this report's methodology: an empirical check that copies code instead of importing it is not empirical about the code.** Divergences 1 (root-level `**/` misses) and 2 (no brace expansion) were re-verified against the real implementation and both hold, so BUG #4 stands — at two divergences, not three.

    **Correction to this refutation (found while implementing BUG #15):** the retraction was too broad. `doctor.ts`'s copy of the same function uses an ordinary **space** (`0x20`, verified by `od -c`) where `scanner.ts`'s used NUL — so the space-becomes-wildcard defect was **real**, just in a file the original finding never named. Net record: the claim was *false* for `scanner.ts` (BUG #4) and *true* for `doctor.ts` (BUG #15). It also means the two copies were never byte-identical, which is how I described them in both findings; they differed by exactly this one byte. Two lessons, not one: don't re-type code into a harness, and don't call two functions "identical" without diffing their bytes.

7. **Severity correction on BUG #6 (not a kill, a downgrade).** The original claim was "a silently partial fix ships green." Refuted in part: `run.ts:199-207`'s VERIFY step re-runs `align check` and only returns `done` when the touched files are clean, so a partial fix is caught and retried. The surviving mechanism — a partial edit set is *committed* (`run.ts:197`) before VERIFY, and attempts are burned — is real but is 🟢 Medium, not 🔴 Critical. Reported at its true severity.

## Needs Human Review

*(Needs-Review #1 from the original pass — the `extractCycleChainNodes` stranding question — was settled by the follow-up investigation and promoted to **BUG #9**.)*

1. **A workspace package at the repo root gets `dir: '/'` and matches zero files** — `plugin-typescript/src/workspace.ts:87-88`. When `abs === rootDir`, `path.relative` returns `''` and the trailing-slash normalizer produces `'/'`. `matchesSelector` (`registry.ts:33`) then tests `file === ''` (false) and `file.startsWith('/')` (false for every repo-relative path), so a `package:` selector naming the root package classifies nothing.

    **Confidence: Confirmed (empirical)** — mechanism and consequence both reproduced; what remains open is a product decision, not a fact.

    *Reachability is broader than the original pass estimated* — **four** declarations reach it, not two, verified against the real `loadWorkspacePackages`:
    ```
    npm  workspaces: ["."]     -> [{"name":"rootpkg","dir":"/"}]
    pnpm packages:   ["**"]    -> [{"name":"rootpkg","dir":"/"}]
    npm  workspaces: [""]      -> [{"name":"rootpkg","dir":"/"}]
    npm  workspaces: ["./"]    -> [{"name":"rootpkg","dir":"/"}]
    pnpm packages: [".", "packages/*"]  -> root AND packages/lib both listed
    ```
    `["**"]` via `collectPackageDirsRecursive` pushing its own base (`workspace.ts:132`); `["."]`/`["./"]` via `path.join(dir, '.')` normalizing back to `dir` (`workspace.ts:119`); `[""]` via an empty segment list leaving `currentDirs = [rootDir]` (`workspace.ts:109-125`).

    *The surfaced error is the confusing one*, confirmed end-to-end with the real CLI (`workspaces: ["."]` + a `package:rootpkg` selector):
    ```
      parse        ERROR
        Component 'main' (selector: package: rootpkg) matches zero files. Likely cause: its
        directory was renamed/moved or the selector is stale. ...
    verdict: error
    ```
    The package *is* in the inventory, so the accurate not-in-inventory error (`registry.ts:98-103`) never fires; the user gets `registry.ts:110-119`'s stale-selector blame instead. Default `empty` is `'fail'` (`ir.ts:36`, `dsl/index.ts:63`), so this is the default experience.

    **The open question is product intent, and the docs are silent.** ADR 003 (`docs/adr/003-components-registry.md:32-33`) pins only that a `package:` selector naming an *absent* package is an error; neither ADR 003 nor ADR 004 addresses root-as-workspace-member. Mitigating context: `align init` defaults to path-prefix components (ADR 003:63-64), so reaching this needs a hand-authored `package:` selector *and* one of the four declarations above — legal (npm single-package workspaces do this) but uncommon. Decide whether align supports a root workspace package before deciding whether this is a guard, a better error message, or documented-unsupported.

2. **Every command scopes to `process.cwd()`, with no repo-root detection and no signal when cwd isn't the root** — `packages/cli/src/program.ts`. `runInit(process.cwd(), …)` at `program.ts:59` (and the same at every other command: lines 86, 106, 119, 126, 134, 141, 159, 178, 219, 237, 257, 283) flows to `writeAgentInstructions(rootDir)` (`init.ts:82`) → `path.join(rootDir, 'CLAUDE.md')` (`claude-md.ts:28`).

    **Negative-claim receipt (rule 3):** `grep -rn "\.git\b|findUp|find-up|gitRoot|repoRoot|git rev-parse" packages/cli/src --include="*.ts"` (excluding `gitignore` hits) returns **nothing**. There is no repo-root discovery anywhere in the CLI, and `runInit` performs no sanity check on cwd.

    **Consequence:** `cd packages/web && align init` in a monorepo writes `packages/web/CLAUDE.md`, `packages/web/align.config.ts`, and `packages/web/.align/` — and the root `CLAUDE.md` never receives the block. Claude Code *does* read nested `CLAUDE.md` files, so the instructions land somewhere plausible but probably unintended, with no warning either way.

    **Why this is Needs-Review and not a bug:** it is self-consistent — the CLAUDE.md goes wherever the rest of the init goes — so per-package `align init` may well be a supported mode. The gap is that nothing distinguishes "I meant to init this package" from "I forgot to `cd ..`". Decide whether align is repo-scoped or directory-scoped; if repo-scoped, the fix is root detection plus a confirm prompt, and if directory-scoped, it needs one line of output naming the root it chose. Either way this is a product decision, not a defect. **Confidence: Traced** (three-line call chain, plus a verified absence).

    *(Cleared while investigating this: align never writes the user's global `~/.claude/CLAUDE.md` — every path is `rootDir`-relative. See the Already Guarded table.)*
