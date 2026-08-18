# ADR 029: align Remembers What It Observed

**Status**: Accepted (contract) — **nothing ships in 0.2.0.** The record's shape, and the rules
governing what may be inferred from it, are decided here because the consumers are the dangerous
part: four of them already exist, three of them are destructive, and every one of them is currently
guessing. Deciding the contract before the code is written is what stops the mechanism built to cure
[S-10] from being another instance of it.

## Context

### One blind spot with seven faces

`docs/adr/defects/LEDGER.md` holds 18 rows (recounted 2026-08-18 at D018; the ledger grows, so treat
this figure as dated rather than current). **Seven entries turn on the same missing fact, and they
include four of the ledger's five severity zeros** — every S0 except D018, whose amnesia is about
concurrent writers rather than about what a scan saw. The first draft said "five of seven", which
counted ADR 027 F1 as a ledger row; it predates the ledger and is listed below without an ID:

| Row | Sev | The question align could not answer | Direction |
|---|---|---|---|
| D015 | **S0** | was this transfer target already violating before the source vanished? | closed by this ADR |
| D010 | **S0** | same question, directory-granular | closed by this ADR |
| — (2026-08-13, ADR 027 F1) | **S0** | same question, its first appearance | closed by this ADR |
| D011 | **S0** | was this component grounded last scan? | closed by this ADR |
| D001 | **S0** | partial checkout, or deliberate deletion? | *sharpened, not closed* |
| D008 | S1 | the same question, opposite direction | *sharpened, not closed* |
| D009 | S2 | did the scan's scope change under me? | **not closed** (see below) |

This is not seven bugs. It is one property: **every align run is amnesiac.** A scan is compared
against the baseline — a record of accepted *violations* — and against nothing whatsoever on the
question of what the scan itself saw. Absence is then read as evidence, which is the precise
inference ADR 028 exists to refuse. Read in that light, ADR 028's three retention mechanisms are
each an attempt to recover, from a single snapshot, a fact that only exists across two.

The pattern was visible one day after `docs/adr/defects/LEDGER.md` was created, to a human reading
it. That is the ledger working as designed: a shape becomes visible when its instances sit next to
each other rather than scattered across seventy files.

### Why git is not the answer

Git is genuinely good at the file-level half. A partially-checked-out file is tracked-but-absent
from the worktree; a deleted one is not; rename detection is native; and it works on a fresh CI
clone where no local history exists.

It cannot answer D009 or D011, and those are the half that motivated this. Those are not changes to
files — they are changes to **what align looks at**: an `excludes` pattern, a component selector,
the scanner's extension set, a plugin version. Git has no idea align exists. Only align can record
align's own scope.

That asymmetry decides the shape of the record: it is a record of **align's observation**, not of
the filesystem and not of the repository. The distinction is load-bearing and recurs below — a
consumer must always be able to say which of the two it is relying on.

## Decision

### 1. The record is align's own observation, kept for exactly one scan, machine-locally

**`.align/last-scan.json` records what the immediately preceding scan of this repository, on this
machine, by this version of align, observed.** It is gitignored: `.align/` as a whole is not
(`baseline.json` is a committed consent record), so the record needs its own entry, which widens
`init/gitignore.ts`'s `ensureTelemetryGitignored` past telemetry and renames it.

Gitignored **for identity, not for churn.** Diff noise would be a cost argument; this is a
correctness one. A record written on machine A is not evidence about machine B's checkout — sparse
checkouts, partial clones, case-sensitivity of the volume, and an uninstalled workspace all change
what a scan legitimately observes. Committing the record would let one machine's observation
authorize another machine's deletion, which is [S-10] with a version-control system in front of it.

**N = 1.** Every question below is "compared with the immediately preceding scan." A deeper history
buys trend analysis that no consumer has asked for, and multiplies the "which record is
authoritative" problem this ADR exists to keep small. Raise N when a consumer needs it, not before.

### 2. What the record holds

| Field | Why |
|---|---|
| `alignVersion` | the scanner's extension set and walk rules are version-dependent |
| `scopeIdentity` | hash over the effective `excludes` and scan-root configuration |
| `observedAt` | reporting and staleness only; never an input to an inference |
| `observed.source` / `observed.manifest` | repo-relative paths, per scan domain (ADR 013) |
| `components[name].matchCount` | how many files each component's selector matched |
| `violations[]` | `{ file, ruleId, contentFingerprint }` for every violation the scan reported, baselined or not |

