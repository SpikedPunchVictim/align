# Cross-version integration harness

ADR 025. Installs real, arbitrary versions of align (published `0.1.0`–`0.1.4`, or `local` — the
working tree, packed) into a real, pinned-commit OSS project, runs scripted command sequences
against it, and asserts on captured file state. No AI in the loop anywhere — every assertion is a
plain data comparison; a human or an agent reads the results afterward, neither participates in
producing them.

## Why this exists

align's 962 unit/integration tests all run against fixtures, executed by whatever build sits in
the working tree. None of them can express "install align 0.1.4 in a real project, create a
baseline, upgrade to local, and assert the behavior changed the way the release notes claim" —
that is inherently a cross-version statement a single process holding a single build can't make.
See `docs/adr/025-2026-08-08-cross-version-integration-harness.md` for the full rationale.

## Layout

```
integration/
  README.md          — this file
  Dockerfile          — reproducible container build (git, pnpm, node 24)
  run.mjs             — entry point / CLI
  lib/                — capture, normalize, assert, version-install, project prep, mutations, mcp-client
  scenarios/          — one file per scenario, each exporting a plain data object
  projects/           — project definitions (nest, and nest-incomplete — see "Projects" below)
  fixtures/           — (still unused as of increment 2 — no scenario has needed a hand-authored
                         align.config.ts variant yet; every scenario constructs its config state via
                         `align init` + a named mutation instead)
  results/            — run output — gitignored, safe to delete any time
```

## Running locally

```sh
# from the align repo root, after `pnpm -r build` (the harness packs the working tree for 'local')
node integration/run.mjs                                          # all scenarios, target: local
node integration/run.mjs --targets 0.1.4,local                    # the red/green proof, side by side
node integration/run.mjs --scenarios prune-errored-run-destroys-baseline --targets 0.1.4,local
node integration/run.mjs --project nest --targets local --keep-all --out /tmp/my-run
```

Flags:

- `--project <id>` — which `projects/<id>.mjs` to run against (default `nest`).
- `--targets <v1,v2,...>` — align versions to test, comma-separated: published version strings
  (`0.1.0`–`0.1.4`) or the literal `local` (default `local`).
- `--scenarios <id1,id2,...>` — which scenario files to run (default: every scenario authored for
  `--project`).
- `--tags <tag1,tag2,...>` — select scenarios by `tags` (ADR 026 item 3), OR semantics: a scenario
  runs if it carries AT LEAST ONE of the listed tags. Combines (intersects) with `--scenarios` when
  both are given. An empty match (a typo'd tag) is a hard error at startup, the same "refuse to
  report a zero-scenario run as passing" discipline `--project`/`--gate-target` already have. See
  "Tiers" below.
- `--gate-target <version>` — which target's results decide the process exit code (default:
  `local` if present in `--targets`, else the first target). Other targets' failures are printed
  but never fail the process — this is how a scenario can be RUN against a known-buggy published
  version (proving the harness can go red) without that being treated as a CI failure. **Must be
  one of `--targets`** — an unmatched `--gate-target` (a typo, e.g. `locl`) is a hard error at
  startup, not a silent zero-row match that reports success.
- `--out <dir>` — where to write results (default `integration/results/<timestamp>/`).
- `--keep-all` — keep every working copy, not just failed ones (default: working copies are
  deleted on a PASS and preserved on FAIL/ERROR for post-hoc diagnosis).

## Running in Docker

```sh
docker build -f integration/Dockerfile -t align-integration .
docker run --rm align-integration --project nest --targets 0.1.4,local
```

The image builds align from the working tree (so `local` always tests the code actually under
review, never a stale prior build) and bakes in git/pnpm/node. `integration/results/.cache` is
NOT baked into the image — bind-mount it (`-v $(pwd)/integration/results/.cache:/workspace/align/integration/results/.cache`)
across runs to reuse the cloned-and-installed project base and avoid repeating the (slow) `npm ci`
step on every container invocation.

The container runs as `node` (uid 1000), not root, and that is a test requirement rather than
hardening: `chmod 000` does not stop root, so `blind-spot-unreadable-retains` cannot create the
blind spot it exists to test when the harness runs privileged. If you bind-mount
`integration/results/.cache`, make it writable by uid 1000 or the run will fail on its first
write.

## Tiers (ADR 026 item 3)

