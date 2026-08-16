# ADR 028: Absence From a Scan Is Not Evidence of Deletion

**Status**: Accepted

## Context

ADR 027 closed one instance of a class and named the class in its own closing section: *"changing
what a scan sees is never local to scanning."* It listed the consumers that infer meaning from
absence — `applyMoves` infers "renamed", `store.prune` infers "fixed", `validateComponents` infers
"empty component" — and required that a future scan-scope change enumerate them before shipping.

This ADR is the result of doing that enumeration in the other direction: not *"what breaks when we
narrow the scan"* but *"in how many ways can the scan already be narrower than the repository, and
what does each one do to a consent record."* The answer is worse than ADR 027's single instance
suggested, and the mechanism it introduced — record the skipped paths on the run, route them to the
"still known" branch — turns out to be the right shape applied too narrowly.

### The inference, and why it is unsound

`InMemoryBaselineStore` reasons about deletion through one expression, `!knownFiles.has(entry.file)`,
where `knownFiles` is `new Set(graph.nodes.map((n) => n.file))` (`core/src/orchestrator.ts:192`).
That set answers *"did this scan produce a node for this path"*. It is read as *"does this file
still exist in the repository"*. Those are different questions, and every gap between them is a
defect with one of two shapes:

- **`store.prune` deletes the entry** and reports it in the "Pruned N fixed violation(s)" count,
  exit 0. A consent record — which human accepted this, and when — is unrecoverable once gone.
- **`applyMoves` transfers the entry** onto a different file whose live violation shares its
  `contentFingerprint`, carrying `acceptedAt`/`acceptedBy` across. A violation nobody reviewed
  becomes pre-accepted and `align check` goes green.

The second is the severe one, for the reason ADR 027 recorded: `orchestrator.check` calls
`reconcileMoves` on **every** invocation and `commands/check.ts:114`'s `persistMovedBaseline` writes
the result unconditionally, so it fires on a plain `align check` with no destructive command, no
flag, and no completeness gate in the path.

### Every way a present file is absent from the scan

All exits are in `walkSourceFiles` (`plugin-typescript/src/scanner.ts:199-241`) unless noted.
Verified by reading each path end to end; the two marked *reproduced* were additionally demonstrated
against the built binary.

| # | Mechanism | Site | Recorded? |
|---|---|---|---|
| 1 | `excludes` matches the file | scanner.ts:233 | no — *reproduced* |
| 2 | `excludes` matches an ancestor directory | scanner.ts:208 | no |
| 3 | Nested git checkout | scanner.ts:215 | **yes** (ADR 027) |
| 4 | `DEFAULT_EXCLUDED_DIR_NAMES`, at any depth | scanner.ts:228 | no |
| 5 | Unreadable directory — `catch { return }` | scanner.ts:224 | no — *reproduced* |
| 6 | Extension outside `SOURCE_EXTENSIONS` | scanner.ts:231 | no |
| 7 | Dirent is neither file nor directory — **symlinks** | scanner.ts:227, :231 | no — *reproduced* |
| 8 | Case-only rename on a case-insensitive filesystem | orchestrator.ts:192 (`Set` exact match) | no |
| 9 | The file is genuinely gone | — | the only sound case |

Three of these were not known when ADR 027 was written.

**#7 is structural and was the surprise.** `readdirSync(..., { withFileTypes: true })` does not
follow symlinks, so `entry.isDirectory()` and `entry.isFile()` are **both false** for one. A symlink
matches neither branch of the loop and falls off the end. Demonstrated against the built scanner
with a fixture containing a symlinked in-repo file, a symlink pointing outside the repo, and a
symlinked directory:

```
on disk:  src/real.ts  src/other.ts  src/link.ts -> ../lib/target.ts
          src/extlink.ts -> outside/ext.ts       src/vendored -> outside/vendordir/
scanner:  nodes = ["lib/target.ts", "src/other.ts", "src/real.ts"]
          skippedNestedCheckouts = []
          uncertain = []
```

Three source files vanish — one of them an entire subtree — with no record and not even an
uncertainty marker. A repository whose `src/` is itself a symlink, a common generated-monorepo
layout, loses everything.

