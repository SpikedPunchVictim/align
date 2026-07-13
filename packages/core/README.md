# @spikedpunch/align-core

The zero-dependency (zod only) core of [align](https://github.com/SpikedPunchVictim/align) — an
architecture-conformance verification oracle for humans and LLM coding agents.

This package owns the `Violation` model, the `RuleIR` (zod) schema, the fluent DSL, the gate
orchestrator, the baseline store, and the markdown-doc→ruleset (`/build`) and deterministic
edit-apply (`/fix`) pipelines. It has **zero framework dependencies** so it stays importable without
dragging a TypeScript compiler along — the language-specific dependency-graph scanner lives in
[`@spikedpunch/align-plugin-typescript`](https://www.npmjs.com/package/@spikedpunch/align-plugin-typescript).

Most users want the `align` CLI, not this package directly — see
[`@spikedpunch/align-cli`](https://www.npmjs.com/package/@spikedpunch/align-cli). Import this package
directly only to author `align.config.ts` or to embed the engine in a custom host.

## Entry points

- `@spikedpunch/align-core` — `Violation`/`RuleIR` model, orchestrator, baseline store.
- `@spikedpunch/align-core/dsl` — `defineProject` and the fluent `ComponentContext` used by `align.config.ts`.
- `@spikedpunch/align-core/fix` — the deterministic byte-offset edit-apply engine (no LLM dependency).

See the [root README](https://github.com/SpikedPunchVictim/align#readme) and `ARCHITECTURE.md` for
the full design and the numbered decision record in `docs/adr/`.

## License

MIT
