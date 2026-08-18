# Proposal: a short scan history

**Status**: **Superseded by [ADR 029](../../029-2026-08-18-scan-observation-history.md)**
(2026-08-18). Kept as the record of how the decision was reached; the ADR is the contract.

This draft is wrong in three places that a reader must not carry forward, all corrected in the ADR:

1. **§4 overclaims.** History does **not** resolve D001's ambiguity — "observed last scan, absent
   now" is equally true of a partial checkout and a deliberate deletion, so the ADR 006 consent gate
   stays. And D009 is only detectable in the **narrowing** direction; D009's own direction was
   widening, which is indistinguishable from a file being written for the first time. The claim
   "four of the ledger's most severe rows, from one mechanism" does not hold.
2. **§3 omits the field that closes the severity zeros.** The record needs the identities of the
   violations each scan reported, not per-file content fingerprints. The ADR adds `violations[]` and
   drops the fingerprints, the ruleset hash and the git HEAD this draft proposed.
3. **§5's `true | false | unknown` is a truthiness foot-gun** (`'unknown'` is truthy), and its two
   providers behind one interface destroy the caller's ability to say whether it is relying on what
   align observed or on what git recorded. The ADR uses a discriminated union and one provider.

**Question**: should align keep a short record of what its recent scans observed, so it can answer
"what changed since last time"?

---

## 1. The evidence

Of the 14 rows in `docs/adr/defects/LEDGER.md`, **five have the same root cause, and they include
all three severity zeros**:

| Row | Sev | The ambiguity align could not resolve | What would resolve it |
|---|---|---|---|
| D001 | S0 | partial checkout vs. deliberate deletion | what the tree looked like last scan |
| D010 | S0 | rename vs. pre-existing duplicate | was the match target already there |
| D011 | S0 | component ungrounded by a repointed selector | was this component grounded last scan |
| D008 | S1 | deleted dead code vs. missing tree | the same question, opposite direction |
| D009 | S2 | a file move silently widened the scan scope | what was in scope last scan |

This is not five bugs. It is one blind spot with five faces: **every align run is amnesiac.** Each
scan is compared against the baseline — a record of accepted *violations* — and against nothing at
all on the question of what the scan itself saw. Absence is then read as evidence, which is the exact
inference ADR 028 exists to refuse; ADR 028's three retention mechanisms are each an attempt to
recover, from a single snapshot, information that only exists across two.

The pattern was noticed by a human reading the ledger, one day after the ledger was created. That is
the ledger's stated purpose working as designed (`docs/adr/defects/README.md`) — a shape becomes
visible when its instances sit next to each other rather than scattered across 70 files.

## 2. Why not just use git

Git is the obvious alternative and it is genuinely good at three of these: a partially-checked-out
file is tracked-but-absent from the worktree, a deleted one is not, and git does rename detection
natively. If the question were only "what happened to this file", git would be the answer, and it
would work in CI where no local history exists.

**But it cannot answer D009 or D011, and those are the interesting half.** Those are not changes to
files; they are changes to *what align looks at* — an `excludes` pattern, a component selector, the
scanner's extension set, a plugin version. Git has no idea align exists. Only align can record
align's scope.

That asymmetry decides the shape: the record must be of **align's own observation**, not of the
filesystem. Git remains complementary and is worth having as a second provider behind the same
interface (§5), particularly because it works on a fresh CI clone where history does not.

## 3. What a record holds

Per scan, one manifest:

- **provenance** — align version, ruleset hash, `excludes` hash, git HEAD if available, timestamp
- **scope** — observed files per domain (source, manifest), blind-spot paths, ungrounded components
- **identity** (optional, for move detection) — content fingerprint per observed file

Measured on align's own repository (318 observed files): **12.7 KiB paths only, 18.0 KiB with
fingerprints**. Extrapolated to a 50,000-file monorepo: **~2.8 MiB per scan**, before compression.
Keeping three to five is affordable as a gitignored cache; it is not affordable as a committed
artifact, and committing it is not proposed — the churn would dominate every diff.

## 4. What it would have caught

- **D010** — `src/api/service.ts` was observed in the previous scan, so the vanished `src/api2/`
  entry cannot have moved into it. Blocks the forgery **and allows the genuine rename** where the
  target is new. This closes D010 *without* the ADR 006 rename regression that the current fix
  forces.
- **D001 / D008** — directory observed last scan, absent now, rest of the tree intact ⇒ a real
  deletion, prune it. Whole tree gone ⇒ a checkout problem, retain. This removes the friction that
  made the ADR 006 consent gate necessary, though the gate is worth keeping on its own merits.
- **D011** — "component `api` matched 12 files last scan and 0 now" is a precise, actionable
  statement, in place of a generic incompleteness refusal.
- **D009** — "your scan scope changed: 2 files that were scanned before are not now" — the exact
  thing that nothing in the project caught, and which only `align check` run by hand revealed.

Four of the ledger's most severe rows, from one mechanism.

## 5. Shape

An injected probe, matching the pattern `FileExistenceProbe` already establishes: core stays
filesystem-free, the CLI supplies the implementation, and consumers ask narrow questions rather than
reading the raw history.

```
didObserve(file)            -> true | false | unknown
wasComponentGrounded(name)  -> true | false | unknown
previousScanScope()         -> { excludesHash, observedCount, ... } | unknown
```

**`unknown` is a first-class answer and must mean "fall back to today's conservative behaviour."**
There is no history on a first run, in a fresh CI clone, or when the record is stale. A design in
which the absence of history silently enables a destructive inference would be the ledger's [S-10]
shape (*absence treated as evidence*) reproduced in the very mechanism built to cure it.

Two providers can sit behind that interface — the scan history, and a git probe for the file-level
questions in environments with no history. Neither is required.

## 6. Risks, stated plainly

1. **`check` becomes a writer on every run.** Today it writes only conditionally
   (`persistMovedBaseline`). Always-write changes CI expectations, read-only filesystems, and
   interacts with the known non-atomic `.align/` write and the absent lock (already recorded as
   out of scope for 0.2.0 and now a prerequisite rather than a nicety). Writing only when the scope
   actually changed is the obvious mitigation.
2. **Staleness must degrade to `unknown`, never to a wrong answer.** A record from another branch, an
   older align version, or a different ruleset hash is not evidence about this scan. Provenance is
   in the record for exactly this check.
3. **Corrupt history must throw, not read as empty.** BUG #1 is the precedent: a corrupt
   `.align/baseline.json` read as `[]` destroyed accepted entries. Same discipline, no exceptions.
4. **ADR 026 applies.** A new `.align/` artifact needs a declared write-set and an integration
   scenario before it ships (CLAUDE.md rules 1 and 2).
5. **It must not become authority it has not earned.** The history says what align *observed*, which
   is not the same as what *existed*. Every consumer should be able to state which of those two it
   is relying on.

## 7. Relationship to other work

- Supersedes the "git or a persisted scan record" limit recorded in
  `docs/adr/defects/D001-floor-missed-partial-checkout.md`, and would let mechanism 3 stop being a
  heuristic.
- Directly relevant to `docs/adr/proposals/developer-harness/PROPOSAL.md`: an "align remembers"
  substrate is what several harness capabilities would be built on.
- **Blocked behind ADR 028 Stage 4 and Stage 5.** Stage 4 has open severity zeros; a new subsystem
  does not start while they are open.
