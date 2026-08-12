# Prompt for the next session

Copy everything below the line into a fresh session.

---

Continue the align 0.2.0 release work in /Users/spikedpunchvictim/projects/align.

START HERE, in this order:
1. `.agents/HANDOFF.md` — branch state, the verification baseline, every open item with the
   reasoning behind it, and the non-obvious things that will cost you if you miss them.
2. `CLAUDE.md` — the destructive-safety rules. They are binding on new work, not advisory.
3. `docs/adr/021`–`026` — authoritative for everything shipped this cycle. **026 is the newest and
   the one most likely to affect what you do**: a command may only touch what its scenario declares.

FIRST ACTION — reproduce the baseline before changing anything:
    pnpm build && pnpm typecheck && pnpm test    # ~26s total
    node packages/cli/dist/index.js check        # green, 29 baselined
    node packages/cli/dist/index.js doctor       # exit 0
Expect **1134 passing + 1 skipped** (create-align 46, core 450, plugin-typescript 82, agent 53+1,
cli 503). If that does not reproduce, stop and find out why first.

STATE: branch `fix`, 61 commits ahead of `main`, no upstream, NOTHING PUSHED, working tree clean.
Version still 0.1.4 — not yet bumped.

## Your first job: finish #25 (nested-checkout auto-exclusion)

**The implementation is uncommitted in a git worktree: `.claude/worktrees/wt-25`, branch `wt-25`,
based on `b6d38e3`.** The changes are working-tree only and are NOT in the branch, so do not delete
that directory. Check `git worktree list` first; if it is gone, the work is lost and must be redone
from the design in `.agents/HANDOFF.md`. Consider committing a WIP snapshot onto `wt-25` before you
touch anything.

A worker finished applying the review fixes just as the last session ended, reporting 1158 passing
+ 1 skipped inside the worktree with check green. **Nobody re-ran that — verify it yourself before
trusting it.** Confirm `includeNestedCheckouts` reaches all eleven `check(`/`knownFiles(` call sites
in `packages/cli/src`, and reproduce the claim that
`packages/cli/test/nested-checkout-scan-scope.test.ts` actually catches the regression (revert one
of the `baseline.ts` fixes, watch it fail, restore) — an end-to-end test that would pass with the
bug present is worse than none.

Then complete the four items `.agents/HANDOFF.md` lists as STILL OWED under #25 — the `prune`
refusal (user-decided, and the most important), an ADR, an integration scenario, and an
`UPGRADING.md` note. Read that section; it has the detail.

When it is all green, merge it into the main tree yourself, re-run the gates there, and commit.
**Merge trap:** run merge commands from the main tree, not from inside the worktree — a `cd` into
the worktree at the start of a shell chain leaks into every following command and makes `git apply`
try to patch the worktree against itself.

## After #25

- `init/npm-script.ts` is the last prompt without a `confirm` seam (deliberately not unified into
  `defaultConfirm` — it is `[Y/n]`, default YES, a different consent contract). Its interactive
  branch is untested.
- The flaky-test fix (`166151f`) was committed on diagnosis, not on repeated-run evidence. Run the
  suite ~15x on a quiet machine and confirm before release.
- Then the release chain #11 → #12 → #13 in `.agents/HANDOFF.md`. **After the version bump you MUST
  re-run `align skill --install`** and confirm `align doctor` reports no stale-skill advisory — the
  version branch short-circuits before the content hash, so the hash will not save you. Note doctor
  has reported that advisory since before this work began; the bump-time reinstall clears it.

## How to work here

- Implementation goes to Sonnet subagents. Coding standards:
  `/Users/spikedpunchvictim/temp/enterprise-apps/CODING_BEST_PRACTICES.md`
- **Subagents must NOT commit.** You verify the gates yourself, then commit.
- **Provision worktrees by hand** — `git worktree add -b <name> .claude/worktrees/<name> <sha>` — and
  point plain agents at the absolute path. The Agent tool's `isolation: "worktree"` provisioned from
  a 51-commit-stale base twice out of three last session. Give every agent a test-count baseline to
  verify BEFORE it starts; that is the only reason the stale tree got caught.
- **Never relay a subagent's claims — re-run them.** Several reports last session were directionally
  right but wrong in a detail that mattered, and one reported a test count that did not reconcile
  with the file it had written.
- Concurrent agents on one machine contend enough to cause timeout flakes. Expect it; do not
  diagnose it as a race without checking whether the failure is a clock expiry or a wrong value.
- **Treat a doc comment asserting a safety property as a claim to verify, not as evidence.** That
  defect class has now been found five times in this repo.
- A Fable-model review of the #25 change caught a blocking defect three Sonnet agents and I all
  missed. Consider one before merging anything with this blast radius.
- Present findings and wait for sign-off before starting a new stage.
