# @spikedpunch/align-cli

The `align` command-line tool and MCP server — an **architecture-conformance verification oracle**
for humans and LLM coding agents.

`align` compiles a fluent TypeScript DSL into portable JSON IR, then evaluates it against a fresh
scan of your real dependency graph on every call — catching import cycles, layering violations, and
forbidden dependency directions that a single-file linter structurally cannot see. Violations
surface as compact, structured payloads so an agent can run check → fix → re-check in a tight loop
until the repo is green.

## Install

```bash
npm i -g @spikedpunch/align-cli   # or: pnpm add -D @spikedpunch/align-cli
align --version
```

## Quickstart

```bash
align init      # detect components, write a starter align.config.ts, seed the baseline
align check     # fresh full scan; exit 0 iff green
align mcp       # start the stdio MCP server for a connected coding agent
```

> **Security note**: `align check` executes your `align.config.ts` (and any `custom.host`
> predicates it registers). Do not run it against a repository whose config you have not reviewed —
> use `align check --untrusted` for that (see the root README).

This package is the composition root; it wires
[`@spikedpunch/align-core`](https://www.npmjs.com/package/@spikedpunch/align-core),
[`@spikedpunch/align-plugin-typescript`](https://www.npmjs.com/package/@spikedpunch/align-plugin-typescript),
and [`@spikedpunch/align-agent`](https://www.npmjs.com/package/@spikedpunch/align-agent).

Full docs — the DSL reference, the baseline model, greenfield mode, `align build`, untrusted mode,
telemetry, and the BYOK fix agent (`align agent run`) — are in the
[root README](https://github.com/SpikedPunchVictim/align#readme).

## License

MIT