**#6 and #8 matter mainly across versions.** `.mjs/.cjs/.mts/.cts` were added to
`SOURCE_EXTENSIONS` in this release cycle (scanner.ts:38-42), so a baseline written by a version with
a different extension set sees those entries as deleted files. `#8` is narrower than feared:
`Violation.file` is always walk-cased, so acceptance-time casing always matches scan-time casing, and
the only producer of divergence is an actual on-disk case change — but a case-only rename is then
indistinguishable from deletion under `Set` exact match.

**#5 is silent even after this release's earlier work.** `cli/src/unverified-prune.ts` reports a
prune it could not verify only when the entry lacks a `contentFingerprint`; an entry written by
`baseline accept` has one, so an unreadable directory deletes it with **no output at all**.

### A second scan domain, with its own exits

The security gate (ADR 013) builds an independent `knownFiles` from `inventory.manifests`
(`orchestrator.ts:301`) and passes `[]` for skipped checkouts (`orchestrator.ts:314`). The doc
comment defending that `[]` is **accurate and incomplete**: verified, neither
`plugin-typescript/src/manifest.ts` nor `workspace.ts` contains any `.git` test, so no manifest can
ever be absent *for the nested-checkout reason*, and that exemption is pinned by
`plugin-typescript/test/manifest.test.ts` rather than asserted. What the comment does not say is that
the manifest walker has its own unrecorded exits:

- **`readJson`'s `catch { return undefined }`** (manifest.ts:44-50) — a malformed `package.json` is
  treated as absent. That is the corrupt-≠-absent discipline BUG #1 established, violated in a
  second walker.
- **A different exclude dialect.** `isExcluded` (manifest.ts:80-83) is exact-or-directory-prefix
  only, with **no `globMatch`**, unlike the source walker (scanner.ts:250-255). One `excludes`
  entry can drop a package's sources while keeping its manifest, or the reverse.
- Unreadable manifest, and membership loss through `workspace.ts`'s malformed-config catches.

### What is *not* the cause

An earlier draft of this decision claimed the class was caused by commands re-deriving inputs
mid-invocation — `baseline prune` taking violations from one walk (`commands/baseline.ts:137`) and
its file domain from a second (`:148`), `upgrade` mixing outputs across ~6 walks. **That claim is
false and was retracted before implementation.** The confirmed defects fire on a plain `align check`:
one command, one walk, `knownFiles` derived from the very graph that produced the violations
(orchestrator.ts:192). The chain is intact and the forged transfer still happens.

The multi-walk sprawl is real, is documented as fragile in the code itself (upgrade.ts:314-324:
*"Agreement between preview and outcome is not automatic"*), and has produced **zero confirmed
defects**. It is a hazard to remove, not the cause to fix. Recording this because the wrong
diagnosis pointed at a far larger and less urgent refactor.

### The invariant that was supposed to prevent this

`orchestrator.ts:248` states *"Core stays the sole owner of scanning (ARCHITECTURE.md §5)."*
`ARCHITECTURE.md` §5 is **"Package layout for v1"** and says nothing of the kind; it explicitly
licenses the CLI to hold concrete plugins. Five CLI sites call `plugin.scanner.scan` directly —
`explain.ts:37`, `build.ts:127`, `init.ts:142`, `agent.ts:59`, `doctor.ts:169`. The architecture
this ADR's deferred half wants was, until now, a doc comment nothing implemented and no rule
enforced. CLAUDE.md rule 5, in miniature, about the rule file itself.

## Decision

**Invariant: a consumer may infer deletion from absence only when the scan can prove the path was
observable and observed. Every path the walk declined to look at is recorded with its reason and
routed to "still known"; every path the walk never enumerated is checked against the filesystem
before any destructive inference.**

Two mechanisms, deliberately overlapping, because neither is sufficient alone.

### 1. The walk records what it could not see

`walkSourceFiles` returns a `ScanBlindSpot[]` alongside `files` — one entry per path it declined to
descend into or record, carrying a discriminated `reason`:

```ts
type ScanBlindSpotReason =
  | { kind: 'nested-checkout' }                    // supersedes skippedNestedCheckouts
  | { kind: 'excluded'; pattern: string }
  | { kind: 'default-excluded-dir'; name: string }
  | { kind: 'unreadable'; error: string }
  | { kind: 'not-regular-file' };                  // symlink, FIFO, socket
```

Carried on `DependencyGraph` and `CheckRun` exactly as `skippedNestedCheckouts` is today, and
**replacing** it: one record, not two, so a consumer cannot handle one and miss the other. Matching
is at-or-under the recorded path, reusing `isUnderDirectory` from
`core/src/baseline/skipped-checkouts.ts`.

