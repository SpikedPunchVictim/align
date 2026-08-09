# ADR 025: Cross-Version Integration Harness

**Status**: Accepted

## Context

align's test suite is 962 unit/integration tests against fixtures, all executed by the version of
align sitting in the working tree. Nothing in it can express the contract that matters most for
the 0.2.0 release:

> Install align 0.1.4 in a real project, create a baseline, upgrade to 0.2.0, and assert that the
> fingerprint churn was surfaced and that consent was required before anything was deleted.

That is inherently a **cross-version** statement. A single process holding a single build cannot
make it. Three commitments now depend on being able to:

1. **ADR 022 makes it a release gate.** The transform apply pipeline ships with no real migration
   behind it. The ADR's compensating controls require driving it end-to-end on a real repo before
   release, and require the tier to be described as *unproven live* until that happens. Today that
   gate has no mechanism behind it.
2. **`align upgrade`'s whole surface is cross-version** — the transition report,
   `baselineReconciledBy`, `--from <version>`, and multi-hop notes assembly are untestable without
   several real installed versions.
3. **The number ADR 022 is built on cannot be reproduced.** The 2026-08-08 measurement (6 of 207
   n8n baseline entries churned, 2.9%) was produced by hand. It took real effort, it is the
   evidence for the upgrade design's scope, and **nobody can re-run it** to check whether a later
   release changes the answer. A load-bearing number with no reproduction path is a number with a
   shelf life.

Two enabling facts, both verified 2026-08-08:

- **Five real versions are published** — `@spikedpunch/align-cli` and `align-core` both at
  `0.1.0, 0.1.1, 0.1.2, 0.1.3, 0.1.4`. Historical upgrade paths can be exercised with genuine
  artifacts rather than synthetic ones.
- **CI already exists** (`.github/workflows/ci.yml`: build, typecheck, test, self-dogfood
  `align check`), and its commented-out tail already sketches a "consume align as a dependency"
  job. This ADR is the real version of that sketch.

## Decision

**Build a containerised, script-driven harness that installs arbitrary align versions into a real
project, runs scripted command sequences, and asserts on captured file state.**

### 1. No AI in the loop — the harness is an oracle

**No LLM call may exist anywhere inside the harness.** It runs with no API key, no model
dependency, no network beyond package installation, unattended.

This is not a cost preference. The harness exists to be *believed*, and an oracle that is not
deterministic cannot be trusted to judge anything. Two runs of the same version against the same
project must produce byte-identical output, or results cannot be diffed across versions — which is
the single property the manual n8n measurement lacked. An AI in the loop reintroduces exactly that
flaw, plus the possibility of a false green from the component whose job is detecting false greens.

Assertions are declarative: expected exit code, expected stdout match, expected file state. Never
"a model decides whether this looks right." **A human or an agent reads the results afterward;
neither participates in producing them.**

### 2. Rich artifacts, not a pass/fail bit

Because analysis is post-hoc, a red/green result is not sufficient — the captured state must be
enough to diagnose a failure *without re-running*. Every step captures:

- full stdout and stderr, and the exit code
- the contents of `.align/*` (baseline, generated-rules, rules.lock, ruleset-ir, version.json),
  `align.config.ts`, and the `CLAUDE.md` align block — **before and after**

**Normalization is mandatory and is the part most likely to be got wrong.** align's own artifacts
carry `acceptedAt`, `exportedAt`, `builtAt`, and `generatedAt` timestamps, plus absolute paths and
content hashes that legitimately vary. Captured output is normalized — timestamps to a placeholder,
absolute paths to repo-relative, volatile hashes to a stable token — before comparison. Without
this, every diff is noise and the comparison property is dead on arrival.

### 3. Scenario shape

A scenario is an ordered list of steps, declared as data, not code:

```
scenario: upgrade-0.1.4-to-local
  project: <fixture project id>
  steps:
    - install: 0.1.4                    # published version, or `local` for a packed build
    - run: align init --accept-existing
      expect: { exit: 0 }
    - snapshot: baseline
    - install: local
    - run: align upgrade --notes
      expect: { exit: 0, stdout~: "0.1.4 → " }
    - run: align upgrade
      expect: { exit: 0 }
      assert: { baseline.entries: unchanged-without-consent }
```

Versions come from npm for published releases and from `npm pack` of the working tree for `local`.

### 4. The project

**One mid-sized real OSS project, pinned to a specific commit, with `node_modules` installed in
the image.** Not n8n: at 282M and ~3.2M LOC it is the right stress case and the wrong default —
too slow for routine CI.

