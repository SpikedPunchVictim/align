# Upgrading align

This document is the authored source for align's migration notes (ADR 022). It is compiled into
the migration registry (`packages/cli/src/migrations/registry.ts`) that `align upgrade` reads —
notes are authored **once, here**, and compiled, never hand-copied into a TypeScript literal that
could drift from this text.

Sections are version-keyed: every `##` heading names exactly one released version (a bare semver,
e.g. `## 0.2.0`), and every `###` heading under it is one migration note. The compiler treats a
misnamed or out-of-place heading as a build failure, not a section it can silently skip.

This document does not tell you what commands to run. It explains what changed and why, factually,
per version. (Guided remediation is `align upgrade`'s job.)

## 0.2.0

### Why violation fingerprints changed

A full-codebase audit fixed 15 bugs. Most need nothing from you. Four of them change how align
computes a violation's *fingerprint* — the identity `.align/baseline.json` uses to recognize a
violation you already accepted. When a fingerprint changes, a previously-accepted violation stops
matching its old baseline entry and reappears as new — not because your code changed, but because
align now describes the same finding differently.

| Rule kind | Why it changed | Scale |
|---|---|---|
| `arch.no-cycles` | The reported cycle is now derived by BFS instead of a greedy walk that could return a path which was not a cycle at all. | Measured across six real repos: **~4%** of multi-node SCCs were reporting a phantom chain and are corrected; another **~1.4%** get a shorter, genuine cycle. |
| `custom.host` | The violation's line number is no longer folded into its fingerprint, so a predicate finding survives reformatting. | Every baselined `custom.host` entry. |
| `arch.no-dependency`, `arch.layers` | `**` in a component selector now matches whole path segments only, so files may reclassify into a different component. | Only repos whose selectors used an interior `**` (e.g. `src/**/index.ts`). |
| `arch.metric` | `loc` no longer counts a phantom trailing line, so a file of exactly `max` lines correctly stops violating. | Files sitting at exactly the threshold. |

None of these self-heal via move-transfer — it requires the violation to have moved to a different
file, and these keep the same file.

### A correction preserved from an earlier draft of this document

An earlier draft of this section instructed a manual `align baseline prune` → `align check` →
`align baseline accept` sequence and justified the *order* as a correctness requirement, on the
grounds that `align check` move-transfers your real baseline while `align baseline prune` does not.
**That was wrong on both halves.** `align check` does move-transfer and persist
(`commands/check.ts`), but so did `prune` — it built its store from your real baseline and ran the
same transfer logic (`commands/baseline.ts`, `baseline/store.ts`), passing a stub graph that
`prune` then ignored. The two paths behaved identically; there was no correctness reason to run one
before the other.

That specific ordering guidance no longer applies as guidance — the manual ceremony it described is
superseded by `align upgrade`, which reconciles the baseline for you. The technical correction
itself remains true and is kept here for the record rather than deleted: `prune` and `check` never
disagreed on move-transfer, and — see "Baseline move-transfer only fires on a real move" below —
move-transfer itself was tightened in this same release, so the hazard the original (wrong) claim
was worried about does not exist under either reading.

### Component selector `**` now matches whole path segments only

An interior `**` in a component selector (e.g. `app/**/model.ts`) used to match an arbitrary
substring, crossing `/` boundaries — so `app/**/model.ts` could match `app/datamodel.ts`, a file
with no matching path-segment boundary at all. It now matches only whole path segments, the way
`**` behaves in most other glob dialects.

If a selector relied on the old cross-boundary behavior, some files may now match a different
component or none at all — a config-level change that needs your judgment, not a mechanical fix.
If a component selector now matches zero files, `align check` fails with:

```
Component 'x' (selector: ...) has zero files classified to it in this scan
```

That is the fix working — the selector was matching files it should not have. Narrow or correct the
selector. If the component is legitimately empty, set `empty: 'until-populated'` (it arms
automatically once files land) or `empty: 'allow'`.

Similarly, `**/`-leading and `{a,b}` brace patterns in `excludes` now behave the same way they
already did in component selectors — a root-level file matching `**/*.generated.ts` is now
genuinely excluded, and `{dist,build}/**` now works instead of silently matching nothing. If your
excludes relied on either being a no-op, you will see fewer violations, not more.

### `.align/version.json` provenance stamp

align now writes `.align/version.json` whenever it writes anything else under `.align/` (init,
build --apply, export-ir, baseline accept/prune, and a check that moves a baseline entry). It
records which align version last touched `.align/`, so `align check` and `align doctor` can tell
you when your artifacts were written by a different align than the one running now. Nothing to do —
this is informational only.

### Nested git checkouts are no longer scanned by default

A directory below your repository root that carries its own `.git` — a `git worktree`, a submodule,
a vendored clone — is no longer part of the scan. align skips it during the file walk and reports
every path it skipped in a `nested-checkout-skipped` advisory on `align check` and `align doctor`.

This is a change of default. Before this release those files were scanned like any others, so they
produced violations, graph edges, and baseline entries. The reasoning for the change: a nested
checkout is a different repository. Reporting architecture violations against a vendored clone or a
submodule means reporting them against code the repo's own team does not own and cannot edit, and
the finding is not actionable no matter how accurate it is.

An `excludes` pattern was never able to express this. Exclude patterns are matched by path, and a
worktree directory is typically created on demand with a generated name that did not exist when the
config was written — so the pattern cannot be written in advance. Carrying its own `.git` is the
property that actually distinguishes a separate repository, so that is what align now tests. Both
shapes count: a clone or submodule has `.git` as a directory, a linked worktree has it as a file.

What you will see: fewer violations, possibly a smaller `baselined debt` count, and an advisory
naming each skipped path. If one of those directories genuinely is part of your project — a
submodule your team does edit — a new optional `includeNestedCheckouts` export in `align.config.ts`
opts it back into the scan. It takes the same kind of patterns `excludes` takes, and it re-includes
only what it names; ordinary `excludes` still apply inside an opted-in checkout.

Baseline entries whose files are now inside a skipped checkout are **retained, not deleted**. Their
violations are absent from the scan, which normally means "fixed" — but here it means "not looked
at," and align does not treat the two the same. `align baseline prune` and `align init` therefore
carry those entries forward untouched, name the count and the checkout paths responsible in their
output, prune everything genuinely fixed as usual, and still exit 0. The one thing that changes for
you is that entries you expected to be cleared may still be there, with a line explaining which
checkout they belong to.

### Baseline move-transfer no longer treats a skipped checkout's file as a rename

Move-transfer is the mechanism that keeps a renamed file's accepted debt accepted: when a violation
disappears from one file and an identical one appears in another, align transfers the baseline entry
rather than reporting the old one fixed and the new one new. An earlier change in this release
tightened it so a transfer requires the original file to have genuinely disappeared from the scan
(see "Baseline move-transfer only fires on a real move" below).

Auto-excluding a nested checkout makes a file disappear from the scan in exactly that way, for an
entirely different reason — the file did not move, align simply stopped looking at it. Without the
fix described here, that would be enough to make a checkout-resident baseline entry eligible for
transfer, and the entry would then be re-homed onto any live violation sharing its rule and its
source line. For a vendored copy of the same code that is the expected case, not a rare coincidence.
The result would be a violation nobody had ever reviewed carrying a real person's acceptance
timestamp and name, on a plain `align check` with no destructive command involved, reported as a
green verdict and exit 0.

align treats a file inside a skipped checkout as still known rather than as gone, so it is never
offered as a transfer candidate. A genuine rename still transfers exactly as before. If you have a
baseline written by an earlier version, nothing in it needs repair — the defect was in what a scan
would do next, not in anything already stored.

### A baselined entry align could not look at is retained, not pruned

This generalizes the nested-checkout behaviour above, and it is the change in 0.2.0 most likely to
surprise you, because it makes `prune` delete **less** than it used to.

A nested checkout was one of **six** ways a file that is physically present can be absent from
align's scan. The others: it matched an `excludes` pattern; it sits under an always-excluded
directory name (`node_modules`, `dist`, …); its directory could not be read (permissions); its
manifest could not be parsed (a malformed `package.json`); or it is behind a symlink — the walk does
not follow links, so a symlinked subtree vanishes from the scan entirely while every file in it
stays readable at its old path.

Before 0.2.0 all six read as "this violation is gone", which `prune` reports as *fixed* and deletes,
and which move-transfer reads as *renamed*. Neither is true: align simply did not look. Deleting a
baseline entry destroys a human's recorded consent decision, and doing it while reporting success at
exit 0 is the worst failure this tool has.

**What you will see.** `align baseline prune` now retains those entries and prints the reason and
the path responsible — for example `Retained 2 entries: their files are unobservable this scan, not
fixed (vendor/lib (matched the excludes pattern 'vendor/**'))`. Everything genuinely fixed is still
pruned, and the command still exits 0. `align check` reports the same paths as a `scan-blind-spot`
advisory, with two deliberate exceptions: an `excludes` match and an always-excluded directory name
produce **no advisory**, because you wrote those patterns yourself and every repository has a
`node_modules`. For those two, `prune`'s retention line is where the reason appears.

**If you excluded a subtree on purpose** and want its accepted entries gone, say so by naming it:

```
align baseline prune --forget-unscanned vendor/lib
```

The prefix is required — there is no bare form, because a bare form would forfeit every retained
entry in one keystroke. It deletes accepted consent decisions under that path only, and it is
subject to the same consent gate as any other deletion (below).

**Nothing in an existing baseline needs repair.** The defect was in what a scan would do next, never
in anything already stored.

### `excludes` now means the same thing to your manifests as to your sources

One `excludes` entry used to be read by two different matchers. The source walker understood the
full glob dialect; the manifest scanner understood only an exact match or a literal directory
prefix. So `excludes: ['packages/vendor/*']` hid a vendored package's **source files** while its
`package.json` stayed in the scan, and `security.manifest.*` rules kept reporting against it. Both
domains now use the source walker's matcher.

**What you will see**: if a pattern excludes a package — either by matching its directory
(`packages/vendor`, `packages/*`, `packages/vendor/**`, `packages/{vendor,other}`) or by matching
its `package.json` (`packages/vendor/*`) — that package's manifest violations stop being reported.
That is what the exclude asked for. Baseline entries for those violations are **retained, not
pruned** — they are unobservable now, not fixed — so nothing in `.align/baseline.json` is lost, and
`align baseline prune` will name the pattern responsible if you ask it to clean up.

If you *want* a package's manifest scanned while its sources are excluded, name the source
subdirectory (`packages/vendor/src/**`) rather than anything that matches the package directory or
its `package.json`.

### align now tells you when it could not read your workspace files

A malformed or unreadable `pnpm-workspace.yaml`, `lerna.json` or `pnpm-lock.yaml` used to be
indistinguishable from not having one. A single bad character in `pnpm-workspace.yaml` meant align
found no workspace members, scanned your root `package.json` alone, and reported a green check over
a fraction of your monorepo without saying anything.

Those now produce a `scan-blind-spot` advisory naming the file and the parse or permission error.
The scan still proceeds — align stays read-only and does not crash on a file it cannot read — and
`lockfilePresent` still reports false, but you are told why. This matters beyond coverage: when the
lockfile cannot be read, every `catalog:`-managed dependency falls back to the raw specifier text in
`package.json`, so `security.manifest.source-hygiene` was evaluating a string that is not what your
install actually resolves.

### align refuses to overwrite a baseline another process changed underneath it

`.align/baseline.json` is a full-snapshot replace, and every destructive command wraps it in
read → scan → write. Until 0.2.0 nothing checked that the file still looked the way the command
expected when it got to the write, so two aligns overlapping — an MCP server and a terminal, or two
terminals — meant the second write erased the first, **and both reported success**. Since align
ships an MCP server, an agent and a human sharing a repository is the intended usage, not a corner
case.

align now takes a content fingerprint when it reads the baseline and checks it, under a short lock,
at the moment it writes. If they differ it writes nothing and tells you:

```
align: .align/baseline.json changed while this command was running, so writing now would
silently discard whatever the other process recorded ... Re-run the command; it will pick
up the current baseline.
```

**Re-running is always safe and always sufficient** — the command re-reads and recomputes. If you
see this in CI, two align invocations are running concurrently against one working copy; serialize
them.

Every file align rewrites in full is now written atomically (temp file + `rename`), so a
run interrupted mid-write — Ctrl-C, an OOM kill, a cancelled CI job — leaves the previous file
intact instead of a truncated one. If you ever hit "baseline.json is not valid JSON" after an
interrupted run, that is the failure this removes. (`.align/telemetry.jsonl` is appended to rather
than rewritten, so it is not part of this and never needed to be.)

**This covers the files align writes in YOUR repository, not only its own.** `CLAUDE.md`,
`align.config.ts`, `.gitignore`, `package.json`, an installed skill under `.claude/skills/`, and the
source files `align agent` edits during a repair are all written the same way. They were not, for
most of this release's development: the protection covered the artifacts align can regenerate and
not the ones it cannot. Nothing for you to do — but if you have ever seen align leave a half-written
`CLAUDE.md` behind after a Ctrl-C, that is the failure this removes.

One visible consequence: an interrupted write can leave a dotfile like `.CLAUDE.md.4821.3.tmp`
beside the real file. It is inert and safe to delete. That is the deliberate trade — a stray temp
file you can see instead of a truncated file you cannot.

A concurrent align does **not** fail `align check`. The transfer it could not persist is re-derived
and re-persisted by the next run, so `check` reports the collision on stderr and still prints its
results and its usual exit code. Commands whose purpose is the write — `baseline accept`, `baseline
prune`, `init` — do fail, because for them nothing was recorded.

### `align check` now leaves a `.align/last-scan.json` behind

align has always been amnesiac: every run compares your code against the baseline and against
nothing at all on the question of *what the previous scan could see*. That gap is what lets an
absence — a file the scan did not observe — get read as a fact ("deleted", "fixed", "this component
is empty"). From 0.2.0, `align check` records what it observed in `.align/last-scan.json`.

**What you will notice.** One new file in `.align/`, written by `align check` and by the MCP server's
`align_check`. Nothing else writes it, and it is rewritten only when the observation actually changes,
so an unchanged repository does not churn it. One thing already reads it — see the next section.

**It is gitignored, and for a correctness reason rather than to avoid diff noise.** A record written
on one machine is not evidence about another machine's checkout: sparse checkouts, partial clones,
an uninstalled workspace and volume case-sensitivity all change what a scan legitimately observes.
Committing it would let one machine's observation authorize another machine's deletion.

**If you ran `align init` before 0.2.0, your `.gitignore` does not have the entry yet** and the file
will show up as untracked. Either re-run `align init` (idempotent — it appends only what is missing)
or add the line yourself:

```
.align/last-scan.json
```

If the file is ever corrupted — an interrupted write, a bad merge — align ignores it, says so once on
stderr, and replaces it on the same run. It is a cache align owns; it can never block a command.

### A move-transfer is now refused when the target was already violating

**This is the reason the record exists.** When a baselined file disappears, align looks for a
current, not-yet-baselined violation with the same content elsewhere and transfers your acceptance
onto it — that is how a rename avoids turning CI red for one cycle. But align matches by content, so
it cannot tell a renamed file from one that was *deleted while an identical violation already existed
somewhere else*. In that second case the transfer moves your recorded `acceptedBy` onto a violation
nobody ever reviewed, and the repository goes from red to **green at exit 0**.

From 0.2.0, `align check` asks the previous scan first: if that violation was already reported at that
path last run, it existed before the file disappeared, so it cannot be where the violation moved to
and the transfer is refused. Your accepted entry stays where you put it, and the other violation stays
red and reviewable.

**What you might notice.** A rename that used to transfer silently can now come back red, in one
specific situation: the violation at the new path was already there and already red on the previous
run. That is the situation align cannot tell from a forgery, and red is the recoverable direction —
one `align baseline accept` resolves it, whereas a forged transfer is silent and destroys the record
of what you consented to.

**The refusal persists until you resolve it.** It is not a one-run warning that clears itself: align
keeps the evidence for as long as the accepted entry is still unresolved. The remedy is the one you
already use for any violation you intend to keep — `align baseline accept` — or `align baseline prune`
if the old entry is genuinely finished with. **You will most likely meet this after a branch switch**:
`.align/baseline.json` is committed and travels with the branch, while the scan record is gitignored
and does not, so align can be holding evidence about a tree you are no longer on. A rename that
crossed the switch will come back red once, and one accept settles it.

**It needs two scans, and it is machine-local.** A first `align check` on a fresh checkout has no
previous scan to consult, so it behaves exactly as 0.1.x did. Nothing about this refusal can make a
run *greener* than before — the history is only ever a reason to decline.

**A scan that could not resolve everything will not overwrite one that could.** If a run reports
missing dependencies or an ungrounded component, it sees fewer violations than a complete run would —
so recording it would quietly narrow what the next run can compare against. align keeps the earlier,
complete record instead and prints one line saying it did. Install the dependencies (or ground the
empty component) and the next run brings the record up to date.

### `.align/baseline.json` now carries a schema version

**No action needed, and nothing to migrate by hand.** The file was a bare JSON array; it is now
`{ "schemaVersion": 2, "entries": [...] }`. align reads the old shape unchanged and rewrites it in the
new one the first time something writes the baseline — `baseline accept`, `baseline prune`, `upgrade`,
or a move-transfer on `check`. Until then your file stays exactly as it is.

**Why:** it was the only structured file in `.align/` without a version marker, and the only one
holding decisions nobody can regenerate. Every other one already had `irVersion` or `recordVersion`.
Without a marker, a future change to what a fingerprint *means* would have been unsignallable — old
entries would keep parsing and quietly stand for something else.

**The one thing to know:** a baseline written by 0.2.0 **cannot be read by 0.1.4**, which refuses it
rather than misreading it. If part of your team is still on 0.1.x, upgrade together, or expect a clear
error on the older machines rather than a wrong answer. An unrecognised version always fails loudly
and writes nothing.

### A malformed command line now exits 2, not 1

**Check your CI scripts if they branch on align's exit code.** `align check` exits 1 for a red
verdict — and until now commander exited 1 for a bad command line too, so `align check --nonsuch`
(a typo, a flag from a newer version, a copy-paste error) was indistinguishable from "this
repository has violations". A script that reported architecture failures reported one that had never
happened.

Usage errors — unknown option, unknown command, missing argument — now exit **2**. `--help` and
`--version` still exit 0, and a red verdict still exits 1, so the only scripts affected are ones that
were previously being told the wrong thing.

### `align` no longer stack-traces when you pipe it into `head`

A downstream reader that closes the pipe before align finishes writing used to produce an unhandled
Node error and a stack trace on stderr. It now exits quietly, keeping whatever exit code the command
had already determined — a broken pipe never turns a red verdict green.

### `align baseline prune` now asks before it deletes

**Breaking for non-interactive use.** Every entry `prune` removes is an accepted consent decision — a
human's recorded judgement that a violation is tolerated — so removing one now requires consent (ADR
006, "silence is never consent"). Interactively `prune` prompts. **Without a terminal it refuses and
exits non-zero**, naming `--yes`.

If you run `align baseline prune` in CI or a pre-commit hook, add `--yes`:

```
align baseline prune --yes
```

A run that deletes nothing is never gated — a pure move-transfer, or a run where every candidate was
retained, proceeds silently as before. So a hook that prunes only when there is something to prune
will now stop and ask exactly once, at the moment it would have destroyed something.

**Why now.** ADR 028 made `prune` retain any entry whose absence it cannot explain, including the
common case of deleting dead code (align cannot distinguish that from a directory missing out of the
checkout). Without a gate that safety costs a second command every time; with one it costs a
keystroke.

### Deleting baseline entries from a scan align cannot trust is now refused

`align baseline prune` and `align init` both delete or overwrite accepted baseline entries. Both
used to do so on the results of any scan, including one that failed. A scan that errors evaluates no
rules at all and reports zero violations, which made every accepted entry look fixed — so a prune
after an errored scan deleted the entire baseline and printed a success line.

Two refusals now stand in front of that:

- **An errored scan refuses outright**, with no override. There is nothing a user could knowingly
  consent to when no rule was evaluated. The refusal prints the erroring gate's own diagnosis rather
  than a generic message, and exits non-zero having changed nothing.
- **A scan that could not resolve all dependencies refuses to delete**, and is overridable with
  `--allow-incomplete`. Missing dependencies drop edges from the graph, and a violation routed
  through a dropped edge is unobservable rather than fixed. `align baseline prune`, `align init` and
  `align upgrade`'s prune step all carry the flag, with identical wording and meaning.

Be aware that on a repository whose dependencies are not installed this is the ordinary case, not an
exceptional one — a fresh clone in CI, or a monorepo whose cross-package imports resolve through
`node_modules`, will hit it. That is the intended cost: those are precisely the runs whose "fixed"
verdicts were never verified. The refusal names how many entries were at risk and why.

A corrupt baseline is likewise no longer treated as an absent one. `.align/baseline.json` used to be
read as empty when it could not be parsed, so a merge-conflicted baseline silently became "nothing
accepted" and the next `align baseline accept` overwrote the file, destroying every entry. Reading a
malformed baseline now fails loudly wherever it is read, and `align init` refuses rather than
overwriting when the file exists but cannot be parsed. If you hit that error, the most likely cause
is an unresolved merge conflict — resolve it or restore from git. A run of `align init` that refuses
also no longer leaves a `.align/` directory behind on a repo that did not have one.

### `align init` no longer restamps consent records it did not author

Re-running `align init` on a repository that already had a baseline used to rewrite every surviving
entry's `acceptedAt` and `acceptedBy` to the current time and to `init-seed`/`accept-existing`. An
entry a person had accepted manually in 2024 came back looking as though `init` had accepted it
moments ago, on every re-run, including runs where nothing else was lost.

`init` now merges provenance instead of replacing it: an existing entry matching a violation the
scan observed keeps its original `acceptedAt` and `acceptedBy`, and only a genuinely new violation
is stamped by `init`. Entries whose violations a complete scan confirms are gone are still dropped —
that is what makes `init` re-runnable — under the completeness rules described above in this
section.

### `align agent run` will not merge or open a PR from a scan that could not resolve everything

The agent's terminal step rebases its work branch and runs a full check before merging or opening a
pull request. A green result there was previously enough. It no longer is: if that check could not
resolve the whole dependency graph (a `missing-dependencies` advisory), the agent escalates instead
of merging, prints the reason, and exits non-zero. The work branch and its commits are left in
place, so nothing is lost — the merge is deferred, not the work.

The same reasoning applies one level down, at the per-file loop: a fix whose verification produced a
green-but-incomplete run is escalated rather than reported as done, because an absent violation
under those conditions is not evidence the fix worked. The commit stays; it cannot be proven wrong,
only unproven.

`--allow-incomplete` overrides both, with the same name and meaning it has on `align init`,
`align baseline prune` and `align upgrade`.

Worth being blunt about the frequency: on a repository whose dependencies are not fully installed,
this becomes the common outcome rather than a rare one. Every unresolved external import feeds the
same advisory. If you run the agent in an environment without a complete install, expect the
escalation rather than a merge.

### `align agent run --dry-run` now honours the zero-coverage refusal

The agent refuses to propose fixes for a file with no detected test coverage — no scanned test file
transitively imports it — unless `--allow-untested` is passed. `--dry-run` used to skip that check
entirely and send the file's contents to the model anyway, which is exactly what the refusal exists
to prevent. Both paths now apply the same guard before any model call, so a file that would be
escalated in a real run is escalated in a dry run too. If you relied on `--dry-run` to preview fixes
for untested files, you will now see those files escalated instead.

### Accepting violations into the baseline over MCP is now opt-in

The `align_propose_rules` MCP tool has an `accept_new_into_baseline` option that writes to
`.align/baseline.json`. Any call where it would actually write — the option set, and new violations
present to accept — is now refused by default. An agent granting itself amnesty from a rule it is
failing is a decision the baseline model reserves for a human, and the tool was writing without one.
(A call carrying the option when there is no new debt writes nothing either way, so there is nothing
to refuse and it still succeeds.)

A human can enable it per project by adding `export const allowBaselineFromMcp = true;` to
`align.config.ts`. No MCP tool can set that — only an edit to the repository's own config. When the
write is refused nothing is written, and the refusal names the CLI-side equivalent for the affected
rules. If you have an agent workflow that relied on this option, it will start reporting refusals
until the config export is added.

### Commands now operate on the repository root, not the current directory

align commands used to scan from whatever directory they were invoked in. They now walk up to the
repository root — the nearest ancestor carrying `align.config.ts` or `.align/` — and operate on
that, printing a notice when the root differs from where you ran the command. Running a command
from inside `packages/foo/src` therefore checks the whole project rather than a subtree of it, and
results no longer depend on where you were standing. Invoked outside any align project, a command
now reports that cleanly instead of scanning whatever happened to be under the current directory.
`align doctor` keeps its always-exit-0 contract in that case and reports it as an advisory.

If you kept a wrapper script, a shell alias, or a habit of `cd`-ing to the repository root before
invoking align, that is no longer necessary. It remains harmless — align does not change your shell's
working directory, and never did — so nothing breaks if you leave it in place.

`align init` is the exception, and deliberately so: on a first run neither marker exists yet, so it
stays scoped to the current directory. It prints the directory it is initializing before it writes
anything, so a run from the wrong place is visible immediately.

### `.align/rules.lock.json`'s generated-rules hash is now reproducible

`rules.lock.json` records a hash of `.align/generated-rules.json`, used to detect whether the
generated file has been hand-edited since the last `align build --apply`. That hash used to cover
the file's raw bytes, which include `generatedAt` — a timestamp written for human reference and read
by no code. Two builds producing byte-identical rules therefore produced different hashes whenever
the wall clock had moved, defeating "rebuild and compare": there was no way to verify a generated
ruleset was unchanged without also asking whether the exact same millisecond had been used to build
it.

The hash is now computed over an explicitly reconstructed `{ irVersion, docPath, rules }`, excluding
`generatedAt`. `generatedAt` still appears in `.align/generated-rules.json`, unchanged, for humans
reading the file; it is simply no longer part of what the lockfile verifies. An edit that changes
enforcement — a different rule, a different selector, a removed rule — is still detected exactly as
before; a rebuild that changes only the timestamp is not, which is the intended scope of the fix.

Every `rules.lock.json` written before this change carries the old, raw-bytes hash, which will not
match the new scheme even though nothing about the generated rules changed. `align build --apply`
recomputes and rewrites the hash using an unmodified doc and code, so re-running it brings the
lockfile onto the new scheme with no other effect. Until then, `align check --frozen-rules` /
`align build --verify` recognize a lockfile on the old scheme and report it distinctly from a
genuine hand-edit, rather than accusing an untouched repo of tampering.

### An unsupported glob pattern in `excludes` now fails at load

**This is the one change in 0.2.0 that can stop a config that worked yesterday from loading at
all.** Read it if you have ever written a pattern with `!`, `[...]`, `(...)` or `|` in
`align.config.ts`.

align's glob matcher is deliberately minimal: `*` (one path segment), `**` (any depth), `?` (one
character), `{a,b,c}` brace expansion, and literal path segments. Anything outside that vocabulary
was never *matched* — it was escaped and compiled to a literal, so the pattern quietly matched
nothing at all. Component selectors have always been linted against this dialect and fail loudly.
Three sibling exports were matched by the same engine and linted by nothing:

- `excludes`
- `includeNestedCheckouts`
- `knownPublicDeepImports`

So `export const excludes = ['!vendor/**'];` or `['src/+(api|legacy)/**']` did **nothing**,
silently, forever. align scanned the paths you had asked it to skip and reported violations you
believed you had excluded, with no indication anywhere that the pattern was the reason.

**What you will see.** All three are now linted when the config loads, which means a bad pattern is
a clean, non-zero error from every command rather than a silent no-op:

```
align check: `excludes` in align.config.ts contains 'src/+(api|legacy)/**', which uses extglob
groups (`(...)`), and align's glob dialect does not support it — an unsupported pattern silently
matches nothing rather than failing. It supports `*` (one path segment), `**` (any depth), `?`
(one character), `{a,b,c}` brace expansion, and literal path segments — list patterns explicitly
(e.g. ['dist/**', 'build/**']) or use a `*` wildcard.
```

**What to do.** Rewrite the pattern in the supported dialect — usually by listing the alternatives
explicitly (`['src/api/**', 'src/legacy/**']`) or by widening to a `*`. There is no escape syntax
and no negation: if you were relying on `!` to re-include something, express the inclusion by
narrowing the exclude instead.

**Expect this to change what a scan sees.** A pattern that had been inert is now either fixed by you
or rejected — in the first case align stops looking at a subtree it used to scan, so violations
there disappear and `align baseline prune` will offer to remove their entries. That is the exclusion
finally doing what you wrote it to do, but it is a baseline change, so run `align baseline prune`
deliberately rather than being surprised by it.

