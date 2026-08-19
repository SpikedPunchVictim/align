# ADR 029: align Remembers What It Observed

**Status**: Accepted (contract) — **nothing ships in 0.2.0.** The record's shape, and the rules
governing what may be inferred from it, are decided here because the consumers are the dangerous
part: four of them already exist, three of them are destructive, and every one of them is currently
guessing. Deciding the contract before the code is written is what stops the mechanism built to cure
[S-10] from being another instance of it.

## Context

### One blind spot with seven faces

`docs/adr/defects/LEDGER.md` holds 20 rows (recounted 2026-08-18 at D020; the ledger grows, so treat
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
`init/gitignore.ts`'s `ensureTelemetryGitignored` past telemetry and renames it (done:
`ensureAlignLocalFilesGitignored`).

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

*Amended 2026-08-18, while implementing it.* **The table above cannot implement §4.** Two of the four
invalidation predicates below — "the cited rule's definition changed", "`c`'s selector changed" — are
*comparisons*, and a record holds only one side of a comparison. The record therefore also carries:

| Field | Why |
|---|---|
| `recordVersion` | a record whose shape a reader does not recognise must fail to parse rather than answer questions from fields that no longer mean what they meant. ADR 028's Consequences recorded the cost of `McpCheckPayload` having no such field; this is that lesson applied before the fact, for twenty bytes |
| `ruleDefinitions[ruleId]` | a hash of each rule's definition, **provenance excluded** — `because`/`sourceFile`/`sourceLineRange`/`sourceQuote` cannot change what a rule matches, and `sourceLineRange` moves whenever anyone edits a line *above* the rule in a doc-built ruleset, which would silently disarm the mechanism on edits that changed nothing |
| `components[name].selectorIdentity` | see the §4 amendment: a **prefix** hash, not a hash of the component's own selector |

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

### 2.1 Retained evidence — added 2026-08-19, [D030]

The record carries a second, smaller list beside `violations`: **`retained`**, observations an earlier
scan made that this one could not, kept while they still bear on an unresolved baseline entry.

**Why §2 as first written could not work.** §6's refusal requires the previous scan to have observed
the orphan violating at its own path AND the candidate at its — coexistence is the whole content of
"the candidate predates the disappearance". But the run that first refuses also *rewrites* the record,
and by then the orphan's file is deleted and therefore unobserved. The evidence justifying the refusal
is destroyed by the very run that acts on it. Measured on the real command: `check#1` exit 1 with the
consent held, **`check#2` exit 0 with `acceptedBy: manual` re-homed onto the never-reviewed
violation**, `check#3` green. The refusal survived exactly one run; D015 was delayed, not closed.

**A separate field, not merged into `violations`.** `violations` means *what this scan observed* and
must keep meaning exactly that — a carried-forward fact is not an observation this run made, and
writing it there would make the record lie about its own provenance. `wasViolationObservedAt` consults
the union, because for its question both are equally sound evidence about the past.

**It converges, and the bound is the baseline rather than a timer.** An observation is retained only
while a current baseline entry names exactly that violation at exactly that path. Accepting the
candidate, pruning the orphan, or restoring the file each end it on the next write. There is no cap
and no age rule — an age rule here would be the time-based admissibility §2 already refuses.

**The cost, stated rather than discovered.** A stale record now refuses persistently instead of
self-healing after one cycle, and the case where that shows is a **branch switch**: `baseline.json` is
committed and travels with the branch, `last-scan.json` is gitignored and does not, so after a
checkout align holds evidence about a tree that is no longer there. Measured before retention landed,
that case healed itself in one red cycle; it now stays red until a human accepts. That is deliberate,
because the branch-switch case and the D015 forgery are *indistinguishable to align* — both are "the
record says these coexisted; the orphan's file is gone" — so evidence that sticks for one sticks for
both. ADR 006's asymmetry decides it the same way it decided the original: a missed transfer is loud
and one `align baseline accept` from resolved; a forged one is silent and destroys a consent record.

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

*Amended 2026-08-18, while implementing it.* Two rows above are wrong as written.