`violations[]` is the field that closes the severity zeros, and it is the one the earlier draft of
this design omitted. The sound test for a forged transfer is *"was this candidate already violating,
at this path, last scan?"* — if it was, it predates the source file's disappearance and cannot be
where that violation moved to. That test needs violation identity across scans, which is exactly
`contentFingerprint` (FRAGILE #7) and nothing more. It is bounded by violation count, not file
count, so it is cheap on the repos where it matters least and proportionate where it matters most.

**Deliberately excluded**, each having been proposed and rejected:

- **Per-file content fingerprints.** They would establish a second file-identity system alongside
  FRAGILE #7's, free to disagree with it, for 44% more bytes (measured below) and no question in
  §3 that needs them.
- **A whole-ruleset hash.** A single global hash forces all-or-nothing invalidation: edit one rule
  and every unrelated answer is discarded. Per-question invalidation (§4) is strictly better, and
  the coarse version's real hazard is that its false discards teach callers to ignore it.
- **Git HEAD.** Recording it invites consumers to reason about repository state from align's
  observation record, collapsing the very distinction §Context draws. It is also absent in a
  non-git checkout, so no consumer could depend on it anyway.

### 3. Consumers ask questions; nobody reads the record

An injected probe, following `FileExistenceProbe`: `packages/core` stays filesystem-free, the CLI
supplies the implementation, and consumers ask narrow, named questions.

```ts
export type Recalled<T> = { readonly known: false } | { readonly known: true; readonly value: T };

export interface ScanHistoryProbe {
  wasFileObserved(file: RepoRelativePath): Recalled<boolean>;
  wasViolationObservedAt(file: RepoRelativePath, ruleId: RuleId, fingerprint: string): Recalled<boolean>;
  observedMatchCount(component: ComponentName): Recalled<number>;
  previousScopeIdentity(): Recalled<string>;
}
```

Two details are not stylistic:

- **`Recalled<T>` is a discriminated union, not `boolean | 'unknown'`.** A three-state answer
  encoded as a string makes `if (probe.wasFileObserved(f))` compile and read `'unknown'` as *true*;
  encoded as `undefined` it reads as *false*. Either way a caller who forgets the third state gets
  a silent wrong answer, and in half the call sites the wrong answer is the destructive one. The
  union cannot be consumed without discriminating, and the repo's `never`-arm exhaustiveness
  invariant covers the rest.
- **`observedMatchCount` returns a count, not `wasGrounded`.** "Matched 12 files last scan, 0 now"
  and "matched 0 last scan, 0 now" are different situations and only the first is a regression. The
  count answers the boolean question and more, at identical cost.

### 4. Validity is a property of the question, not of the record

The probe — never the caller — decides whether a recorded fact is admissible for the inference the
question exists to serve, and returns `known: false` when it is not.

| Question | `known: false` when |
|---|---|
| `wasFileObserved` | `alignVersion` differs, or `scopeIdentity` differs |
| `wasViolationObservedAt` | `alignVersion` differs, or the cited rule's definition changed |
| `observedMatchCount(c)` | `c`'s selector changed, or `scopeIdentity` differs |
| `previousScopeIdentity` | the record is absent or unreadable |

A single global staleness flag would discard all four answers whenever any one of them went stale.
Per-question invalidation keeps the answers that are still sound, and — more importantly — keeps the
invalidation predicate small enough that each consumer's author can check it.

### 5. History is admissible as a refusal, never as a permission

**The doctrinal core of this ADR.** A consumer may use the history to *decline* a destructive
inference it would otherwise make. It may never use the history to *authorize* one it would
otherwise decline.

This is not conservatism for its own sake; it follows from what the record can prove. "This
violation was observed here last scan" is a positive fact that soundly refutes a move. "This file
was not observed last scan" proves only that align did not see it — never that it was absent. The
first supports a refusal; the second supports nothing. Every question above is therefore wired so
that `known: false`, a stale record, and a missing record all collapse to today's behaviour **by
construction rather than by each caller remembering to**.

The rule also disposes of the obvious objection to the whole design: a mechanism that could only
ever add refusals cannot introduce a false green, whatever state the record is in.

### 6. What each consumer is licensed to do

- **`store.applyMoves` (D010, D015, ADR 027 F1) — refuse.** Before transferring an accepted entry
  onto a candidate violation, ask `wasViolationObservedAt(candidate)`. `known: true, value: true`
  ⇒ the candidate predates the disappearance ⇒ refuse the transfer, leaving the entry at its
  original path. This **retires ADR 006's 2026-08-18 amendment**: the refusal becomes
  violation-precise instead of directory-granular, so an ordinary whole-directory rename transfers
  again, and `packages/core/test/orchestrator.test.ts`'s "a manifest whose whole directory is
  absent no longer transfers" goes back to asserting a transfer, as its comment already instructs.
- **`store.prune` retention (D001, D008) — retain only.** The history may add retention; it may
  never license a deletion. `wasFileObserved` returning `known: true, value: false` for a file the
  baseline names is a reason to retain and report, never a reason to prune. **ADR 006's consent
  gate stays** — see §"What this does not close".
- **Component grounding (D011) — report.** "Component `api` matched 12 files last scan and 0 now"
  replaces a generic incompleteness refusal with an actionable one. The ADR 023 tier-2 refusal
  itself is unchanged; only its message improves.
- **Scope change (D009) — report the narrowing direction only.** See below.

### 7. Writing it is conditional, and never fatal

`align check` becomes a writer on more runs than it is today, where it writes only when
`persistMovedBaseline` has something to persist. Four constraints:

1. **Write only when the observation changed** — the path sets, the match counts, or the violation
   identities. `observedAt` is excluded from that comparison, so an unchanged repository does not
   rewrite the file on every check.
2. **A failed write is never a failed check.** Read-only filesystems and sandboxed CI are ordinary.
   The write is best-effort; the next run reads `known: false` and behaves as align does today.
3. **Only `check` writes it.** `explain`, `build`, `doctor`, `init` and `agent run` each scan
   directly (verified 2026-08-18: those five are the only files under `packages/cli/src/commands/`
   referencing `scanner.scan`), and any of them writing the record would move the temporal reference
   forward without a transfer decision having been made against it. The concrete damage is a **false
   refusal**: run `align check` after a rename and the transfer is allowed, but run `align doctor`
   first and the record already shows the violation at its new path, so `check` refuses a legitimate
   rename. ADR 006's asymmetry makes that the survivable direction — loud and one `baseline accept`
   from resolved — but it is a real regression and the narrow writer avoids it.
4. **A corrupt record throws; it never reads as empty.** BUG #1 is the precedent — a corrupted
   `.align/baseline.json` read as `[]`, and the next full-snapshot write destroyed every accepted
   entry. Same discipline, no exceptions.

This makes the known non-atomic `.align/` write (full-snapshot `writeFileSync`, no temp-and-rename,
no lock — recorded in ADR 028's closing section) a **prerequisite** of implementation rather than a
nicety, because `check` gains a second artifact it writes on a schedule the user does not control.

### 8. Ships under the standing rules

ADR 026 (a declared write-set naming `.align/last-scan.json`) and ADR 025 (an integration scenario)
apply, and per CLAUDE.md rules 1 and 2 the feature is not complete without them. At minimum the
scenario must cover: no record → today's behaviour; a record from a different `scopeIdentity` →
today's behaviour; and the D015 reproduction staying red.

## What this does not close

Recorded explicitly because the proposal this ADR supersedes claimed more, and a reader who adopts
the claim rather than the mechanism will build on sand.

- **D001 and D008 remain ambiguous.** History says a directory was observed last scan and is absent
  now. A deliberate deletion says exactly the same thing. What history adds is the ability to
  distinguish *absent and previously observed* from *absent and never observed*, and to make the
  breadth heuristic sharper — not to make it sound. **The ADR 006 consent gate on prune deletions
  is not made redundant by this ADR** and must not be removed on its authority.
- **D009 is not closed.** History detects scope **narrowing** — files observed before, not now. It
  cannot detect **widening**, which is D009's actual direction: a file that enters the scan for the
  first time is indistinguishable from a file that was just written. D009 needs a different
  instrument (a declared expectation about scope, or review of `excludes` changes), and this ADR
  does not provide one.
- **It is not authority it has not earned.** The record says what align *observed*. That is not
  what *existed*. Every consumer must be able to state which of the two it relies on, and §5 exists
  so that the answer is always "the former, and only to refuse."

## Consequences

- Three severity-zero rows (D010, D015, and ADR 027's F1) get a sound fix rather than a mitigation.
  D015 is today detection-only: `describeMovedEntries` reports the transfer, and the forgery still
  happens and still exits 0.
- ADR 006's rename guarantee is restored unconditionally, and its 2026-08-18 amendment is retired.
- `align check` acquires a second `.align/` artifact and a soft write path, gated behind the
  atomic-write work.
- A new subsystem's worth of surface — probe, record schema, invalidation, four consumers — enters a
  codebase where the same subsystem's absence has produced five severity zeros. That trade is the
  decision.
- The developer-harness proposal (`docs/adr/proposals/developer-harness/PROPOSAL.md`) assumes an
  "align remembers" substrate; this is it.

## Alternatives considered

- **Git as the provider, or as a second provider behind the same interface.** Rejected for v1. Git
  answers a different question (what the repository records) than the history (what align observed),
  and putting both behind one interface destroys the caller's ability to say which authority it
  relied on — the distinction §Context and §5 are built on. A git-backed probe remains possible
  later as an explicitly separate, separately named instrument.
- **Committing the record.** Rejected on identity grounds (§1), not diff-noise grounds.
- **Keeping three to five scans.** Rejected: no consumer question spans more than one scan, and
  every additional record is another thing that can be stale, wrong, or authoritative-looking.
- **Deriving the fix from a bigger single snapshot** — more retention mechanisms in ADR 028's
  style. Rejected: ADR 028 already demonstrates the ceiling. Mechanisms 1–3 are each a heuristic
  substitute for a fact that is not in the snapshot, and D008 is the measured cost of the third one
  overreaching.
- **Doing nothing and living with the mitigations.** Rejected on D015: a command that carries a
  human's consent onto an unreviewed violation and exits 0 is the project's severity-zero class,
  and its only current defence is a human reading an advisory.

## Evidence

- Ledger arithmetic: 19 data rows, 7 marked S0, counted from `docs/adr/defects/LEDGER.md` in this
  session. The seven amnesia rows are D015, D010, D011, D009, D008, D001 and the undated 2026-08-13
  ADR 027 F1 row; five of those are S0.
- **Record size, measured on align's own repository 2026-08-18** against the built scanner
  (`packages/plugin-typescript/dist/scanner.js`) using the seven `excludes` patterns reported by a
  live `align check --json`: **318 distinct observed source paths**, none outside the repo tree.
  Serialized paths-only with provenance: **13,683 bytes (13.4 KiB), 43.0 bytes per observed file**.
  Linear extrapolation on bytes-per-file to a 50,000-file monorepo: **2.05 MiB**, uncompressed —
  affordable as a machine-local cache, which is the only place this ADR puts it. Adding a
  16-hex-char `contentFingerprint` per observed file (the width measured from this repo's
  `.align/baseline.json`) gives **19,725 bytes, 44% larger** — the number §2 rejects it on.
  The violations axis is bounded by violation count, not file count: 29 baselined entries on this
  repository.
- D015 reproduction (2026-08-18, measured): baseline `src/api/old.ts`, add a content-identical
  never-reviewed violation at `src/api/new.ts` (red), delete `old.ts` — a plain `align check` goes
  **green** with `acceptedBy: manual` sitting on the unreviewed violation, exit 0.
- The temporal test this ADR implements is already named as the fix in two places written before
  it: `docs/adr/006-2026-07-11-baseline.md` ("the match target was already observed last run") and
  `packages/core/src/baseline/scan-blind-spots.ts`'s `describeMovedEntries` doc comment.
- Related: ADR 028 (absence is not evidence — the class), ADR 027 (scan-scope changes are never
  local), ADR 006 (baseline consent, move transfers, and the amendment this retires), ADR 023
  (refusal tiers), ADR 013 (scan domains), ADR 026 (declared write-sets), ADR 025 (integration
  harness). Superseded proposal: `docs/adr/proposals/scan-history/PROPOSAL.md`.
