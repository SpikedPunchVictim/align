# Contributing to align

Thanks for looking at align. This is a pnpm workspace with four packages
(`@spikedpunch/align-core`, `@spikedpunch/align-plugin-typescript`, `@spikedpunch/align-cli`, `@spikedpunch/align-agent`),
written in strict-mode TypeScript, tested with vitest.

## Prerequisites

- Node (see the `engines.node` field in `package.json`; CI pins Node 24)
- pnpm (see the `packageManager` field in `package.json` for the exact
  version CI pins to)

## Setup

```bash
pnpm install
```

## Build, typecheck, test

```bash
pnpm -r build       # tsc -p per package
pnpm -r typecheck   # tsc --noEmit per package
pnpm -r test        # vitest run per package
```

Run a single package's scripts with `pnpm --filter <package-name> <script>`,
e.g. `pnpm --filter @spikedpunch/align-core test`.

## Dogfood-check locally

align checks itself on every change. After building, run:

```bash
pnpm check   # node packages/cli/dist/index.js check — a fresh full scan
```

A red `pnpm check` is blocking — do not consider a structural change (new
imports, moved files, restructured modules) complete while it's red. Run
`node packages/cli/dist/index.js explain <ruleId>` to understand why a rule
fired before proposing a fix. See `align.config.ts` for this repo's own
ruleset and `ARCHITECTURE.md` / `docs/adr/` for the design record.

Never hand-edit anything under `.align/` or weaken `align.config.ts` to force
a green check — fix the code the rule is pointing at instead. Baseline
acceptance (`align baseline accept`) is a human decision, not something to
reach for under pressure to turn a red verdict green.

## Before opening a PR

Make sure all of the following are green:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r test
pnpm check
```

This is exactly what CI (`.github/workflows/ci.yml`) runs on every push and
pull request to `main`.

## Commit style

Keep commits small and logical (e.g. a metadata change separate from a CI
change separate from a docs change), and write commit messages that explain
*why*, not just *what*.