**`observedMatchCount(c)` — "`c`'s selector changed" is not sufficient.** Classification is
first-match-wins in declaration order (`components/registry.ts`'s `classifyFile`), so changing an
*earlier* component's selector moves `c`'s count without touching `c`'s own definition — the exact
shadowing case `validateClassifiedComponents`' error message names. The recorded identity is
therefore a hash over the ordered `(name, selector)` list **up to and including** `c`: anything that
could move `c`'s count invalidates it, and a component declared *after* `c` does not. That is
strictly more precise than the whole-registry hash and strictly sounder than the per-component one.

**`wasViolationObservedAt` is deliberately NOT gated on `scopeIdentity`,** and the asymmetry with
`wasFileObserved` is the point. This question's `true` is a *positive observation* — a violation of
this rule, with this content, was reported at this path — and narrowing or widening the scan cannot
make a violation align actually reported stop having been reported. `wasFileObserved`'s `false`, by
contrast, is an inference from absence, and a scope change is exactly what empties that absence of
meaning. Gating both identically would discard the sound answer in order to protect the unsound one.

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
  original path. ~~This **retires ADR 006's 2026-08-18 amendment**: the refusal becomes
  violation-precise instead of directory-granular, so an ordinary whole-directory rename transfers
  again, and `packages/core/test/orchestrator.test.ts`'s "a manifest whose whole directory is
  absent no longer transfers" goes back to asserting a transfer, as its comment already instructs.~~

  ***The refusal shipped 2026-08-18 and closes D015. The retirement is struck: it contradicts §5,
  and this ADR did not notice*** (LEDGER D023). Wiring the refusal is sound and measured — with it
  removed, the reproduction exits **0 green** with a human's `acceptedBy: manual` sitting on a
  never-reviewed violation (`packages/cli/test/d015-move-forgery.test.ts`). Retiring ADR 006's
  exception is the opposite operation: *allowing* a transfer that is refused today. The only fact
  the record offers for it is `wasViolationObservedAt(candidate) === false`, and an absence from the
  record cannot separate "the candidate did not exist last scan" (rename) from "last scan never
  looked there" (partial checkout, blind spot) — which is the exact distinction ADR 006's exception
  exists to make. `wasFileObserved` cannot stand in: for a genuine rename the candidate's file is
  new, so a positive observation of it is what a rename does *not* produce. §5 already names this —
  *history is admissible as a refusal, never as a permission* — so §6 as written contradicted §5 two
  sections later.

  Worse, the regression would land in the defect's own habitat: the record is gitignored and
  machine-local (§1), so a fresh CI checkout has none, the new refusal cannot fire there, and only
  ADR 006's exception stands between D010 and a green exit 0. What would actually retire it is
  evidence of a file's past NON-EXISTENCE — which git has and this record structurally cannot hold.
  See [ADR 006's amended section](006-2026-07-11-baseline.md#this-exception-was-intended-to-be-temporary-it-is-not).
- **`store.prune` retention (D001, D008) — retain only.** The history may add retention; it may
  never license a deletion. `wasFileObserved` returning `known: true, value: false` for a file the
  baseline names is a reason to retain and report, never a reason to prune. **ADR 006's consent
  gate stays** — see §"What this does not close".

  *Qualified 2026-08-18, while implementing the `applyMoves` consumer above.* "Never license a
  deletion" is true of THIS consumer and false of the ADR as a whole, and the difference is a
  consequence of `reconcileMoves` and `prune` sharing `applyMoves`. An orphan with no move match is
  left alone by the first and DELETED by the second, so the `applyMoves` refusal — running inside
  `prune` — converts a transfer into a deletion. That outcome is correct (the orphan's file is
  genuinely absent, all three ADR 028 mechanisms have already declined, and removing entries for
  violations that are gone is what `prune` is for, behind consent and ADR 023's guards) and it is
  strictly better than the forgery it replaces, but it is a destructive consequence of consulting the
  history and this ADR should not be read as promising there are none. Pinned deliberately by
  `core/test/scan-history-move-refusal.test.ts`.
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

   *Amended 2026-08-18, while implementing it.* The damage argument is right; the enumeration is not.
   The hazard is a surface that moves the reference forward **without having made a transfer decision
   against it**, so the rule is: ~~a surface writes the record if and only if it consulted the record
   for a transfer decision.~~ **a surface writes the record only if it consulted the record for a
   transfer decision.**

   ***The biconditional was struck later the same day***, by adversarial review, and this paragraph
   contained its own counter-example two sentences on: `align upgrade` consults for a transfer decision
   and deliberately does not write. `baseline prune` is a second — `store.prune` runs `applyMoves`, so
   it consults and does not write either. Consulting is what makes the D015 refusal exist and is
   available to any surface; WRITING is the half that moves the temporal reference forward for everyone
   after it, and it is the half this rule restricts. A doctrine contradicted by the adjacent sentence is
   [D023]'s shape recurring inside the document D023 is about, which is why it is recorded in [D024]
   rather than quietly corrected.

   The writer set is `align check` (both arms) *and BOTH MCP tools that call `freshCheck`* —
   `align_check` **and `align_violations`** — each of which consults the same store, runs the same
   `reconcileMoves` and persists the same transfer. Leaving MCP out would leave the mechanism
   permanently inert for an agent-only workflow, the consumer align ships an MCP server for.
   `align_violations` was missing from this list until adversarial review 2026-08-18: it shares
   `freshCheck`, so it was a writer whether or not anyone had listed it, and the enumeration was a
   sample presented as a census. Both are now pinned by `cli/test/mcp.test.ts`. `align upgrade` also transfers but is deliberately **not** a writer: it
   is a rare one-shot migration, and a record it declined to advance is merely older, which every
   question already handles.
4. **A corrupt record throws; it never reads as empty.** BUG #1 is the precedent — a corrupted
   `.align/baseline.json` read as `[]`, and the next full-snapshot write destroyed every accepted
   entry. Same discipline, no exceptions.

   ***Reversed 2026-08-18, while implementing it. A corrupt record reads as ABSENT, loudly.*** The
   discipline is real and it belongs to `baseline.json`: irreplaceable human consent, where an empty
   read is followed by a full-snapshot overwrite. None of that transfers. This file is a gitignored,
   machine-local cache align creates and replaces on its own schedule, holding nothing a human
   authored, and an absent read yields `known: false` from every question — which §5 defines as
   *exactly today's behaviour*. Throwing would fail every `align check` in the repository, over a file
   the user cannot see in `git status`, until they deleted it by hand.

   **Measured 2026-08-18**, by implementing §7.4 as specified and running the integration scenario
   against real binaries: with a truncated record planted, `align check` leaves it truncated *forever*
   — every later read throws, the writer's own catch swallows it, and the mechanism is silently dead
   with no warning ever printed. The harsher outcome, the command failing outright, is **inferred**:
   today the record is read only inside a guarded writer, but §3's probe is built from it *before* the
   scan, so once the consumers of §6 land the throw is uncontained.

   This is the same misapplication ADR 030 §4 was amended for **one day earlier**, about `.align/.lock`
   — a lock that refused to be broken at any age because "corrupt is not absent", and bricked the
   repository it was protecting. For a file align owns, never-treat-as-absent is the *unsafe*
   direction. Recorded as its own defect ([D021]) and its own shape ([S-12], *a discipline
   transplanted from the artifact that earned it*), because getting it wrong twice in two days is the
   signal, not the instance.

5. **Never write from an errored run.** *Added 2026-08-18, while implementing it — not in the
   original §7.* An errored run reports empty `observedFiles`, `observedViolations` and
   `componentMatchCounts` deliberately, because it has no trustworthy scan scope to report
   (`untrustworthyScanScope`). Persisting that converts "this run knows nothing" into the positive
   claim "the previous scan observed nothing", which IS admissible next run — a component that
   matched 12 files would read as having always matched 0, silencing the exact regression §6 exists
   to report. And it would destroy a sound record to do it.

6. **Never downgrade a complete record to an incomplete one.** *Added 2026-08-18, by adversarial
   review of §7.5 — [D025].* Constraint 5 names ONE cause of "this run knows less than the repository
   contains" and stops there. A run that is merely **incomplete** (`isRunComplete`: a
   `missing-dependencies` advisory or an ungrounded component — ADR 023's second axis) reports fewer
   violations, because an unresolved specifier drops the edge its violation would have fired on and an
   ungrounded component evaluates its rules over nothing. Persisting that narrows the record, and the
   next run then answers `known: true, value: false` about a violation the previous **complete** scan
   had seen — so §6's D015 refusal does not fire. One `align check` without dependencies installed
   disarms it, and nothing says so. That is [S-09], fixed one arm and missed the other, inside the
   constraint added for the other arm.

   The record therefore carries `complete`, and the writer refuses to replace a complete record with an
   incomplete one. **A no-downgrade rule, not a no-write-when-incomplete rule**, and the distinction is
   forced by measurement rather than taste: incompleteness is an ordinary standing state, not an error.
   The integration project reports `complete: false` at its pinned commit (48 unresolved external
   specifiers), and every fixture in `cli/test/scan-observation-write.test.ts` is incomplete because it
   has no `node_modules` — so "never write when incomplete" would mean the record is never written on
   exactly the repositories with the most code in them. The four transitions: no record → write
   (bootstrap); incomplete → incomplete → write; incomplete → complete → write; complete → incomplete →
   **decline, and say so on stderr**.

   `complete` is a WRITE-ELIGIBILITY field and not an admissibility one — no `ScanHistoryProbe` question
   consults it. An incomplete scan still *observed* what it reported, so a recorded violation is a sound
   positive fact; what an incomplete run gets wrong is what it OMITS, and an omission is invisible in
   the record by construction. That is why the guard has to live in the writer.

   The cost, stated rather than left to be discovered: a repository that becomes *permanently*
   incomplete freezes its record at the last complete scan. Benign for the only consumer — a frozen
   record refuses only where a candidate genuinely coexisted with the orphan at that time, which is the
   D015 case — but real, and the stderr line is what keeps it visible.

This makes the known non-atomic `.align/` write (full-snapshot `writeFileSync`, no temp-and-rename,
no lock — recorded in ADR 028's closing section) a **prerequisite** of implementation rather than a
nicety, because `check` gains a second artifact it writes on a schedule the user does not control.

### 8. Ships under the standing rules

ADR 026 (a declared write-set naming `.align/last-scan.json`) and ADR 025 (an integration scenario)
apply, and per CLAUDE.md rules 1 and 2 the feature is not complete without them. At minimum the
scenario must cover: no record → today's behaviour; a record from a different `scopeIdentity` →
today's behaviour; and the D015 reproduction staying red.

*Amended 2026-08-18, after implementation.* Two of the three shipped: `scan-history-record-written`
covers "no record → today's behaviour", and `scan-history-refuses-forged-transfer` covers the D015
reproduction (calibrated `expectFailOn: ['0.1.4']`, where it lands `acceptedBy: manual` on a
never-reviewed violation at exit 0). **The `scopeIdentity` scenario is deliberately declined**, and
that is a correction to this section rather than a gap: `wasViolationObservedAt` is the only question
with a consumer, and it is deliberately NOT gated on `scopeIdentity` (§4) — so the scenario this
section imagines would assert that a scope change does nothing, which is true but is the *absence* of
a property rather than a property. The asymmetry is pinned where it is decided, in
`core/test/scan-history-probe.test.ts` and again from the consumer's side in
`core/test/scan-history-move-refusal.test.ts`. Re-open this if a scope-gated question gains a
consumer.

## What this does not close

Recorded explicitly because the proposal this ADR supersedes claimed more, and a reader who adopts
the claim rather than the mechanism will build on sand.

*Three residuals added 2026-08-18 by adversarial review of the implementation, because each is a way
the mechanism is quietly weaker than this ADR reads.*

- ~~**An INCOMPLETE run writes a thinner record over a sounder one, and nothing says so.**~~ **Closed
  2026-08-18 by §7.6** ([D025]). The residual as first written also carried a false justification for
  leaving it open — that refusing to write when incomplete "would make the mechanism permanently inert
  on any repository with a standing uncertainty advisory, which includes align's own". `isRunComplete`
  does not consider `uncertainty` at all (`gates/advisories.ts`; `advisories.test.ts` asserts it
  directly), and align's own run is complete. The real constraint came from a different measurement —
  the integration project and every unit fixture are incomplete for other reasons — and it pointed at
  a no-DOWNGRADE rule rather than a no-write rule. The wrong reason would have led to the wrong fix.
- **A forged record can steer which candidate inherits a transfer.** §5 guarantees no *additional*
  transfer and no greener verdict, and that holds. But `applyMoves` matches greedily and consumes each
  candidate, so declaring one candidate already-observed shifts later orphans onto different targets
  within the same content-fingerprint bucket (measured; see the invariant comment in
  `core/src/baseline/store.ts`). The consent still lands on a never-reviewed violation — just not the
  same one. Harmless while every consumer is a refusal; not harmless for a consumer whose answers are
  not.
- **§1's identity argument rests entirely on one `.gitignore` line.** The record carries no machine
  identity and `computeScopeIdentity` deliberately excludes `rootDir`, so a record committed by
  accident is fully admissible on another machine. Every repository `align init`'d before 0.2.0 lacks
  the ignore entry (UPGRADING.md says so). Harmless today because the only consumer is refusal-only;
  a live hazard for `observedMatchCount` and `wasFileObserved`, which §6 licenses next.

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
