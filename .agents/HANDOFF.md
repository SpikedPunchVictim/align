# Handoff — align 0.2.0 release work

**Written 2026-08-11, updated 2026-08-12.** Branch `fix`, **58 commits ahead of `main`**, **no
upstream, nothing pushed**, working tree clean.

Read this, then `CLAUDE.md` (destructive-safety rules — binding on new work), then
`docs/adr/021`–`026`. The ADRs are authoritative; this file only tells you where
things stand and what is not obvious from the code.

---

## Verification baseline — establish this before changing anything

```
pnpm build && pnpm typecheck && pnpm test
node packages/cli/dist/index.js check     # must be green
node packages/cli/dist/index.js doctor    # must exit 0
```

Current, as of 2026-08-12: **1134 passing + 1 skipped** — create-align 46, core 450,
plugin-typescript 82, agent 53 (+1 skipped), cli 503. `align check` green (29 baselined, 0 red).
Measured wall-clock: build 5s, typecheck 9s, test 12s — **26s for the whole gate**, so run it
always. The Docker harness costs ~38s per scenario (~9m for the full local suite); use the tiers.

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

### Closed on 2026-08-12 (see git log for the commits)

**#21** — ADR 023 amended: tier 2 now covers BOTH of `init`'s write paths through one guard, with
`--allow-incomplete`. Reproduction found a second destructive path the original write-up missed —
the `--accept-existing` seed path silently dropped accepted entries the scan no longer observed.
`init` also stopped restamping `acceptedAt`/`acceptedBy` on entries it did not author, and now
refuses on a corrupt `baseline.json` instead of overwriting it.

**#27** — `generatedRulesContentHash` now digests an explicit `{ irVersion, docPath, rules }`, so
it is reproducible. `generatedAt` stays (provenance, read by nothing). `verifyFrozenRules` accepts
either hash: a legacy raw-bytes match reports "this lockfile predates the reproducible hash", never
the tampering message. `UPGRADING.md` has its first `## 0.2.0` section; ADR 011 has the amendment.
**The legacy fallback is temporary — delete it in a later major.**

**#22** — `areAdvisoriesComplete(advisories)` is now the one place the `missing-dependencies`
literal is compared; `isRunComplete(run)` delegates, signature unchanged. Verified by repo-wide
grep, not by trusting this document's claim that doctor's was the last copy.

**ADR 026 (new) — declared write-sets.** A command may only touch what its scenario declares. The
harness snapshots the whole tree (it previously captured a named allowlist and literally could not
see the bytes BUG #10 destroys), write-sets are fail-closed so a new scenario must declare, and
`align.config.ts`/`CLAUDE.md` carry a marker-region clause. Mirrored as a unit-test helper
(`packages/cli/test/write-set.ts`) that runs in the 26s gate. `CLAUDE.md` carries the short
enforceable version — read it before adding a feature that writes.

It found two writes nobody had ever seen: `init` appends telemetry entries to `.gitignore` on every
run, and `offerAlignScript` adds the npm script to `package.json` on every non-interactive run.
Both legitimate, both now declared.

Also closed: `build.ts` split at the verification seam (was 498 of a 500 cap — two lines from red);
`ensureAlignDir` removed from `runInit` entirely (redundant — `writeBaseline` and
`recordBaselineReconciled` self-ensure), so every refusal path now writes nothing; and a shared
`defaultConfirm` + `confirm` test seam across `init`/`upgrade`/`build`, which made the interactive
consent branches reachable by tests for the first time.

### The flaky test — fixed on diagnosis, NOT on repeated-run evidence

`upgrade-transform.test.ts`'s "idempotent end to end" was hit by four independent agents, always as
`Test timed out in 5000ms`, never as a wrong-value assertion — a duration problem, not a race. It
drives `runUpgrade` twice (real git subprocesses plus two full scans), 1–3s quiet against vitest's
5s default. Both real-git transform files now carry an explicit 30s budget.

**This is the one change in the batch committed without its own verification.** The 15-consecutive-
run check never completed, and the reproduction environment was contaminated by four concurrent
agents on one machine. Re-run the suite ~15x on a quiet box and confirm before the release.

### #25 — Should align auto-exclude nested checkouts?

A git worktree inside the repo gets scanned, and its fixtures surface as real violations. Fixed for
this repo by excluding `.claude`, but the general case affects any user running `git worktree`
inside their repo — increasingly common with agent tooling. Excludes are prefix-anchored, so a
nested checkout adds a prefix no exclude matches. **This session leaned on that `.claude` exclude
heavily** — every parallel agent worked in `.claude/worktrees/<name>`.

### The last unseamed prompt

`init/npm-script.ts` still owns its own `readline` prompt. Deliberately not unified into
`defaultConfirm`: it is `[Y/n]`, default YES, a different consent contract that unifying would
silently flip. It has no `confirm` seam, so its interactive branch is untested.

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

**Parallel agents: provision worktrees yourself.** `isolation: "worktree"` on the Agent tool
provisioned from a stale base twice out of three on 2026-08-12 — one agent nearly built against a
51-commit-old tree and caught it only via the test-count baseline. Use
`git worktree add -b <name> .claude/worktrees/<name> <sha>` and point plain agents at the absolute
path. Give every agent a test-count baseline to verify BEFORE it starts; that is what caught it.
Concurrent agents on one machine also contend enough to cause timeout flakes — see the flaky-test
note above.

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
