# Handoff — align 0.2.0 release work

**Written 2026-08-11.** Branch `fix`, **44 commits ahead of `main`**, **no upstream, nothing pushed**,
working tree clean.

Read this, then `docs/adr/021`–`025`. The ADRs are authoritative; this file only tells you where
things stand and what is not obvious from the code.

---

## Verification baseline — establish this before changing anything

```
pnpm build && pnpm typecheck && pnpm test
node packages/cli/dist/index.js check     # must be green
node packages/cli/dist/index.js doctor    # must exit 0
```

Current, as of this handoff: **1080 passing + 1 skipped** — create-align 46, core 447,
plugin-typescript 82, agent 53 (+1 skipped), cli 452. `align check` green (29 baselined, 0 red).

If these do not reproduce, stop and find out why before doing anything else.

## What shipped this session

Five ADRs, all committed: **021** version provenance, **022** `version.json` + `align upgrade` +
migration registry, **023** incomplete-scan refusal, **024** MCP baseline-acceptance gate, **025**
cross-version integration harness.

**Task #16 (`align upgrade`) is complete** — five slices: `.align/version.json`; the three-tier
migration registry (notes / validators / transforms); notes compiled from `UPGRADING.md`; the
`upgrade` command with `--notes` / `--from` / `--allow-incomplete` / `--yes`; and the first real
transform (rewriting drifted interior-`**` selectors).

**The integration harness exists and is a release gate** (`integration/`). 15 scenarios, 2 projects
(`nest` pinned at `c3bc75c97`, and `nest-incomplete` without dependencies). Run it:

```
node integration/run.mjs --scenarios <id> --targets 0.1.4,local
```

Three scenarios carry `expectFailOn: ['0.1.4']` — they MUST fail against the published 0.1.4 and
pass against `local`. That is the harness's calibration. **If those ever go green on 0.1.4, the
harness has stopped working and nothing it reports can be trusted.** CI runs it on
`workflow_dispatch` and on `release`, never on push/PR.

---

## Pending work

Ordered by what I would do next. Every item was deliberately deferred with reasoning, not forgotten.

### #21 — Does `align init` need incomplete-scan protection? (decide, then amend ADR 023)

**The most consequential item left.** `runInit`'s zero-violation branch (`commands/init.ts:155`)
writes `[]` over an existing baseline unconditionally. That is the same destructive-overwrite shape
ADR 023 targets, and arguably worse than `prune`'s — a full wipe rather than per-entry deletion. On
a `complete: false` scan the "green" that triggers it may be a false green.

Tier 1 (errored) already covers `init`. Tier 2 does not. Not implemented because ADR 023's
Consequences name only `align baseline prune`, and changing `init`'s contract silently was out of
scope.

The open question is not "add the guard" — it is which shape is right:
(a) same as prune, refuse + `--allow-incomplete`; (b) a `complete: false` + zero-violations run
always requires `--accept-existing`-style confirmation, since "green" is exactly what cannot be
trusted on an incomplete scan; (c) `init` on a repo that already has a baseline is arguably wrong
regardless of completeness. **Needs a decision from the user, then an ADR 023 amendment.**

### #27 — `generatedRulesContentHash` is not reproducible

`rules.lock.json`'s hash digests `generated-rules.json`'s raw bytes, which embed that file's own
`generatedAt: Date.now()`. Two builds producing byte-identical rules yield different hashes. Not a
live bug (`--verify` compares stored vs current and both move together), but the artifact is not
byte-reproducible, so "rebuild and compare" silently does not work. The harness needed a
`volatile-hash-json-keys` normalization rule to work around it; fixing this lets that rule be
deleted. Touches ADR 011's lockfile contract, so probably wants an ADR note.

### #22 — One inline copy of the completeness predicate remains

`commands/doctor.ts:194` still has `advisories.some((a) => a.kind === 'missing-dependencies')`
inline. `isRunComplete` (`core/src/gates/advisories.ts:22`) is the shared predicate and has three
callers. Doctor's is display-only, so no bug today — but this repo has been bitten repeatedly by a
missed Nth copy. Unifying needs a signature change (doctor holds an advisories array, not a
`CheckRun`).

