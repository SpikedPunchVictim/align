# ADR 030 — `.align/` write integrity: atomicity and concurrent writers

**Date**: 2026-08-18
**Status**: Accepted — implemented in 0.2.0
**Supersedes**: nothing. **Related**: ADR 006 (consent), ADR 022 (`.align/` write discipline), ADR 023 (refusal tiers), ADR 028 (blind spots)

## Context

`.align/baseline.json` holds recorded human consent decisions. It is the one artifact align writes
that cannot be regenerated: a violation fingerprint can be recomputed, a ruleset can be rebuilt, but
"a person looked at this violation on this date and accepted it" exists nowhere else. ADR 006 built
the consent rules around that. This ADR is about the two ways the file could be destroyed *without
any command deciding to destroy it*.

Both were known before this work — recorded in `docs/adr/proposals/scan-blind-spots/IMPLEMENTATION_PLAN.md`'s
out-of-scope list as "Concurrency: `align-dir.ts` is a non-atomic full-snapshot write with no lock;
the MCP server racing a CLI `accept` can lose a consent decision. Own ADR." This is that ADR.

### Failure 1 — a torn write

Every `.align/` writer used `fs.writeFileSync`, which opens with `O_TRUNC`: the old contents are
gone before the new ones land. A process killed inside that window leaves a truncated or empty file.
Ctrl-C, an OOM kill, a laptop lid, a cancelled CI job — none of them rare.