### `align init` skips a directory it cannot express as a selector

Component selectors are built from directory names, and a directory name may legally contain
characters the glob dialect above cannot express — `docs (old)` is the everyday case. Writing that
name into `align.config.ts` produced a config that failed to load on the very next command, and
re-running `init` did not repair it ("align.config.ts already exists — leaving it as-is").

`align init` now leaves such a directory out of the generated config and says so:

```
Skipped 1 director(y/ies) whose name align's glob dialect cannot express: 'docs (old)/**'.
They are NOT governed by the generated config. Rename them, or add a component by hand with a
selector that reaches them.
```

The directory is simply ungoverned — no rules are scoped to it — until you rename it or write a
selector yourself. If *every* directory align detected has such a name, `init` refuses rather than
writing a config with no components in it.

Relatedly, a component selector using unsupported syntax now reports the actual problem. It used to
be diagnosed as `matches zero files. Likely cause: its directory was renamed/moved or the selector
is stale` — which sent you looking for a directory sitting exactly where you left it.

### A directory name could execute code during `align init` (security)

**Affects 0.1.x. Fixed in 0.2.0.** `align init` built `align.config.ts` by interpolating each
detected directory name into a single-quoted TypeScript string without escaping it, and align then
loads that file. A directory whose name closed the quote could therefore run arbitrary code as you,
on the next `align check`.

