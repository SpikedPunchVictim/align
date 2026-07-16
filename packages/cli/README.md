# @spikedpunch/align-cli

The `align` command-line tool and MCP server — an **architecture-conformance verification oracle**
for humans and LLM coding agents.

`align` compiles a fluent TypeScript DSL into portable JSON IR, then evaluates it against a fresh
scan of your real dependency graph on every call — catching import cycles, layering violations, and
forbidden dependency directions that a single-file linter structurally cannot see. The same scan
carries an opt-in **dependency-security gate** that flags newly-added or non-registry-sourced
packages. Violations surface as compact, structured payloads so an agent can run check → fix →
re-check in a tight loop until the repo is green.

## Install & set up

The fastest path — bootstrap align into an existing repo with **one command** (it detects your
package manager: pnpm, npm, yarn, or bun):

```bash
pnpm create @spikedpunch/align
# equivalently: npm init @spikedpunch/align  /  yarn create @spikedpunch/align  /  bun create @spikedpunch/align
```

This installs `@spikedpunch/align-cli` + `@spikedpunch/align-core` as local devDependencies and runs
`align init` — detecting components, writing a starter `align.config.ts`, and seeding the baseline.

> Requires **Node ≥ 20**. Works with pnpm, npm, yarn, and bun (pnpm workspaces are first-class;
> npm/yarn/bun workspaces are supported).

<details>
<summary>Prefer to install manually, or run a global CLI?</summary>

```bash
# Local devDependencies of the repo you want to check (what create-align installs, by hand):
pnpm add -D @spikedpunch/align-cli @spikedpunch/align-core
align init

# ...or a global CLI (still needs @spikedpunch/align-core resolvable from the target repo):
npm i -g @spikedpunch/align-cli
```

</details>

## Everyday commands

```bash
align check     # fresh full scan; exit 0 iff green
align init      # (re)detect components, write align.config.ts, seed the baseline
align mcp       # start the stdio MCP server for a connected coding agent
```

## Your first check

```console
$ align check
  parse        green  0 violation(s)
  architecture green  0 violation(s)
  security     green  0 violation(s)
verdict: green

# introduce an import cycle (bar imports foo, which imports bar), then re-check:
$ align check
  architecture RED    1 violation(s)
  src/foo.ts:1 [arch.no-cycles:repo] Import cycle of 2 edge(s): src/foo.ts -> src/bar.ts -> src/foo.ts.
verdict: red
$ echo $?
1

# remove the back-edge, check again → verdict: green.
```

That's the whole loop: run `align check`, fix the file the violation names, check again. Every run
is a full rescan, so there's nothing stale to second-guess, and the exit code is `0` iff green — it
drops straight into CI:

```bash
align check || exit 1        # gate a PR on architecture conformance
```

Run `align explain <ruleId>` when a violation's cause isn't obvious (it renders cycle chains as a
Mermaid diagram), and `align doctor` for a read-only survey of scan blind spots (it never fails).

## Dependency security, in the same scan

That `security` line in the output above is a built-in **`security.manifest` gate** — opt-in rules
that catch supply-chain risk at the one cheap moment to review it: a dependency's first appearance.
Add them to `align.config.ts`:

```ts
c.security.manifest.newDependencyGate(), // flags a dependency name not yet accepted into the baseline
c.security.manifest.sourceHygiene(),     // flags a dep sourced from git/http/file instead of the registry
```

Both are **name-level** (a routine version bump never re-trips them) and reuse the same
human-consent baseline machinery as the architecture rules — so adding a new dependency turns the
check red until a human accepts it, then stays quiet. It reads `package.json` across every workspace
member, so a dependency slipped into any package is caught. Full details in the
[root README](https://github.com/SpikedPunchVictim/align#readme).

## Starting a new project? Greenfield mode

Declare your architecture **before any code exists**, and let enforcement grow with the codebase:

```bash
align init --greenfield
```

Every detected component starts as `empty: 'until-populated'` — its rules load immediately but stay
*provisionally green* while the component has no files, and **auto-arm the moment a real file lands**.
There's no flag to remember to flip later.

```ts
// align.config.ts — authored before src/ has a single file
import { defineProject } from '@spikedpunch/align-core/dsl';

export default defineProject({
  components: {
    core: { pattern: 'src/core/**', empty: 'until-populated' },
    api:  { pattern: 'src/api/**',  empty: 'until-populated' },
  },
  rules: (c) => [
    c.arch.noCycles(),
    c.arch.layer(c.core).cannotDependOn(c.api), // core must never import api
  ],
});
```

```console
$ align check
⚠ 2 component(s) matched no files (ungrounded, provisionally green): core, api
verdict: green

# create the FIRST real file in a component — src/core/logger.ts — and core's rules arm
# automatically. Write code that breaks the layering rule:
$ printf "import { handler } from '../api/handler.js';\nexport const log = handler;\n" > src/core/logger.ts

$ align check
  architecture RED    1 violation(s)
  src/core/logger.ts:1 [arch.no-dependency:core] core must not depend on api.
verdict: red
```

The ungrounded warning disappears on its own once a component has files, and `align doctor` then
flags the marker as safe to delete. So the rule you wrote on day zero enforces the instant the code
it governs exists — the architecture leads the code, not the other way around.

> **Security note**: `align check` executes your `align.config.ts` (and any `custom.host`
> predicates it registers). Do not run it against a repository whose config you have not reviewed —
> use `align check --untrusted` for that (see the root README).

## Built for AI coding agents

- **`align agent run`** — a built-in **BYOK (bring-your-own-key) fix loop**: point it at any
  Anthropic-Messages-compatible model and it works through your violations autonomously
  (DISCOVER → FIX → VERIFY), landing each fix as a real, reviewable commit and opening a draft PR
  (or fast-forward merging). Safe by default: it refuses a dirty worktree, never edits your rules or
  baseline to force green, and won't touch a file with no test coverage unless you opt in.

  ```bash
  export ANTHROPIC_API_KEY=sk-...          # or ANTHROPIC_BASE_URL for a compatible endpoint
  align agent run --dry-run                # preview the edits; drop --dry-run to open a PR
  ```

- **`align skill --install`** writes align's authoring + fix-loop playbook to
  `.claude/skills/align/SKILL.md` so a connected agent knows how to author rules and drive the
  check → fix → re-check loop. `align skill --topic authoring|fixing|all` prints it to stdout without
  installing anything.

- **`align mcp`** exposes `align_check` / `align_violations` / `align_explain_rule` /
  `align_propose_rules` over MCP, and `align init` drops an agent-instructions block into
  `CLAUDE.md`/`AGENTS.md` so the agent discovers align unprompted.

This package is the composition root; it wires
[`@spikedpunch/align-core`](https://www.npmjs.com/package/@spikedpunch/align-core),
[`@spikedpunch/align-plugin-typescript`](https://www.npmjs.com/package/@spikedpunch/align-plugin-typescript),
and [`@spikedpunch/align-agent`](https://www.npmjs.com/package/@spikedpunch/align-agent).

Full docs — the DSL reference, the baseline model, greenfield mode, `align build`, untrusted mode,
telemetry, and the BYOK fix agent (`align agent run`) — are in the
[root README](https://github.com/SpikedPunchVictim/align#readme).

## License

MIT