### #25 — Should align auto-exclude nested checkouts?

A git worktree inside the repo gets scanned, and its fixtures surface as real violations. Fixed for
this repo by excluding `.claude`, but the general case affects any user running `git worktree`
inside their repo — increasingly common with agent tooling. Excludes are prefix-anchored, so a
nested checkout adds a prefix no exclude matches.

### #24 leftovers — harness coverage gaps (acceptable, recorded)

`doctor` beyond always-exit-0; multi-hop `--from` (untestable — only one registry entry exists);
version-skew with two versions installed; `docs`/`skill` diffed across versions. `agent` is
permanently out of scope (needs a live model; the harness must stay model-free).

### #11 → #12 → #13 — the release chain

**#11 bump the version.** Use `pnpm release:version`. 0.2.0, not 0.1.5 — this release has breaking
behaviour: baseline fingerprint churn across four rule kinds, `prune` now refusing on errored and
incomplete scans, and MCP `accept_new_into_baseline` gated off by default.

**Do not forget:** after bumping, **re-run `align skill --install`** and confirm `align doctor`
reports no stale-skill advisory. The skill snapshot carries the version stamp, so any bump re-stales
it, and the content hash does not save you — the version branch short-circuits first. This was
verified the hard way.

Then #12 push + PR, #13 publish per `RELEASING.md` (five packages, lockstep versions).

---

## Things that are not obvious and will cost you if you miss them

**How this user works.** Implementation goes to **Sonnet subagents**; coding standards live at
`/Users/spikedpunchvictim/temp/enterprise-apps/CODING_BEST_PRACTICES.md`. Subagents are told **not
to commit** — the managing agent verifies, then commits. The user rewards blunt, evidence-cited
assessment and pushes back on hand-waving. Present findings and wait for sign-off before starting a
new stage.

**Verify agent reports; do not relay them.** Multiple times this session a subagent's summary was
directionally right but wrong in a detail that mattered, and twice a subagent reported test counts
measured against a tree another agent was concurrently editing. Re-run the gates yourself.
Specifically: when two subagents share a working tree, their test numbers are worthless — use a
git worktree, or run them sequentially.

**The recurring defect class in this codebase: a doc comment asserting a guarantee nothing
implements.** Found three times in four days — `allowBaselineFromMcp` (documented gate, never
built, while an ungated MCP path wrote the baseline), the harness's `fileUnchanged` docstring
(promised a loud failure on absent-in-both, actually `undefined === undefined`), and the same
shape in `skill/fix-loop-protocol.ts`. **Treat a comment describing a safety property as a claim to
verify, not as evidence.**

**"Reports success wrongly" outranks everything here.** It is the project's severity-zero class and
it keeps recurring: `prune` deleting accepted debt while printing success; the harness's own
false-green paths; a test that silently *skipped* rather than failed. When you find one, hunt the
class, not the instance.

**Cite measured numbers, never invent them.** Two ADRs record cases where a number was applied to a
question it did not bear on (churn magnitude used to justify a decision about provenance
granularity, and again about config-level breakage). Both are written up in ADR 022's Design
Reserve as errors, deliberately.

**`test-apps/` is gitignored** and holds six real external repos with real baselines. Treat it as
read-only working state — copy elsewhere before mutating. `/Users/spikedpunchvictim/projects/grizzly`
is a real user project and was strictly read-only all session.

**The churn number people will want to cite is softer than it looks.** ADR 022's 2.9% (n8n) and the
harness's ~1.0% (nest) are both real measurements, but neither cleanly attributes to fingerprint
churn — both repos scan `complete: false`, so some share may be a completeness artifact. Say
"upper bound", not "the churn rate".

**`packages/cli/package.json` is still `0.1.4`.** The upgrade scenario works anyway because a real
published 0.1.4 predates ADR 022 and never wrote `version.json`, so `upgrade` sees
`rangeFrom = 'unknown'` — which is also the realistic case for every pre-0.2.0 install. It keeps
working after the bump.