Reaching it required running `align init` in a repository containing a hostile directory name — so
the realistic exposure is cloning an untrusted repository and initializing align in it. There is no
sign this was ever exploited, and nothing to clean up: the payload would have lived in your
`align.config.ts`, where you can see it.

**What to do.** Upgrade. If you initialized align in a repository you did not write, open
`align.config.ts` and check that every entry under `components` is a plain quoted pattern. The
ordinary, non-malicious form of the same bug was an apostrophe — a directory named `don't` produced
a config that would not parse.

### `align check --json` and the MCP tools now say why a run errored

If you consume align's machine output — `align check --json`, or the `align_check` /
`align_violations` MCP tools — three things changed, and one of them is a correctness fix you may be
relying on the old behaviour of.

**`align_violations` no longer answers an errored scan with an empty list.** It returned
`{"violations": []}` with no error flag when a gate had errored — byte-identical to the answer for a
clean repository, for a scan that had evaluated no rule at all. It now returns an MCP error naming
the gate and its reason. A red repository still returns its violations exactly as before; only the
errored case changed.

**Errored gates now carry `errorMessage`.** The payload's per-gate objects gained an optional
`errorMessage`, present only when `status` is `error`. Before this, `align check --json` on a broken
config exited 1 with the reason on neither stdout nor stderr, while the human output printed it in
full. Passing gates still carry counts only.

