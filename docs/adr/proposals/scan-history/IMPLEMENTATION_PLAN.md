# ADR 029 — scan-observation history: staged plan

Transient. Delete this file when every stage is Complete. The permanent record is
[`docs/adr/029-2026-08-18-scan-observation-history.md`](../../029-2026-08-18-scan-observation-history.md);
the root `IMPLEMENTATION_PLAN.md` is the long-lived rules track and is **not** to be edited for this
work.

**Scope decision (2026-08-18):** this plan builds the **substrate only** — the record, its schema,
the probe, the invalidation rules, and the writer. **No consumer is wired.** ADR 029 §6's four
consumers are task #14 and land separately, because the one that matters (`store.applyMoves`, which
closes D015) is a change to a destructive inference and deserves its own red-before-green
reproduction rather than being folded into the substrate's diff.

*Stage 6 below records what task #14 actually found: the "retires ADR 006's 2026-08-18 amendment"
half of that sentence was wrong, and ADR 029 contradicted itself.*

Substrate-without-consumer is safe here for a reason specific to this design, not by luck: ADR 029
§5 makes the record admissible **only as a refusal**, so a record that nothing reads changes no
behaviour at all, and a record that is wrong can only ever add refusals once it is read. The cost of
shipping it a task early is one gitignored file per repository.

**Gate for every stage** — no stage is Complete until all of these are green:

```
pnpm build && pnpm typecheck && pnpm test                            # fast gate, run always
node packages/cli/dist/index.js check                                # red is blocking
node packages/cli/dist/index.js doctor                               # advisory only, exits 0
node integration/run.mjs --targets local                             # Docker, project `nest`
node integration/run.mjs --targets local --project nest-incomplete   # the ADR 023 tier-2 scenario
```

Both integration lines are required (CLAUDE.md): `run.mjs` filters by project and the first line
alone silently skips every scenario declared against another project.

---

## Four gaps in ADR 029 found by defining the work

Recorded here before any code, because three of them change the record's shape and the fourth
changes a stated rule. Each is amended into ADR 029 itself in Stage 5 — this file is transient and
must not become the only place a decision lives.

1. **§4's invalidation predicates need data §2's record does not carry.** "`known: false` when the
   cited rule's definition changed" and "when `c`'s selector changed" are both *comparisons*, and
   the record holds only one side of each. The record must therefore also carry a per-rule
   definition hash and a per-component selector hash. §2's six-field table cannot implement §4 as
   written.

2. **A component's match count is not a function of its own selector alone.** Classification is
   first-match-wins, so an *earlier* component's selector change silently moves a later component's
   count — the shadowing case `validateClassifiedComponents` exists to catch. Invalidating
   `observedMatchCount(c)` on "c's selector changed" would therefore leave a stale count admissible.
   The record carries a **prefix hash**: for each component, a hash over the ordered
   `(name, selector)` list up to and including it. Any change that could move `c`'s count
   invalidates `c`; an unrelated component declared *after* `c` does not.

