# Architecture Rules

This doc is align's own buildable intent source (ADR 011, `align build`) — the packages/*
constraints below compile to `.align/generated-rules.json` the same way `package.json` resolves to
a lockfile. It intentionally restates two constraints already hand-authored in `align.config.ts`
(core isolation, no cycles): rebuilding this doc merges into the existing rules rather than
duplicating them (`@spikedpunch/align-core`'s `mergeGeneratedRules`), and a violation of either one now quotes
this doc's own text — proof that `align build` slots into an already-DSL-authored repo without a
rip-and-replace.

## No Cycles

```align
{"kind":"arch.no-cycles","scope":"repo"}
```

## Core Cannot Depend On Plugin-TypeScript

- **Rule**: `core` must not depend on `pluginTypescript`.

## Core Cannot Depend On CLI

- **Rule**: `core` must not depend on `cli`.

## CLI File Size

`arch.metric` (max-LOC only) was promoted from Design Reserve 2026-07-12 on kluster ruleset evidence
(`test-apps/kluster/RULESET_REPORT.md` §6.2, `IMPLEMENTATION_PLAN.md`'s Promotion log). This is align's
own dogfood instance of it: `packages/cli/src/commands/build.ts` is the repo's largest source file at 468
lines (checked directly, `wc -l`, excluding `test/`/`dist/`) — a real, present-tense number, not a
round/aspirational one padded far above it. 500 is close enough to today's actual max that continued
growth in `cli` (the composition root, ARCHITECTURE.md §5 — the package most likely to accumulate
wiring code as new gates/commands land) will trip this rule rather than silently drift the way
`build-worker.ts` did in kluster.

- **Rule**: files in `cli` must stay under 500 lines.

## Future Direction

We'd eventually like every package boundary in this repo to carry an explicit layering statement,
not just core's isolation — that's a judgment call about how strict to make the plugin/CLI
boundary and isn't ready to become a rule yet.