**`complete` is now `false` on an errored run.** It reports whether the scan resolved everything it
was asked to, and an errored run trivially satisfied the two conditions it used to check — so a run
that evaluated nothing reported `"verdict": "error"` beside `"complete": true`. If you branch on
`complete`, this is strictly more conservative.

### `align build --verify` reports doc-built rules with no lockfile

`.align/generated-rules.json` is merged into your effective ruleset on every load, and
`.align/rules.lock.json` is the record of which document produced it. If the first exists without
the second — an `align build --apply` interrupted partway, a hand-deleted file, a `git clean` — the
rules are being enforced with no record of where they came from, and `align build --verify` /
`align check --frozen-rules` reported `ok` for exactly that state, because a missing lockfile was
read as "this repo never ran a build."

Both now report it:

```
.align/generated-rules.json is in force but .align/rules.lock.json is missing, so align cannot
tell which document produced the rules it is enforcing — most likely an `align build --apply`
that did not finish. Re-run `align build --apply` to rebuild both, or delete
.align/generated-rules.json to drop the doc-built rules.
```

A repository that has never run `align build` is unaffected and stays silent, which is what the
early return was originally there for. Separately, `align build --apply` now performs its writes
under one lock with the baseline read hoisted before the first write, so the partial state above is
much harder to reach in the first place.