Two npm scripts at the repo root turn a flag combination into one remembered command:

```sh
pnpm run integration:dev        # fast/dev tier — node integration/run.mjs --targets local
pnpm run integration:release    # full cross-version release gate — --targets 0.1.4,local
```

`integration:dev` is the tier to run while iterating on a change — Docker/network cost but no
cross-version matrix (see "Timings" below for measured numbers). `integration:release` is the
release gate CLAUDE.md's "Verifying a change" section and ADR 025 §6 describe: required before
publish, and where the pinned scenarios' red/green calibration is actually exercised (0.1.4 is only
installed in this tier). The count is deliberately not written here: it was "three" for long enough
to go stale (ten as of 2026-08-20) and a stale count in prose is worse than none, because it reads
as verified. `run.mjs` prints the live number per target — "all N pinned scenario(s) went RED as
required" — and CLAUDE.md gives the recount command.

`--tags` (see "Flags" above) is the finer-grained selector underneath both scripts — e.g.
`node integration/run.mjs --tags destructive --targets local` runs only the scenarios exercising a
command capable of deleting or overwriting previously-persisted state (`baseline prune`, `baseline
accept`, `build --apply`, `upgrade --yes`, `skill --install`, `align init`, and MCP
`accept_new_into_baseline` — see each scenario file's own write-set comment for why it does or
doesn't carry the tag). Add more tags to a scenario's `tags: [...]` array as new tiering needs show
up; `destructive` is the one ADR 026 names explicitly.

**Timings** (measured 2026-08-12, warm cache, this machine): a full `--targets local` run of all 14
`nest`-project scenarios took ~9m52s before the ADR 026 write-set invariant landed and ~14m0s after
— but that delta is NOT the invariant's own cost. Measured directly: one whole-tree snapshot walk
over the cached `nest` base checkout (2147 files outside `.git/`/`node_modules/`) takes ~267ms: two
walks (before/after) × 14 scenarios ≈ 7.5s total, matching ADR 026's "costs approximately nothing
at runtime" claim. The larger observed delta is machine-load variance between the two runs (a
shared dev machine with several other concurrent processes), not something intrinsic to this
change — re-measure on a quiet machine/CI runner for a cleaner comparison.

## The write-set invariant (ADR 026)

**A command sequence may create, modify, or delete only the paths its scenario declares in
`writeSet`; every other path in the project tree must be byte-identical afterward.** Full rationale:
`docs/adr/026-2026-08-11-declared-write-sets.md`. Two checks, both applied universally by `lib/scenario-
runner.mjs` — never opted into per scenario, so a new scenario can't forget them:

1. **Whole-tree delta** (`lib/write-set.mjs`'s `checkWriteSet`) — every path under the project root
   (content hash + file mode), minus a volatile set (`.git/`, `node_modules/` — see that file for
   why each is excluded), snapshotted once before the scenario's first step and once after its
   last. Every added/modified/deleted path must be a member of `writeSet`, an array of EXACT,
   repo-relative POSIX paths (never globs — `lib/spec-validate.mjs` rejects `*`/`?`, absolute
   paths, `..`, and `\`). **A scenario with no `writeSet` gets the empty one** — fail closed, so a
   new scenario fails loudly until its author declares what the command sequence is licensed to
   touch. On failure, the offending paths are named explicitly, split by added/modified/deleted —
   never just "tree changed".
2. **Marker-owned content** (`lib/write-set.mjs`'s `checkMarkerOwnedRegion`) — `align.config.ts`
   and `CLAUDE.md` each wrap one align-owned region between a START/END marker pair. Declaring
   either writable in `writeSet` licenses ONLY that region; the surrounding content must stay
   byte-identical. This is BUG #10 (docs/adr/026-2026-08-11-declared-write-sets.md's motivating incident)
   expressed as a property. Evaluated per `run`/`mcpCall` step (not `mutate` — see the code comment
   in `lib/scenario-runner.mjs` for why the harness's own fixture mutations are exempt), using each
   step's own before/after capture, so a LATER command in the same scenario corrupting content an
   EARLIER command already established is still caught.

### Declaring a write-set for a new scenario

Add a `writeSet: [...]` array (and, for a command that can delete/overwrite existing state, `tags:
['destructive']`) alongside the scenario's `id`/`project`/`steps`. List every path the scenario's
own `install`/`run`/`mcpCall`/`mutate` steps actually touch — trace it from `packages/cli/src/
align-dir.ts` (the one module that performs all `.align/*` I/O) and the command's own file under
`packages/cli/src/commands/`, the same way every existing scenario's write-set comment does; don't
guess. **If the harness reports a write-set violation you didn't expect, that is the invariant
working — investigate why the command wrote there before widening the declaration.** Widening a
write-set to make a failure go away without understanding the write defeats the entire point of
this ADR (see CLAUDE.md's "Destructive safety" section: "Do not widen a write-set to make a test
pass without understanding why the command is writing there").

## What the artifacts mean

Every run writes, per `(target, scenario)` pair, under `--out`:

- `steps.json` — `{ steps: [...], writeSetCheck }`. `steps` is every step's full captured detail:
  raw stdout/stderr/exit code, raw and normalized `.align/*` file contents, raw and normalized
  `align.config.ts` and the CLAUDE.md align block, before and after the step. `writeSetCheck` (ADR
  026) is the whole-scenario write-set result: `{ pass, failures, added, modified, deleted }`.
  Enough to diagnose a failure without re-running.
- `normalized.json` — the same shape, `steps` stripped to only the normalized fields (no raw text,
  no `durationMs`, no `capturedAt`) — this is the determinism-check artifact: two runs of the same
  scenario against the same version should produce byte-identical `normalized.json` files.
  `writeSetCheck` is already normalized (path lists and pass/fail only, no raw content).
- `result.json` — the short version: pass/fail, which steps failed and why, plus `writeSetCheck`.

`summary.json` (one per run, at the top of `--out`) is the whole run's matrix:
`(target, scenarioId) -> pass/fail/errored`, plus `complete`, `ranScenarios` and
`expectedScenarios`.

**Read `complete` before reading anything else.** A run interrupted by Ctrl-C or a cancelled CI job
still writes this file, from a SIGINT/SIGTERM handler, with `complete: false` and only the pairs that
actually ran (LEDGER D048). The interrupted run also refuses to print "all scenarios passed" and
exits non-zero even when nothing failed — `N of M scenario(s) ran, none failed. NOT a pass`. An
absent `summary.json` means the run died before it could report at all (a `SIGKILL`, or a crash in
setup); a present one with `complete: false` means it reported honestly about a partial matrix.

Working copies under `results/.cache/work/` are preserved for failures so you can inspect them, with
one exception: a failure that the scenario **pinned** via `expectFailOn` for that target is the
expected result, not a diagnosis case, so its copy is removed. Before that exception existed a single
cross-version matrix run leaked ~10 full project copies; the measured accumulation was 21 GB.
`--keep-all` still keeps everything, and `results/<runId>/<target>/<scenario>/` keeps the JSON
artifacts either way.

## Enforcing the red/green proof (`expectFailOn`)

A scenario file may declare `expectFailOn: ['0.1.4']` (a plain array of target strings) alongside
its `id`/`project`/`steps`. This makes the scenario's whole reason for existing — "this MUST go red
against a version known to have the bug" (ADR 025 §5) — a machine-checked property of the run, not
prose in a comment. If any target named in `expectFailOn` is included in `--targets` for this
invocation and that scenario does not go red **by failing its assertions**, `run.mjs` reports a
**red/green calibration break** and exits non-zero — independent of `--gate-target`, since this
represents the harness's own ability to detect a known bug breaking, not a per-target result.

Two outcomes break a pin, and the run says which:

| outcome | verdict | what it means |
| --- | --- | --- |
| FAIL (assertions failed, no harness error) | the pin holds | the bug is still detected |
| `PASSED` | **break** | the scenario no longer detects the bug it exists to detect |
| `ERRORED` | **break** | the assertions never ran, so the pair proved nothing either way |

`ERRORED` was counted as the pin holding until 2026-08-20 (LEDGER D068) — the check only ever asked
`m.pass`, so a pinned pair that blew up during install satisfied its pin and the run printed "went
RED as required" over it. The check now lives in `lib/calibration.mjs` and is unit-tested
(`lib/calibration.test.mjs`, run by `pnpm test:harness` before any scenario executes); it was an
inline closure inside `run.mjs`'s `main`, which is why nothing could test it. `scenarios/prune-errored-run-
destroys-baseline.mjs` sets `expectFailOn: ['0.1.4']`; run it with `--targets 0.1.4,local` (or any
target list including `0.1.4`) and both the ordinary gate AND the calibration check are exercised.

## Scenario/spec validation

Every scenario file is validated at LOAD time (`lib/spec-validate.mjs`, called from `run.mjs`
before any scenario executes) — a scenario with an unrecognized `expect`/`assert` key, an `expect`
block that asserts nothing (`{}`), an empty-string content check (`stdoutContains: ''`), a step
with more than one action key, or a `project` field that doesn't match a real `projects/*.mjs` id,
throws immediately and the run never starts. This closes the class of false green where a typo'd
key (`stdouContains`, `exitCode`) silently degrades a real assertion into a no-op that passes on
every version, including the buggy one the scenario exists to catch.

The scenario object's own top-level keys are validated the same way (`id`, `project`, `description`,
`steps`, `writeSet`, `tags`, `expectFailOn` — anything else throws), and ids must be unique across
the corpus. That level was unchecked until 2026-08-20 (LEDGER D069): every nested vocabulary in the
file was enumerated when it was written, and the outermost one never was, so `expectFailsOn`
silently un-pinned a calibration scenario and `tag` silently dropped one out of every `--tags`
selection. `expectFailOn: ['local']` is also refused — a pin names a *published* version that has
the defect, and `local` is the gate target.

A scenario result is one of three things, and they mean different things:

- **PASS** — every step's declared expectation held.
- **FAIL** — the harness ran to completion, but a declared expectation did NOT hold (e.g. `align
  baseline prune` exited 0 when the scenario declared it must exit 1). This is align's behavior
  disagreeing with the scenario's declared contract — the harness working as intended.
- **ERROR** (`errored: true` in `result.json`) — the harness itself could not execute the
  scenario (a process launch failure, a genuinely-failed `npm install`, an unknown mutation name).
  Always a harness/environment bug, never a statement about align.

## Why `{ install: 'target' }`

A scenario file declares its expectations ONCE — the CORRECT/fixed behavior — using the sentinel
`'target'` for its install step(s), meaning "whatever version this invocation is testing"
(resolved by `--targets` at run time, `lib/scenario-runner.mjs`'s `resolveVersion`). The SAME
scenario file is then run against several concrete versions. This is the whole mechanism behind
"the harness must be able to fail" (ADR 025 §5): `prune-errored-run-destroys-baseline.mjs` declares
`{ run: 'baseline prune', expect: { exit: 1 } }` — the fixed behavior — once. Run it against
`0.1.4` and that expectation is FALSE (0.1.4 actually exits 0), so the harness reports the
scenario RED against a real published bug. Run it against `local` and the expectation holds —
GREEN. Nothing in the scenario file changed between those two runs; only which version was
installed did.

## Normalization

Normalization is mandatory and is the part most likely to be got wrong (ADR 025). Two strategies,
by artifact shape — see `lib/normalize.mjs`'s `NORMALIZATION_CATALOG` for the authoritative,
in-code version of this table (this section is a human-readable mirror of it):

| Rule | What it normalizes | What getting it wrong would MASK |
| --- | --- | --- |
| `volatile-json-keys` | `.align/*.json` fields named `acceptedAt`, `exportedAt`, `builtAt`, `generatedAt`, `scannedAt` — blanked by exact key name | Only ever masks the named field's own value, never a sibling. A regression that stamps the WRONG baseline entry is still visible, because `fingerprint`/`ruleId`/`file`/`acceptedBy` are compared unnormalized. |
| `absolute-path-to-repo-relative` | The working copy's absolute path (and its macOS `/private/...` realpath) in any text | A bug that reads a genuinely different, unrelated tree would still normalize away IF that tree happens to share the working copy's path prefix — doesn't for the common case (paths from a different scenario run, a different project). |
| `wall-clock-durations` | `123ms`, `1.4s`-shaped tokens in free text | A component/file legitimately named with a trailing "ms"/"s" segment (none exist in align's own output today). |
| `iso-timestamps` | ISO-8601 timestamps in free text, either Zulu (`...Z`) or an explicit numeric UTC offset (`...+00:00`) | Shape-only — a timestamp that's the right SHAPE but the wrong VALUE (off-by-one-day) is NOT caught by this rule; assertions needing an exact value must read the structured JSON field instead. |
| `volatile-hash-json-keys` (increment 2) | `rules.lock.json`'s `generatedRulesContentHash` — a hash of `generated-rules.json`'s RAW bytes, which embed that file's own `generatedAt: Date.now()`. Found by the harness's own two-run determinism check (2026-08-10): two identical `build --apply`/MCP-apply runs produced a byte-different `rules.lock.json`, differing ONLY in this field. | Only ever masks this named field's own value — never a sibling (`docPath`/`docContentHash`/`sections` on the same entry are compared unnormalized). Deliberately a named key, not a blanket hex-string regex — see the `volatile-json-keys` masks note for why that distinction is load-bearing. |
| `known-align-versions` | The five published version strings (`0.1.0`–`0.1.4`) in free text, unless a capture requests `keepVersion: true`. Boundary-anchored: a match is never preceded/followed by a digit or `.`, so `10.1.4`, `@nestjs/core@10.1.3`, etc. are left alone and distinct versions never collide on one placeholder. | None of increment 1's scenarios assert ON the installed version, so this was safe by default; increment 2's `upgrade-with-existing-baseline.mjs`/`upgrade-notes-read-only.mjs` DO (the transition line), and opt out per-step via `keepVersion: true` (see "Adding a scenario" above) rather than changing the default. |

Content hashes: none of increment 1's captured artifacts (`.align/baseline.json`, `.align/ruleset-ir.json`
when present, `align.config.ts`, the CLAUDE.md block) embed a volatile content hash today — the
align skill snapshot's content-hash marker is the one place align emits one, and it isn't part of
this increment's captured artifact set. If a future artifact adds one, it needs a NAMED rule the
same way `volatile-json-keys` is named — never a blanket hex-string regex, because violation
fingerprints (also 16-hex tokens, e.g. `b26ffb86865fc059`) are exactly what the prune scenario's
assertions need to compare byte-for-byte; a blanket hash regex would silently defeat the harness's
one load-bearing property.

## Version installation

Published versions (`0.1.0`–`0.1.4`): plain devDependency version strings for
`@spikedpunch/align-cli` and `@spikedpunch/align-core`; npm resolves
`@spikedpunch/align-agent`/`align-plugin-typescript` transitively from the registry, because
align's own release process rewrites each package's `workspace:*` dependency to the exact
published version at publish time (verified: `npm view @spikedpunch/align-cli@0.1.4 dependencies`
shows `"@spikedpunch/align-core": "0.1.4"`, a bare version).

`local`: `pnpm pack` the four working-tree packages (core, plugin-typescript, agent, cli, in that
dependency order — `lib/version-install.mjs`). **The fiddly part**: `pnpm pack` ALSO rewrites
`workspace:*` to the CURRENT version number (verified empirically — packing `plugin-typescript`
produces a tarball whose `package.json` says `"@spikedpunch/align-core": "0.1.4"`, indistinguishable
from a real published dependency spec). Since the monorepo's current version (`0.1.4`) is also the
latest PUBLISHED version, installing the packed `align-cli` tarball naively would have npm resolve
its declared `align-core@0.1.4` from the REGISTRY — silently testing a mix of local cli/core and
published agent/plugin-typescript. Fixed with npm's `overrides` field (npm >= 8.3): every
transitive resolution of the four `@spikedpunch/*` names is forced to its local tarball regardless
of what version range is declared anywhere in the tree. No version bump needed, no publish-time
coordination — `packages/*/package.json`'s `version` fields stay untouched.

Every install is verified afterward (`installAlignVersion` reads back
`node_modules/@spikedpunch/align-cli/package.json`'s `version` and throws if it doesn't match what
was requested) — a silently-wrong-version install would otherwise produce a confusing scenario
failure several steps later instead of a clear one immediately.

For `local` specifically, the version-string check alone cannot detect a silent registry fallback:
the working tree's version (`0.1.4`) equals the latest PUBLISHED version for the entire life of an
unreleased bump, so a registry-resolved `0.1.4` and a genuine local-tarball `0.1.4` report the same
version string. Two additional, independent checks run only for `local`
(`verifyLocalInstallAuthenticity` in `lib/version-install.mjs`): every one of the four
`@spikedpunch/*` packages must show a `file:`-prefixed `resolved` field in `package-lock.json`, and
each package's installed `dist/index.js` must be sha256-identical to the working tree's own build.
Either check failing throws loudly rather than silently testing a Frankenstein mix of local and
published packages.

## Adding a scenario

A scenario is a plain data object (no functions) with an `id`, a `project`, and an ordered `steps`
array. Each step is exactly one of:

```js
{ install: 'target' | '0.1.4' | 'local' }
{ run: '<align subcommand and flags, no "align" prefix>', keepVersion?: true,
  expect?: { exit, stdoutContains, stdoutNotContains, stderrContains, stderrNotContains, stdoutMatches } }
{ mcpCall: { tool: '<MCP tool name>', arguments: {...} }, keepVersion?: true,
  expect?: { isError, textContains, textNotContains } }
{ mutate: '<name registered in lib/mutations.mjs>' }
{ snapshot: '<label>' }
{ assert: { kind: 'fileUnchanged' | 'fileChanged', file: '.align/baseline.json' | 'align.config.ts' | 'CLAUDE.md', since: '<snapshot label>' } }
{ assert: { kind: 'jsonArrayLength', file: '...', equals: N } }
{ assert: { kind: 'exists', file: '...', equals: true | false } }
```

**`mcpCall` (increment 2, ADR 025 §7 `mcp` row)** calls one MCP tool over a REAL `align mcp` child
process — genuine stdio JSON-RPC via `@modelcontextprotocol/sdk`, the same SDK
`@spikedpunch/align-cli` depends on and that is therefore already installed in the working copy's
own `node_modules` (`lib/mcp-client.mjs` — no new runtime dependency for the harness itself).
Deliberately NOT the CLI test suite's in-process `InMemoryTransport` — that never exercises the
actual `align mcp` subcommand or its stdio framing. `isError: true` on a well-formed tool response
(e.g. ADR 024's gate refusing a write) is a normal, expected outcome for `expect` to check, exactly
like a non-zero exit code on a `run` step — never an exception. A transport-level failure (the
child process couldn't be launched, the handshake never completed) throws and the scenario reports
`errored: true`, mirroring `runAlign`'s launch-failure contract.

**`keepVersion: true` (increment 2)** opts a `run`/`mcpCall` step OUT of the `known-align-versions`
normalization rule (see "Normalization" below) — needed by any step whose `expect` checks a
LITERAL version number in captured text (e.g. `align upgrade`'s `"unknown → 0.1.4"` transition
line), which the default normalization would otherwise scrub to `<normalized-version>` before the
assertion ever runs. Omit it (the default) for every step that doesn't care about the exact
version string — which is most of them.

A scenario may also declare a top-level `expectFailOn: ['0.1.4', ...]` — see "Enforcing the
red/green proof" above — and a top-level `writeSet: [...]` plus optional `tags: [...]` — see "The
write-set invariant (ADR 026)" above. **`writeSet` is not optional in practice**: omitting it means
the empty write-set, and every scenario that writes anything at all (nearly all of them) will fail
until its author declares what the command sequence is licensed to touch.

`expect`/`assert` are validated at load time (`lib/spec-validate.mjs`): every key above is the
COMPLETE known set for its block — anything else throws immediately rather than being silently
ignored. `fileUnchanged`/`fileChanged` compare NORMALIZED text (volatile JSON keys blanked, see the
Normalization section) — not raw bytes — and fail loudly (both kinds) if the file was absent at
both the snapshot and now, rather than treating "never existed" as "unchanged".

Declare the CORRECT/fixed behavior — see "Why `{ install: 'target' }`" above. Add a new named
mutation to `lib/mutations.mjs` rather than inlining filesystem edits into a scenario file;
scenarios stay pure data.

## Adding a project

A project is a plain object in `projects/` with `id`, `repoUrl`, `sha` (pinned commit — re-verify
with `git ls-remote <repoUrl> HEAD` before assuming it's still the branch tip), `installCmd`
(`{ command, args }` — the project's own dependency install), and, if any scenario needs a
guaranteed real violation, a `violation: { fromComponent, toComponent, because }` descriptor
(verify the one-directional dependency actually exists at the pinned commit by grep, both
directions, before relying on it — see `projects/nest.mjs`'s comment for the exact check run
against nest).

**`alignOnlyInstall: true` (increment 2)** — the flag `projects/nest-incomplete.mjs` sets: strips
the project's OWN `dependencies`/`devDependencies` before every `installAlignVersion` call
(`lib/version-install.mjs`), so the `npm install` that adds align resolves ONLY align's four
packages, never the project's real dependency tree. Necessary, not cosmetic — verified empirically
(2026-08-10): a bare `npm install <one-pkg>` against a `package.json` that ALSO lists other,
uninstalled dependencies installs those too (there is no "install just this package" mode in
vanilla npm once other deps are declared). Pair it with a genuine no-op `installCmd` (e.g.
`{ command: 'node', args: ['-e', ''] }`) so `prepareProjectBase` never runs the project's real
install either — the base checkout is then a cheap shallow clone with no `node_modules` at all,
letting `align check` report `complete: false` deterministically. Also implies `--ignore-scripts`
on that same `npm install` (`version-install.mjs`) — a project's own `prepare`/`postinstall`
lifecycle scripts (nest's root `package.json` runs `husky`) reference tooling this variant
deliberately never installs, and would otherwise fail the align install itself with an unrelated,
harness-looking error.

## Reproducibility details

- **Child-process environment is sanitized**, not inherited wholesale (`lib/exec.mjs`'s
  `sanitizeEnv`): only a small allowlist (`PATH`, `HOME`, proxy/registry config, ...) passes
  through, and `NO_COLOR`/`FORCE_COLOR`/`CI` are forced to fixed values regardless of the host or
  CI shell that invoked `run.mjs`. Without this, ANSI escape codes or CI-mode output shape changes
  leaking in from the invoking shell would make every content assertion depend on who/where the
  harness was run from.
- **The project base-checkout cache key** (`lib/project.mjs`) includes a fingerprint of the
  install command, node version, and npm version, not just the project id and pinned sha — so
  changing `installCmd` (e.g. adding a flag) invalidates the cache instead of silently reusing a
  stale dependency tree installed under the old command.
- **The `local` tarball cache directory is unique per invocation** (`<runId>-<pid>`, cleaned up on
  exit) — `packLocalTarballs` unconditionally deletes and repacks its destination directory on
  every 'local' install, so two concurrent `run.mjs` invocations sharing one directory would race.

## Scenario inventory (increment 1 + 2)

Increment 1 (four scenarios): `prune` on an errored run (the red/green proof, `expectFailOn:
['0.1.4']`), `init` on a fresh project, `check` green-then-red, `doctor`'s always-exit-0 contract.

Increment 2 adds:

- **Tier 1 (ADR 025's release-gating priorities)**: `upgrade-with-existing-baseline` (the 0.1.4 →
  local flagship — ADR 022's core contract, driven for real for the first time since the manual
  2026-08-08 measurement), `upgrade-notes-read-only`, `prune-incomplete-scan-requires-allow-
  incomplete` (ADR 023 tier 2, `expectFailOn: ['0.1.4']`, against the new `nest-incomplete`
  project), `mcp-propose-rules-baseline-gate` (ADR 024, `expectFailOn: ['0.1.4']`, the first
  scenario to use the `mcpCall` step kind).
- **Tier 2 (command coverage)**: `export-ir-then-check-untrusted`, `baseline-accept-rule-and-show`,
  `explain-known-and-unknown-rule`, `build-dry-run-apply-verify-drift`, `skill-install`,
  `docs-topics`, `telemetry-with-and-without-file`.

## What is still NOT covered after increment 2

Named honestly rather than implied covered — see the increment-2 report for the full writeup:

- **`doctor` beyond increment 1's always-exit-0 contract** — dead tsconfig aliases, unmapped files,
  workspace-orphaned packages, a stale installed skill snapshot (ADR 021 gap 3) are all still
  fixture-only, not harness scenarios. Each needs a construction on a real repo that increment 2
  ran out of scope to build.
- **Every genuinely cross-version row in ADR 025 §7's table except the four Tier-1 items above** —
  `--from` on a genuine multi-hop range (there is only one registry entry today, so multi-hop
  can't be exercised until a second one ships), a version-skewed install (binary ≠ installed core,
  needs two versions present at once), and `docs`/`skill` output compared across two installed
  versions.
- `agent` — out of scope by ADR 025 itself (needs a live model).