The consequence is worse than losing the write, because of how the next command behaves.
`readBaseline` correctly refuses to treat a corrupt file as empty (BUG #1) and throws. The user is
now blocked, holding a file they cannot parse, and the obvious recovery — delete it and re-run
`align baseline accept` — **launders every unreviewed violation in the repository into the
baseline**, stamped with their name. The safety property that makes a corrupt read loud is exactly
what makes a corrupt file expensive.

### Failure 2 — a lost update

`writeBaseline` is a full-snapshot **replace**. There is no merge, and there was no check that the
file still looked the way the caller expected. Every destructive command is a read-modify-write
around it:

```
read baseline  →  scan (seconds to minutes)  →  write the result
```

Two aligns overlapping in that window means the second write erases whatever the first recorded,
and **both commands report success and exit 0**. This is not hypothetical: align ships an MCP
server, so the intended usage is an agent holding a long-lived session while a human works in a
terminal on the same repository. An agent's `align_check` persisting a move transfer while a human's
`align baseline accept` commits is the concrete case.

A destroyed consent decision at exit 0 is CLAUDE.md rule 6's severity zero.

## Decision

### 1. Every full-snapshot write under `.align/` is crash-atomic

`writeFileAtomic` (`cli/src/fs-atomic.ts`): write a temp file **in the same directory**, `fsync` it,
`rename` over the target, then `fsync` the directory.

- Same directory because `rename` is only atomic within a filesystem; `os.tmpdir()` is the wrong
  place however convenient, and fails with `EXDEV` when `/tmp` is a different mount.
- The first `fsync` stops the rename publishing a file whose bytes are still buffered. The second
  makes the rename itself survive power loss. The directory `fsync` is **best-effort** — Windows
  rejects it and some filesystems return `EPERM` — and a failure there is swallowed rather than
  turned into a failed write.
- Applied to all seven full-snapshot writers. **Not** applied to `appendTelemetryLine`: an append is
  a different operation with different semantics, and telemetry is a regenerable log.

### 2. Concurrent writes to the baseline are detected and refused, not merged

Two mechanisms, and **neither works without the other**:

**A short lock** (`cli/src/align-lock.ts`). An exclusive lockfile at `.align/.lock`, created with
`open(…, 'wx')` — atomic create-if-absent, no native dependency, which matters for a tool whose
posture is "read-only, no install required".

**A read token** (`readBaselineSnapshot` → `writeBaseline`). The reader takes a content hash of the
bytes it read; the writer compares it against the file's current bytes and refuses if they differ.

The lock is held **only around the commit**, never across a scan. Holding it from the initial read
would serialize every concurrent `align check` in a repository for the length of a full scan — the
wrong trade for a tool people put in a pre-commit hook. But a short lock cannot by itself prevent a
lost update, because the staleness happened before it was taken. The token detects that, and it is
compared *inside* the lock, which is what stops the compare-then-write being a race of its own.

### 3. The refusal is loud, and nothing is written

```
align: .align/baseline.json changed while this command was running, so writing now would
silently discard whatever the other process recorded — most likely another align (an MCP
server, an editor integration, or a second terminal) accepted or pruned entries. Nothing
has been written. Re-run the command; it will pick up the current baseline.
```

Re-running is always safe and always sufficient: the command re-reads and recomputes. This follows
ADR 023's posture — refuse and say why, rather than proceed and hope.

### 4. Stale locks are broken only on proof, never on suspicion

Breaking a lock is the one operation here that can cause the corruption the lock prevents, so it
requires **all** of: an identifiable holder, on this host, whose pid is not running, and a lock older
than 60s. A holder on another host is never broken at any age — a pid from another machine says
nothing locally, and `kill(pid, 0)` would answer about an unrelated local process. Refusing there
costs a confused user one `rm`; guessing costs them the baseline. Breaking is always announced on
stderr.

An unreadable or malformed lock file is treated as *held by someone unidentifiable*, never as
absent. Corrupt is not absent — ADR 028's discipline, applied to the lock itself.

## Consequences

**The token parameter is required, with no default and no opt-out.** The first draft offered a
`null` "not a read-modify-write" hatch and justified it in a comment naming two callers that needed
it. Making the parameter required proved the claim false: the compiler listed all seven call sites
and every one derives from a baseline it read earlier. The hatch had no users, and an unused hatch
that disables a safety check is a liability. An *optional* parameter would be worse — a new
read-modify-write caller inherits the unsafe path by writing nothing at all, which is shape S-09,
the way this class reproduces itself. This is the same technique D016's fix used the same day.

**`undefined` is a real token, not an absent one.** It means "there was no baseline file", which is
distinct from "the baseline is empty" — and since both read back as zero entries, nothing downstream
could tell them apart. A stale `undefined` written over a racing `init`'s empty baseline is refused.

**Tests seed through a helper, not through the guard.** ~65 fixture seeds call `seedBaseline`
(`test/seed-baseline.ts`), which re-reads and writes against current state. Letting each site invent
a token would have taught the next reader that passing `undefined` is acceptable.

**This ADR's own implementation was caught by `align check`.** The first version had `align-lock.ts`
importing `align-dir.ts` for the directory path, while `align-dir.ts` imported the lock — a cycle,
rejected by `arch.no-cycles:repo` on this repository. `withAlignDirLock` now takes the `.align`
directory rather than the repo root: `align-dir` knows align's layout, `align-lock` knows how to
lock a directory, and the dependency runs one way.

**A second self-caught defect, before it shipped.** Acquisition and execution originally shared one
`try`, so any error escaping the body was inspected for `EEXIST` — and the body is a filesystem
write, which raises exactly that. A caller's `EEXIST` would have been mistaken for lock contention,
retried until the deadline, and reported as a lock timeout with the real error discarded. Found
while writing the tests, and pinned by one.

### What this does not do

- **No cross-process serialization of scans.** Two `align check` runs still scan concurrently, by
  design. Only the commit is serialized.
- **No merge.** A refused write is re-run, not reconciled. Merging two baselines is a consent
  question, not a data-structure question, and ADR 006 governs it.
- **Network filesystems are not guaranteed.** `open(…, 'wx')` and `rename` are atomic on POSIX local
  filesystems; NFS is best-effort. The cross-host rule above is the mitigation, not a claim of
  correctness there.
- **The other `.align/` artifacts get atomicity but no token.** `generated-rules.json`,
  `rules-lock.json`, `ruleset-ir.json`, `version.json` and the telemetry state are regenerable
  caches; losing a concurrent write to one costs a rebuild, not a consent decision. Scope the
  expensive guarantee to the irreplaceable file.