### Changes that need nothing from you

Worth knowing about, but no migration:

- **`align init` and `align build --apply` refuse to rewrite a malformed align block** in
  `CLAUDE.md` or `align.config.ts` rather than guessing which content is yours. Previously an
  orphaned start marker could cause the next run to delete everything between it and the block —
  in `align.config.ts`, that meant your ruleset. If you see the new error, restore exactly one
  `<!-- align:start -->` … `<!-- align:end -->` pair, or delete both markers and let align
  re-append.
- **Config errors print cleanly and exit non-zero** instead of emitting a raw Node stack trace.
  This covers a syntax error in `align.config.ts`, a missing `default` export, a malformed
  `excludes`/`compositionRoots`/`knownPublicDeepImports` export, and a corrupt or schema-invalid
  `.align/generated-rules.json`. Schema-invalid `.align/` artifacts now name the file and list
  the offending fields instead of dumping a raw validation error.
- **`align agent run` twice in the same day works.** It used to crash on a branch-name collision;
  it now resumes onto the existing `align/fixes-<date>` branch, and refuses to continue at all
  if it cannot land on that branch.
- **`align doctor` honours your excludes the same way `align check` does.** It previously used a
  laxer matcher, so you may see fewer advisories.
- **Baseline move-transfer only fires on a real move.** Previously an orphaned entry was
  transferred onto any current violation with matching rule id + snippet in a different file —
  so fixing a violation in one file while adding a textually identical one in another, in the
  same commit, silently baselined the new one and left CI green. A transfer now requires the
  orphan's own file to have genuinely disappeared from the scan. Renames still transfer, which
  is what the mechanism exists for; `align baseline prune` was affected too and is also fixed.
