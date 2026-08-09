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
See `docs/adr/025-cross-version-integration-harness.md` for the full rationale.

## Layout

```
integration/
  README.md          — this file
  Dockerfile          — reproducible container build (git, pnpm, node 24)
  run.mjs             — entry point / CLI
  lib/                — capture, normalize, assert, version-install, project prep, mutations
  scenarios/          — one file per scenario, each exporting a plain data object
  projects/           — project definitions (today: nest)
  fixtures/           — (increment 2+) hand-authored align.config.ts variants
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

## What the artifacts mean

Every run writes, per `(target, scenario)` pair, under `--out`:

- `steps.json` — every step's full captured detail: raw stdout/stderr/exit code, raw and
  normalized `.align/*` file contents, raw and normalized `align.config.ts` and the CLAUDE.md
  align block, before and after the step. Enough to diagnose a failure without re-running.
- `normalized.json` — the same, stripped to only the normalized fields (no raw text, no
  `durationMs`, no `capturedAt`) — this is the determinism-check artifact: two runs of the same
  scenario against the same version should produce byte-identical `normalized.json` files.
- `result.json` — the short version: pass/fail, which steps failed and why.

`summary.json` (one per run, at the top of `--out`) is the whole run's matrix:
`(target, scenarioId) -> pass/fail/errored`.

## Enforcing the red/green proof (`expectFailOn`)

A scenario file may declare `expectFailOn: ['0.1.4']` (a plain array of target strings) alongside
its `id`/`project`/`steps`. This makes the scenario's whole reason for existing — "this MUST go red
against a version known to have the bug" (ADR 025 §5) — a machine-checked property of the run, not
prose in a comment. If any target named in `expectFailOn` is included in `--targets` for this
invocation, and that scenario PASSES against it, `run.mjs` reports a **red/green calibration
break** and exits non-zero — independent of `--gate-target`, since this represents the harness's
own ability to detect a known bug breaking, not a per-target result. `scenarios/prune-errored-run-
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
| `known-align-versions` | The five published version strings (`0.1.0`–`0.1.4`) in free text, unless a capture requests `keepVersion: true`. Boundary-anchored: a match is never preceded/followed by a digit or `.`, so `10.1.4`, `@nestjs/core@10.1.3`, etc. are left alone and distinct versions never collide on one placeholder. | None of increment 1's scenarios assert ON the installed version, so this is safe by default; a future version-skew scenario must opt out. |

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
{ run: '<align subcommand and flags, no "align" prefix>', expect?: { exit, stdoutContains, stdoutNotContains, stderrContains, stdoutMatches } }
{ mutate: '<name registered in lib/mutations.mjs>' }
{ snapshot: '<label>' }
{ assert: { kind: 'fileUnchanged' | 'fileChanged', file: '.align/baseline.json' | 'align.config.ts' | 'CLAUDE.md', since: '<snapshot label>' } }
{ assert: { kind: 'jsonArrayLength', file: '...', equals: N } }
{ assert: { kind: 'exists', file: '...', equals: true | false } }
```

A scenario may also declare a top-level `expectFailOn: ['0.1.4', ...]` — see "Enforcing the
red/green proof" above.

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

## What increment 1 does NOT cover

See the main report for the full list (ADR 025 scopes far more than increment 1 attempts —
`upgrade`, `export-ir`, `explain`, `build`, `mcp`, `skill`, `docs`, `telemetry`, the second
"dependencies not installed" project variant, and every genuinely cross-version scenario in the
ADR's table are all out of scope here). The four scenarios here are exactly ADR 025's increment-1
list: `prune` on an errored run (the red/green proof), `init` on a fresh project, `check`
green-then-red, and `doctor`'s always-exit-0 contract.
