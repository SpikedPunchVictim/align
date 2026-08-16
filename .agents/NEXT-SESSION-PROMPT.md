# Next session kickoff prompt

Paste everything below the line.

---

You are taking over the **align 0.2.0** release work in `/Users/spikedpunchvictim/projects/align`,
branch `fix` (80 commits ahead of `main`, nothing pushed). The previous session ended mid-flight on
**ADR 028 Stage 1**.

## Read these first, in this order, before touching anything

1. `.agents/HANDOFF.md` — start with the warning block at the top; the tree deliberately does not
   compile right now.
2. `IMPLEMENTATION_PLAN-028-scan-safety.md` — five stages with file-and-line work lists. **Do not
   re-derive the work lists**; they were built by grepping the actual call sites and they include
   packages an obvious grep misses (`packages/agent`'s test helpers construct `DependencyGraph`s).
3. `docs/adr/028-scan-blind-spots-and-the-absence-inference.md` — the authoritative reasoning.
4. `CLAUDE.md` — destructive-safety rules, binding on new work.
5. `docs/adr/027-nested-checkout-scan-scope.md` — its closing section is the lesson ADR 028
   generalizes, and its "required, not optional" argument is why the new field is required.

## Where things stand

Uncommitted: two ADR 028 docs (new), and two core type files (modified) that begin Stage 1 —
`ScanBlindSpot`/`ScanBlindSpotReason` in `types/graph.ts` with `blindSpots` replacing
`skippedNestedCheckouts`, and `CheckRun` in `gates/types.ts` gaining `blindSpots` plus a per-domain
`observedFiles`.

`pnpm typecheck` currently reports **exactly 12 errors, all in core** (`orchestrator.ts` ×11,
`payload/builder.ts` ×1), every one of them `skippedNestedCheckouts` no longer existing. That is the
types-first migration working: the compiler is enumerating the work, package by package in build
order. A different count or a different shape of error means something else changed — find out what
before continuing.

Last full-green measurement, at `f0b48c7` before these edits: **1203 passing + 1 skipped**, `align
check` green, 15/15 local integration scenarios PASS. Re-establish it with
`git stash && pnpm build && pnpm typecheck && pnpm test`, then `git stash pop`. Do not discard that
stash.

## Your task

Finish **Stage 1**, then stop and report before starting Stage 2.

Work in build order — core → plugin-typescript → cli → agent — committing per package so each
commit compiles and passes tests. The real producer work is in `plugin-typescript`'s
`walkSourceFiles`: it currently has five exits that drop a path, and a sixth case (symlinks) that
falls off the end of the loop entirely because `Dirent.isDirectory()` and `isFile()` are both false
for a symlink.

The gate, run it always (~26s):

```
pnpm build && pnpm typecheck && pnpm test
node packages/cli/dist/index.js check      # red is blocking
node packages/cli/dist/index.js doctor     # advisory only, always exits 0
```

Integration (Docker, ~38s/scenario) when the fast gate is green:
`node integration/run.mjs --targets local`

## What will bite you

- **A doc comment asserting a safety property is a claim to verify, not evidence.** This codebase
  has shipped that defect at least four times, and ADR 028 exists partly because one such comment
  ("core is the sole owner of scanning, ARCHITECTURE.md §5") cites a section that says no such thing
  while five CLI sites violate it.
- **"Reports success wrongly" is the severity-zero class.** A command that destroys data and exits 0
  outranks everything. When you find one, hunt the class, not the instance.
- **Both mechanisms in ADR 028 are required.** If you find yourself thinking the existence probe
  makes the blind-spot record redundant, re-read the measurement: `fs.existsSync` returns *false*
  for a file inside a `chmod 000` directory, so the probe alone misses a reproduced severity-zero.
- **`packages/core` imports `node:fs` nowhere.** Keep it that way — that constraint is why the
  probe is injected rather than called directly. Verify with a grep, do not assume.
- **Re-point tests, never delete them.** Every existing `skippedNestedCheckouts` test must survive
  as equivalent-or-stronger.
- **`test-apps/` is gitignored working state** holding real external repos — read-only, copy
  elsewhere before mutating. `/Users/spikedpunchvictim/projects/grizzly` is a real user project:
  do not touch it at all.

## How this user works

- **Subagents must not commit.** You verify the gates yourself, then commit.
- **Never relay a subagent's claims — re-run them.** Subagent summaries have repeatedly been
  directionally right and wrong in a detail that mattered.
- **Provision worktrees by hand**: `git worktree add -b <name> .claude/worktrees/<name> <sha>`.
  The Agent tool's `isolation: "worktree"` provisioned from a stale base twice out of three.
- **Present findings and wait for sign-off before starting a new stage.**
- Blunt, evidence-cited assessment is rewarded; hand-waving gets pushed back on. Cite measured
  numbers and `file:line`, never invent them. If you are uncertain, say so and say why.
