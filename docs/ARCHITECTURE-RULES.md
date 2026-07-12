# Architecture Rules

This doc is align's own buildable intent source (ADR 011, `align build`) — the packages/*
constraints below compile to `.align/generated-rules.json` the same way `package.json` resolves to
a lockfile. It intentionally restates two constraints already hand-authored in `align.config.ts`
(core isolation, no cycles): rebuilding this doc merges into the existing rules rather than
duplicating them (`@align/core`'s `mergeGeneratedRules`), and a violation of either one now quotes
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

## Future Direction

We'd eventually like every package boundary in this repo to carry an explicit layering statement,
not just core's isolation — that's a judgment call about how strict to make the plugin/CLI
boundary and isn't ready to become a rule yet.