3. **§7.4's "a corrupt record throws" is the wrong rule for this file, and it is the second time
   this project has made that exact mistake.** The discipline is real and belongs to
   `.align/baseline.json`, which holds irreplaceable human consent — there, corrupt-read-as-empty
   destroys data (BUG #1). `.align/last-scan.json` is a gitignored, machine-local cache align
   creates and replaces on its own schedule, holding nothing a human authored, and reading it as
   absent yields `known: false`, which §5 defines as *today's behaviour*. Throwing instead makes an
   unreadable file that the user cannot see in `git status` fail every `align check` until they
   delete it by hand. That is precisely the failure ADR 030 §4 was amended for, one day earlier,
   about `.align/.lock`: *never-break is the unsafe direction for a file align owns.* The record
   reads as absent and says so once on stderr. **Ledger row required** — see Stage 5.

4. **MCP's `align_check` must write the record; ADR 029 §7.3 names only `check`.** §7.3's damage
   argument is sound but its enumeration is not: the hazard is a surface that moves the temporal
   reference forward *without having made a transfer decision against it* (`doctor` scanning before
   `check` runs). `align_check` over MCP consults the same store, runs the same `reconcileMoves`,
   and persists the same transfer — it is a `check`, and it is the surface an agent-only workflow
   uses exclusively. Excluding it would leave the mechanism permanently inert for align's stated
   primary consumer. The sharpened rule:
   **a surface writes the record if and only if it consulted the record for a transfer decision.**
   Nothing enforces that structurally — it is three call sites placed by hand — so it is pinned by
   test instead, at both levels: `scan-observation-write.test.ts` asserts `doctor` neither creates
   the record nor advances one, and `scan-history-record-written.mjs` asserts the same for `init`
   and `doctor` against real binaries. Say "pinned", not "by construction"; the difference is
   whether the next writer has to remember.

---

## Stage 1: The record, its schema, and its persistence

**Goal**: `.align/last-scan.json` can be written and read; a corrupt one reads as absent, loudly.

**Work**
- `packages/core/src/types/scan-history.ts` — `ScanObservationRecord`, `Recalled<T>`,
  `ScanHistoryProbe`, and the zod schema (`scanObservationRecordSchema`). Core owns wire schemas
  (`baseline/schema.ts` precedent); core stays `node:fs`-free.
- `packages/cli/src/align-dir.ts` — `lastScanPath`, `readLastScanRecord`, `writeLastScanRecord`.
  Atomic (`writeFileAtomic`), **no token and no lock**: this is a regenerable cache, and ADR 030's
  closing section already scopes the expensive guarantee to `baseline.json`.

**Success Criteria**: absent → `undefined`; corrupt JSON → `undefined` + one stderr line naming the
file; schema-invalid → same; a round-trip preserves every field.

**Tests**: `packages/cli/test/last-scan-record.test.ts`, and a core schema test.

**Status**: Complete

---

## Stage 2: The run carries what only the orchestrator knows

**Goal**: `CheckRun` carries the two facts the record needs and nothing else has: every violation
the scan reported (baselined **or not**), and each component's match count.

`GateResult.violations` is the **not-baselined** subset, so the full list exists nowhere outside
`orchestrator.check`'s locals today. ADR 029 §2 requires all of them deliberately: a violation's
being baselined is a property of the baseline at write time, and a record whose contents shifted
when someone ran `baseline accept` would answer a *different* question on the next run.

**Work**
- `CheckRun.observedViolations: readonly ObservedViolation[]` — `{ file, ruleId, contentFingerprint }`.
- `CheckRun.componentMatchCounts: ReadonlyMap<ComponentName, number>`.
- Both added to `untrustworthyScanScope()`'s `Pick`, so the compiler enumerates every errored-run
  early return and each one zeroes them — the same discipline `blindSpots`/`observedFiles` already
  hold, for the same reason (an errored run knows nothing about scan scope).
- `docs/core-interfaces.md`'s `CheckRun` block, which `core-interfaces-doc.test.ts` enforces.

**Success Criteria**: a baselined violation appears in `observedViolations` and not in
`gates[].violations`; every error path reports both fields empty.

**Tests**: `packages/core/test/orchestrator.test.ts` additions.

**Status**: Complete

---

## Stage 3: Scope identity, definition hashes, and the probe

**Goal**: `createScanHistoryProbe` answers ADR 029 §3's four questions under §4's invalidation.

**Work**
- `packages/core/src/baseline/scan-history.ts` — `computeScopeIdentity`, `computeRuleDefinitionHashes`,
  `computeComponentSelectorHashes` (the prefix hash of gap 2), and `createScanHistoryProbe(record, current)`,
  pure and fs-free. The CLI supplies the record; core does the reasoning, the same seam as
  `FileExistenceProbe`.
- The probe is constructed from a **required** `ScanHistoryContext`, not an optional one — S-09.

**Success Criteria**: each of the four questions returns `known: false` under exactly its own
invalidation predicate and stays `known: true` under the others; a hand-crafted record cannot
produce a `known: true, value: false` that authorizes anything (§5, asserted as a test, not a
comment).

**Tests**: `packages/core/test/scan-history-probe.test.ts`.

**Status**: Complete

---

## Stage 4: `check` writes it

**Goal**: both `align check` arms and MCP `align_check` persist the record; nothing else does.

**Work**
- `buildScanObservation(run, context)` in core; `persistScanObservation(rootDir, ...)` in the CLI.
- Conditional on change (§7.1): `observedAt` excluded from the comparison.
- Never fatal (§7.2): a failed write is one stderr line, never an exit code.
- `init/gitignore.ts`: `ensureTelemetryGitignored` → `ensureAlignLocalFilesGitignored`, plus the new
  entry. align's own `.gitignore` too — this repo dogfoods align.

**Success Criteria**: a second identical `check` does not rewrite the file (mtime + inode stable);
a read-only `.align/` still exits 0 with the same verdict; `doctor`, `build`, `explain`, `init`,
`agent run` and `upgrade` write nothing.

**Tests**: `packages/cli/test/scan-observation-write.test.ts`.

**Status**: Complete

---

## Stage 5: The standing rules

**Goal**: ADR 026 write-sets, an ADR 025 scenario, and the amendments this plan owes ADR 029.

**Work**
- `.align/last-scan.json` added to the write-set of every scenario that runs `align check`
  (11 measured 2026-08-18) — the write-set mechanism working as designed, not a workaround.
- New scenario `scan-history-record-written.mjs`: the record appears, is gitignored by `init`, and a
  corrupt record does not fail the run.
- ADR 029 amendments for all four gaps above; `docs/adr/defects/LEDGER.md` row for gap 3.
- `docs/core-interfaces.md` if any new interface belongs there.

**Success Criteria**: both integration lines green; the release-gate matrix still fails on 0.1.4 for
all seven `expectFailOn` scenarios.

**Measured on completion (2026-08-18)**: nine existing scenarios failed on the write-set check with
exactly `.align/last-scan.json (added)` and zero step failures — ADR 026's mechanism working as
designed, not a workaround — and each declares it now. One new scenario,
`scan-history-record-written`, red-before-green measured: with ADR 029 §7.4 implemented as written
(corrupt throws), step 15 loses its warning and step 16 finds the truncated record still in place.

**Status**: Complete

---

## Stage 6: The first consumer — `store.applyMoves` (task #14)

**Goal**: close LEDGER D015, the last open severity zero, by giving `applyMoves` the temporal
reference it needs to tell a rename from a forgery.

**A fifth gap in ADR 029, found the same way the first four were.** §6 licenses this consumer to
*retire* ADR 006's whole-directory rename exception. §5, sixteen lines earlier, forbids exactly that:
history is admissible as a refusal, never as a permission. Retiring the exception means allowing a
transfer that is refused today, and the only fact available for it is
`wasViolationObservedAt(candidate) === false` — an absence, which cannot separate "the candidate did
not exist last scan" from "last scan never looked there". Recorded as **LEDGER D023** ([S-10], third
instance and the first found in a design document); ADR 029 §6 and ADR 006 are both amended, and
`orchestrator.test.ts`'s comment withdraws its own revert instruction rather than deleting it.