- **A fix proposal listing the same file twice is rejected** rather than silently applying only
  one of the two entries' edits.
- **`align upgrade` is new.** It reads `.align/version.json`, works out what changed between the
  version that last wrote your `.align/` artifacts and the one running now, and walks the migration
  with your consent before anything is written. `.align/version.json` is itself new in this release,
  so on any repository set up by an earlier align there is nothing for it to read and the version
  you are upgrading *from* is unknown. align shows this release's notes in full rather than
  guessing. Passing `--from 0.1.4` explicitly reaches the same set, because everything described in
  this document ships in 0.2.0.
- **Version-skew detection now resolves `@spikedpunch/align-core` the way Node does**, walking up
  the directory tree instead of checking one fixed path. In a hoisted monorepo — pnpm or npm
  workspaces — core usually lives at the workspace root, so the old lookup found nothing and
  reported no skew even when there was one. Expect the skew advisory to appear in places it was
  previously silent; those are corrections, not new problems. The advisory names the install path it
  compared against, and it also reaches the MCP `align_check` payload now rather than the CLI alone.
- **`align doctor` detects a stale installed skill by content, not only by version number.** A skill
  snapshot re-rendered at the same version — which is every change to skill content that does not
  bump the version — used to be undetectable.
- **A baselined `arch.metric` file that keeps growing now produces an advisory.** `arch.metric`
  fingerprints are file-based by design, so an accepted over-length file could grow without limit
  and never change its fingerprint. align records the measured size at acceptance time and advises
  when the current value exceeds it by more than 20%. Advisory only — the verdict and the baseline
  entry are untouched. Entries accepted by earlier versions carry no recorded size and are simply
  skipped.
- **A workspace package rooted at the repository root is now recognized** by the TypeScript scanner,
  so its files classify into the component their selector names instead of falling through as
  unmapped.
- **Unknown `.align/` artifact provenance is reported by `align doctor`, not by `align check`.**
  It is a repository-health observation, and `check`'s output is for the verdict.

`align doctor` still always exits 0, including on a config error, which it reports as a
`config-error` advisory.