The field is **required**, not optional, for the reason ADR 027 records with its own counter-example:
the optional version of that exact parameter let a production call site silently keep pre-fix
behaviour.

Extensions outside `SOURCE_EXTENSIONS` (#6) are deliberately **not** recorded. Enumerating every
non-source file in a repository is expensive and noisy, and mechanism 2 covers the case that matters
without it.

### 2. An injected existence probe covers the unenumerated tail

Recording blind spots handles causes we have enumerated. It cannot handle the next one — and this
ADR exists because the previous enumeration missed three. So before any destructive inference, an
orphan whose file is absent from the scan is additionally checked against the filesystem: if the
file **is there**, the scan had a blind spot of some kind, whatever its cause, and the entry is
retained and reported.

`packages/core` imports `node:fs` **nowhere** (verified: zero matches in `core/src`), and that stays
true. The probe is injected into `BaselineStore` as a `FileExistenceProbe` — dependency injection,
consistent with how the store already receives its collaborators, and it makes the behaviour
testable without a filesystem.

**The two mechanisms cover each other's blind spot, which is why both are required.** Measured
against each cause:

```
plain.ts        -> true    normal file
link.ts         -> true    symlink (followed)     retained by probe
broken.ts       -> false   broken symlink         correctly "gone"
locked/file.ts  -> false   inside chmod 000 dir   WRONG — probe alone fails
gone.ts         -> false   genuinely deleted      correct
```

`fs.existsSync` swallows the `EACCES` and reports a file inside an unreadable directory as **absent**
— so the probe alone does not close mechanism #5, one of the two reproduced severity-zeros. The walk
knows that directory was unreadable; the probe knows nothing of causes but catches blind spots nobody
has enumerated. Neither alone is sufficient. Together they are conservative in the safe direction:
retain and report, never delete on an unproven inference.

### 3. Retention semantics follow ADR 027 exactly

A retained entry is carried forward, never deleted, the command still exits 0, and one advisory line
names the count and the reasons. ADR 023's `refuseIfRunIncomplete` is evaluated against the
forfeited count only, since a retained entry was never at risk. This is `partitionSkippedCheckoutCandidates`
generalized, not a new mechanism — the same helper, a wider input.

**Reasons must be printed.** Silent retention converts a false-delete into a false-tranquility: a
misconfigured near-empty scan retains everything and, without reasons, reads identically to "nothing
to prune."

### 4. `applyMoves` gets the same guard as `store.prune`

ADR 027 already routes a checkout-resident file to the "still known" branch so it is never offered
for a content match. Every blind-spot reason gets that treatment, and so does a probe-positive file.
This is the arm that produces forged consent, and it is reached on every `align check`.

### 5. `orchestrator.knownFiles()` is deleted; `prune` scans once

The method exists only because `CheckRun` does not carry the graph, which its own doc comment admits
(orchestrator.ts:241-251). It also **merges the two scan domains** into one set (orchestrator.ts:252-259)
while `check` keeps them separate per-gate — so `prune` reasons over a union that `check` never uses.

`CheckRun` therefore carries **both** the blind-spot record and the observed file set, per domain.
Carrying only the blind spots would leave the second walk in place, since `prune` would still have
nowhere to get the file set from — the deletion of `knownFiles()` is what the observed-file-set field
buys, and neither half is useful without the other.

The two domains stay **separate**. Merging them would let a `package.json` be judged by the source
walker's vocabulary, where `.json` is an asset extension, not a first-class file.

### 6. A prune floor for the degenerate scan

`validateComponents` (`core/src/components/registry.ts:162`) skips its zero-match check entirely for
any component not set to `empty: 'fail'` — `if (def.empty !== 'fail') continue;`. `align init`
sets `empty: 'until-populated'` on every component matching zero files, and `--greenfield` sets it on
all of them (`commands/init.ts:146-152`). **align generates the unprotected configuration itself**,
and on such a repo a wrong-root or everything-excluded scan yields zero nodes, no throw, a green
verdict, and a prune that would delete every entry at exit 0. The check is also per-component and
needs only one match, so partial shrinkage passes even under `'fail'`.

`prune` refuses when the scan observed nothing, independent of component policy. **The refusal has
no override.** It is tier-1 shaped in ADR 023's vocabulary, like `refuseIfRunErrored`: tier 2 exists
because a partially-observed scan still carries information a human can weigh, whereas a scan that
observed nothing carries none — there is no fact an override could be based on. Adding
`--allow-incomplete` here would let a user authorise a mass deletion on the strength of no evidence
whatsoever.

### 7. Deferred, deliberately: the pipeline reframe

The following is **decided in principle and not implemented in this release**, recorded here so it
is not rediscovered:

> **Every inference is drawn from artifacts of a single run; runs compose only as explicit
> before/after diffs across a named mutation.**

Commands become projections of one derivation, or mutations staged on top of it, never
re-derivations. `agent run` is lawful under this phrasing — it scans, mutates source, and rescans
(`agent/src/run.ts:220/225`) to diff exported symbols, which is a deliberate before/after comparison,
not a re-derivation. `init`'s probe scan (`init.ts:142`, `excludes: []`, a throwaway ruleset) is the
single genuine exception: it bootstraps the config the chain depends on and cannot be a view over a
pipeline that requires its own output.

Enforcement is the **type seam** — commands typed `(run, io) → outcome` with no route to an
orchestrator — not an import rule. A `custom.host` rule confining scanner imports is expressible
today (the pattern is proven at `align.config.ts:93-111`) and worth adding as a seatbelt, but it
would catch only the five direct-scan projections and **miss both real offenders**: `baseline.ts` and
`upgrade.ts` never import the scanner, reaching it through `createOrchestrator().check()`. align has
no vocabulary for counting invocations. The portable form of even the narrow rule needs sub-path
components, which `align.config.ts:53-56` rejects for the existing child-process rule on
first-match-wins grounds — align's own §A.2.2 granularity gap. **An architecture-conformance tool
cannot currently enforce its own most important boundary.** That is a product finding, recorded for
its own sake.

## Alternatives considered

**Ship the full pipeline reframe in this release.** Rejected on sequencing, after the diagnosis that
motivated it was retracted. It closes none of the confirmed severity-zeros — those fire on a
single-walk `check` — while restructuring eight commands, every one of which writes, each needing its
own ADR 026 write-set and integration scenario. It also contradicts this repo's incremental
doctrine. The counter-argument raised was that infrequent upgraders would miss the improvement; that
does not hold, because `selectRange` (`cli/src/migrations/range.ts:74`) selects
`version > from && version <= to`, so a user jumping 0.1.4 → 0.3.0 receives every intervening entry,
and the fix is compiled code regardless. Followed through, "users upgrade rarely" argues *for*
shipping the safety fix small and soon: release cadence is the bottleneck on it reaching anyone.

**The existence probe alone, with no blind-spot record.** Rejected on measurement, not principle —
it was the cheapest proposal on the table and it fails on mechanism #5, as the table above shows.
It also cannot name a cause, and retention without a reason is not actionable.

**The blind-spot record alone, with no probe.** Rejected: it is exactly as complete as our
enumeration, and this ADR exists because the previous enumeration missed three mechanisms. The probe
is the guard against the fourth.

**A per-path disposition map with an `isProvablyGone` predicate.** Rejected in this shape. For any
path the walk never enumerated — under an excluded, unreadable, or checkout directory — there is no
per-path record to consult, but a **genuinely deleted file has no record either**, because a walker
cannot enumerate what is not there. "No record → gone" reinstates the bug; "no record → not gone"
makes prune a permanent no-op. A sound version needs directory dispositions answering by prefix
plus per-entry records for enumerated directories, which is a strictly larger design than at-or-under
matching over recorded blind spots and buys nothing this decision needs.

**Persist the scan domain to `.align/`.** Rejected. It is derived from the filesystem and goes stale
the moment anything changes, creating a second source of truth that can silently disagree with
disk — the same conflation class, promoted to a file. The principle: *persist what the human
authors, never persist what the filesystem implies.* `.align/ruleset-ir.json` is legitimately
persisted because it is config-derived and committed.

**Require `contentFingerprint` on every entry so reconciliation never asks whether a file was
scanned.** Rejected: it answers a different question. The fingerprint establishes *"is this the same
violation"*, never *"does absence mean fixed"*. An entry with a fingerprint whose file sits in an
unreadable directory is still deleted as fixed today.

**Make reconciliation refuse by default and require human confirmation.** Rejected: it fails ADR
006's own requirement that a rename must not turn CI red, and cannot work non-interactively, which
is where align mostly runs.

**Fix symlinks by following them in the walk.** Deferred, not adopted. Following symlinks introduces
cycle detection, escape-from-root handling, and double-counting when a link and its target are both
in the tree. Recording the symlink as a blind spot is correct, cheap, and safe now; deciding whether
align should scan through symlinks is a separate scan-scope question owing its own ADR and its own
ADR 027-style consequence analysis.

## Consequences

- **`DependencyGraph.skippedNestedCheckouts` is replaced by `blindSpots`.** Any out-of-tree
  `Scanner` stops compiling. `DependencyGraph` is published surface, so this is a real API break,
  taken for the reason ADR 027 gives: required beats optional on a safety-relevant field.
- **A behaviour change users will notice.** Entries under a newly-excluded path, a symlink, or an
  unreadable directory are now retained and reported instead of deleted. Someone who deletes a
  vendored tree by excluding it will see its entries persist. This is the ADR 027 trade repeated,
  and it needs an escape: an explicit way to forfeit retained entries, so the baseline cannot
  accumulate un-prunable records forever. Without it, retention is a slow leak.
- **`align check`'s move-transfer becomes more conservative.** Some transfers that used to happen
  silently now do not, and are reported. A genuine rename whose old file is genuinely gone still
  transfers exactly as before.
- **`prune` refuses on a scan that observed nothing** — a new refusal path, and the first protection
  against the configuration `init` itself generates.
- **`orchestrator.knownFiles()` is gone**, and `baseline prune` scans once instead of twice. The
  remaining multi-walk commands (`upgrade`, notably) are untouched this release and remain as
  documented-fragile as they are today.
- **Case-only renames (#8) are not addressed** and remain a known gap, recorded rather than fixed.
- **The payload rename is free exactly once, and this is that release.** `CheckPayload.skippedNestedCheckouts`
  becomes `blindSpots`. Verified no published version emits it (`v0.1.4`'s `payload/builder.ts` has
  zero occurrences; added in `b38a56f` for unreleased task #25), the MCP tools declare no
  `outputSchema`, and nothing reads it. The wider finding: **`CheckPayload` carries no version
  field** — `irVersion: '1'` belongs to the ruleset IR, a different artifact — so a consumer either
  finds a key or silently does not, and every future rename after 0.2.0 is an unsignallable break.
  Versioning the check payload owes its own ADR.
- **Concurrency is untouched and is a separate defect.** `writeBaseline` (`cli/src/align-dir.ts:206-209`)
  is a full-snapshot `fs.writeFileSync` with no temp-and-rename and no lock; the only lockfile in the
  repo is `rules.lock.json`, a content hash, not a concurrency primitive. The MCP server is
  long-lived and writes on every check carrying moves, so a CLI `accept` racing it can lose a consent
  decision across a multi-second scan window. No scan discipline fixes this; it owes its own ADR.

## Evidence

- Symlink loss: fixture and probe against the built scanner, output above. Mechanism at
  scanner.ts:226-235 — `Dirent.isDirectory()`/`isFile()` are both false for a symlink.
- `existsSync` behaviour per cause: table above, measured on macOS (case-insensitive volume).
- `packages/core` is filesystem-free: zero `node:fs` imports under `core/src`.
- Manifest walker exits: manifest.ts:44-50 (malformed → absent), :80-83 (exclude dialect divergence,
  vs scanner.ts:250-255), and no `.git` test in either manifest.ts or workspace.ts — the ADR 013
  exemption verified rather than assumed.
- The empty-scan floor gap: `components/registry.ts:162` (`if (def.empty !== 'fail') continue;`) and
  `commands/init.ts:146-152` (align generates `until-populated`).
- Scan entry points: five direct `plugin.scanner.scan` CLI sites — explain.ts:37, build.ts:127,
  init.ts:142, agent.ts:59, doctor.ts:169.
- The retracted diagnosis: `orchestrator.ts:192` derives `knownFiles` from the same graph that
  produced the violations, so the reproduced excludes and symlink defects need no second walk.
- Related: ADR 027 (nested checkouts, the F1 forged-transfer path, and the "not local to scanning"
  lesson this generalizes), ADR 023 (refusal tiers), ADR 006 (baseline consent, move-transfer),
  ADR 013 (manifest scan domain), ADR 026 (declared write-sets), ADR 025 (integration harness).
