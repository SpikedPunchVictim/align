# align

**Architecture-conformance verification oracle for LLM coding agents.**

A fluent TypeScript DSL compiles to a portable JSON IR; a language plugin evaluates it against the
real dependency graph on every call (always a fresh scan — no stale cache to distrust); violations
surface through a CLI and an MCP server, structured for token-frugal agent consumption. See
`ARCHITECTURE.md` and `IMPLEMENTATION_PLAN.md` for the full design and `docs/adr/` for the decision
record.

## Quickstart

align is not published to a registry — install it locally from this monorepo.

```bash
# 1. Install workspace dependencies and build every package.
pnpm install
pnpm build

# 2. Make the `align` binary available on your PATH. Either:
pnpm --dir packages/cli link --global   # requires pnpm's global bin dir on PATH (`pnpm setup`)
# ...or, if that's not set up in your shell:
cd packages/cli && npm link && cd -     # links via npm's global bin instead

align --version
```

`packages/cli/package.json`'s `"bin": { "align": "./dist/index.js" }` entry (with a `#!/usr/bin/env
node` shebang already in `dist/index.js`) is what makes both of the above work — either link method
produces a real, directly-executable `align` command, not a wrapper script.

### Point it at a repo

```bash
cd /path/to/your/repo
align init          # detects components, writes a starter align.config.ts, seeds the baseline
align check         # fresh full scan; exit 0 iff green
align check --json  # same, as a structured payload
align explain <ruleId>
align doctor        # read-only advisory survey; never fails
```

`align init` also writes a `CLAUDE.md`/`AGENTS.md` agent-instructions block (idempotent,
delimited — re-running `init` never duplicates or corrupts surrounding content) so a connected
coding agent discovers align unprompted instead of falling back to ad hoc `bash` habits (ADR 009).

### Connect an MCP client (e.g. Claude Code)

```json
{
  "mcpServers": {
    "align": { "command": "align", "args": ["mcp"] }
  }
}
```

`align mcp` starts a stdio MCP server exposing `align_check`, `align_violations`,
`align_explain_rule`, and `align_propose_rules`. The server declares a condensed fix-loop protocol
in its native `instructions` field (check → fix → re-check until green; red is blocking; never
edit `align.config.ts`/`.align/**` to force green; baseline acceptance is a human decision) so a
client that surfaces server instructions gets the essentials without an extra round trip.

### `align skill` — the LLM authoring/fixing guide

```bash
align skill                          # full guide (authoring + fixing) to stdout
align skill --topic authoring        # rule kinds, DSL verbs, doc-authoring bullet grammar
align skill --topic fixing           # fix-loop protocol, baseline consent doctrine, MCP reference
align skill --install                # writes .claude/skills/align/SKILL.md into the current repo
```

The rule-kind list, DSL verb table, bullet grammar, gate list, and CLI command inventory sections
are generated live from the installed binary's own registries (the zod IR schema, the DSL builder
surface, the `commander` program) — never a hand-written prose list that can drift from what a
specific install actually supports. A CI-enforced completeness test fails the build if a new rule
kind ships without matching skill coverage.

## Repo layout

```
packages/
├── core/               # @align/core — Violation model, RuleIR (zod), the DSL (@align/core/dsl),
│                       #   gate stack, baseline, orchestrator. Zero framework dependencies.
├── plugin-typescript/  # @align/plugin-typescript — ts-morph/compiler-API dependency graph + adapters
├── cli/                # @align/cli — commander CLI; hosts `align mcp` (stdio MCP server)
└── agent/              # @align/agent — built-in BYOK fix loop (`align agent run`)
```

## Development

```bash
pnpm install
pnpm build       # tsc -p per package
pnpm typecheck
pnpm test        # vitest, per package
pnpm check       # align checking itself (dogfood) — packages/cli/dist/index.js check
```