Installing `node_modules` is not incidental. Three of the six existing `test-apps/` repos were
unmeasurable in the 2026-08-08 spike precisely because they had none, and a missing install
produces `complete: false`, which now changes behaviour (ADR 023 tier 2). **A harness whose
dependency state is accidental cannot test a feature whose behaviour depends on dependency state.**
The container exists largely to make that state deliberate and reproducible.

A second, deliberately incomplete project variant (dependencies *not* installed) is required, to
exercise ADR 023 tier 2 and the `--allow-incomplete` override as first-class scenarios rather than
as an accident.

### 5. The harness must be able to fail

**A harness that cannot go red is indistinguishable from one that always passes**, and "reports
success wrongly" is the severity-zero defect class this project already treats as jumping the
queue. Therefore: at least one scenario must be pinned against a version known to exhibit the bug
it describes, and must go **red** on that version and **green** on the fixed one.

`align baseline prune` destroying accepted debt on an errored run is the natural candidate — it is
real, it is reproducible, and 0.1.4 has it. If the harness cannot reproduce a bug we know is
present in a published version, the harness is not yet working, regardless of what else it reports.

### 6. Where it runs

- **Not on every PR.** It needs Docker and takes minutes; unit tests remain the fast path.
- **Required before publish**, as the release-gate mechanism ADR 022 assumes.
- Manually invocable, and worth scheduling nightly once stable.
- Lives at the repo root (`integration/` or similar), not under `packages/` — it is not a
  published package.

### 7. Scenarios required for 0.2.0

Minimum set, each mapping to a commitment made in ADRs 021–024:

| Scenario | Proves |
|---|---|
| 0.1.4 → local upgrade with an existing baseline | ADR 022's core contract; reproduces the churn measurement |
| `upgrade --notes`, and `--from` on a multi-hop range | notes assembly and range selection |
| prune on an incomplete scan, with and without `--allow-incomplete` | ADR 023 tier 2 |
| prune on an errored scan | ADR 023 tier 1 — and the red-on-0.1.4 proof above |
| `accept_new_into_baseline` with the gate off, then on | ADR 024 |
| `doctor` after a version bump without re-installing the skill | ADR 021 gap 3 |
| `init` on a fresh project | the day-one path |

## Alternatives considered

**Extend the existing test suite instead.** Rejected: it cannot install a second version of
itself. This is not a gap in coverage but a gap in *kind*.

**Script it without a container, against `test-apps/`.** Rejected as the primary mechanism — that
is what the 2026-08-08 spike did, and its irreproducibility is the reason this ADR exists.
`test-apps/` is gitignored, its `node_modules` state is inconsistent, and results cannot be
compared across machines or across time.

**Let an AI drive the runs and judge the output.** Rejected on determinism, per Decision 1.

**Gate every PR on it.** Rejected: minutes-long Docker runs on every push trade a large amount of
routine friction for a signal that only changes meaningfully at release boundaries.

## Consequences

- A release acquires a new prerequisite. `align upgrade`'s transform tier stays **unproven live**
  until the harness has driven it, and that phrasing is required in release notes until it has.
- The harness becomes a maintenance surface: a new command or flag needs a scenario, and every
  release needs its migration entry exercised.
- Normalization rules are load-bearing. If they are too aggressive they hide real diffs; too
  lax and every run is noise. Expect to iterate on them, and treat a normalization change as a
  change to what the harness can detect.
- The 2.9% churn measurement becomes reproducible, and can be re-derived per release instead of
  being cited from a one-off.

## Evidence

- Published versions available for real cross-version testing: `0.1.0`–`0.1.4` on npm for both
  `@spikedpunch/align-cli` and `@spikedpunch/align-core` (verified 2026-08-08).
- The gap this closes is named in ADR 022's own compensating controls ("drive it end-to-end on a
  real repo before release"; "unproven live").
- The irreproducibility that motivates it: `.align/baseline.json` files in `test-apps/` carry no
  provenance, three of six repos lacked `node_modules` and were unmeasurable, and the writing
  version of the n8n baseline could not be established by git history, embedded version, mtime, or
  schema shape (ADR 022, Evidence).
- Existing CI: `.github/workflows/ci.yml` — build, typecheck, test, self-dogfood `align check`,
  with a commented-out consume-align-as-a-dependency job this ADR supersedes.
- Related: ADR 022 (upgrade + registry), ADR 023 (refusal tiers), ADR 024 (MCP gate),
  ADR 021 (version provenance).