**Work**
- `InMemoryBaselineStore` takes a `ScanHistoryProbe` as a REQUIRED third constructor argument — the
  `fileExists` discipline, for the same reason: a default would compile everywhere and silently
  reopen D015. `noScanHistory()` is the named answer for a site that has none.
- `applyMoves` filters candidates by `alreadyObservedViolating`, per candidate rather than per orphan.
- `openScanHistory(rootDir, …)` reads the record ONCE per run and hands out the probe, the context and
  the previous record; `persistScanObservation` takes that object instead of re-reading.
- Every CLI store — `check` (both arms), MCP `align_check`, `init`, `agent run`, `upgrade` (including
  its prune preview, which must reason from the SAME probe) and `baseline prune` — consults it. Only
  the surfaces that persist a transfer write it, which corrects §7.3's "if and only if" to
  "write ⇒ consulted"; §7.3 already named `upgrade` as its own counter-example.

**Success Criteria**: the D015 recipe stays red; a genuine rename still transfers; no record ⇒
byte-identical behaviour to before ADR 029.

**Tests**: `core/test/scan-history-move-refusal.test.ts` (10, incl. the defect reproduced under
`noScanHistory()` as calibration), `cli/test/d015-move-forgery.test.ts` (3, real command),
`integration/scenarios/scan-history-refuses-forged-transfer.mjs` (12 steps,
`expectFailOn: ['0.1.4']` measured — 0.1.4 lands `acceptedBy: manual` on the never-reviewed bait at
exit 0).

**Status**: Complete

---

**This file is transient and every stage is now Complete.** Delete it; the permanent record is
ADR 029, ADR 006's amended section, and LEDGER D021/D023.
