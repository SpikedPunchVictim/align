# align

![CI](https://github.com/SpikedPunchVictim/align/actions/workflows/ci.yml/badge.svg)

**An architecture-conformance verification oracle for humans and LLM coding agents.**

align compiles a fluent TypeScript DSL into a portable JSON IR, then evaluates it against a fresh
scan of your real dependency graph on every call — no stale cache to distrust. Deterministic tools
verify (parse the code, build the graph, evaluate the rules); LLMs judge (decide what the rule
should be, propose a fix). Violations surface through a CLI and an MCP server as compact,
structured payloads instead of prose, so an agent can run check → fix → re-check in a tight loop
until the repo is green.

> 508 tests pass across four packages; align checks itself on every commit (`pnpm check`).

See `ARCHITECTURE.md` for the full design, `docs/adr/` for the numbered decision record behind
each feature, and run `align skill --topic all` for the live, binary-generated reference this
README is written to never contradict.

## At a glance

| Feature | What it does | Command / flag |
| --- | --- | --- |
| [Architecture rules](#architecture-rules) | Cycles, layering, dependency direction, per-file size limits | `align check` |
| [The baseline](#the-baseline) | Tolerates pre-existing violations as accepted debt, not silently fixed | `align baseline accept` |
| [Greenfield mode](#greenfield-mode) | Author rules before any code exists; the verdict says so honestly | `align init --greenfield` |
| [Doc-as-ruleset](#doc-as-ruleset-align-build) | Compiles a markdown doc's rules directly into the ruleset | `align build` |
| [MCP server](#mcp-server--agent-integration) | `check`/`violations`/`explain`/`propose-rules` for a connected agent | `align mcp` |
| [BYOK fix agent](#the-byok-fix-agent-align-agent-run) | Autonomous check-fix-recheck loop against any Anthropic-compatible model | `align agent run` |
| [Security gate](#security-gate-securitymanifest) | Flags new or non-registry-sourced dependencies | `security.manifest.*` |
| [`custom.host`](#customhost-predicates) | Escape hatch for an invariant no built-in rule expresses | `c.custom.host(name)` |
| [Telemetry](#telemetry-opt-in-local-only) | Local-only usage log + longitudinal summary — never a network call | `ALIGN_TELEMETRY=1` |
| [Untrusted mode](#untrusted-mode) | Checks a repo without ever executing its config | `align check --untrusted` |

## Contents

- [When to use align](#when-to-use-align)
- [Quickstart](#quickstart)
- [Components & the typed DSL](#components--the-typed-dsl)
- [Architecture rules](#architecture-rules)
- [The baseline](#the-baseline)
- [Greenfield mode](#greenfield-mode)
- [Doc-as-ruleset (`align build`)](#doc-as-ruleset-align-build)
- [MCP server + agent integration](#mcp-server--agent-integration)
- [The BYOK fix agent (`align agent run`)](#the-byok-fix-agent-align-agent-run)
- [Security gate (`security.manifest.*`)](#security-gate-securitymanifest)
- [`custom.host` predicates](#customhost-predicates)
- [Telemetry (opt-in, local-only)](#telemetry-opt-in-local-only)
- [Supporting commands](#supporting-commands)
- [Untrusted mode](#untrusted-mode)
- [How align treats trust](#how-align-treats-trust)
- [CI usage](#ci-usage)
- [Full CLI reference](#full-cli-reference)
- [Repo layout](#repo-layout)
- [Development](#development)

## When to use align

- **Enforcing architecture on a monorepo** — layering, dependency direction, and import cycles
  stop being a code-review artifact ("please don't import `api` from `ui`") and become a red/green
  check anyone (or any agent) can run.
- **Adopting standards on a legacy repo without a wall of red** — `align init` baselines every
  violation it finds on day one as tolerated debt. See [The baseline](#the-baseline).
- **Starting a project architecture-first** — declare components and rules before any code
  exists, and let the verdict tell you honestly when a component is still unbuilt. See
  [Greenfield mode](#greenfield-mode).
- **Giving a coding agent a deterministic loop to run against** — an agent that already runs
  `prettier`/`eslint`/`tsc` natively has no equivalent for "does this respect the architecture,"
  because that question requires a real dependency graph, not a single file's AST.
- **Making an architecture doc enforceable** — `align build` compiles a markdown doc's
  `- **Rule**:` bullets (or fenced ` ```align ` blocks) directly into the ruleset, so the doc a
  reviewer reads and the rules a machine checks are the same document.
- **Guarding against unreviewed dependencies** — the `security.manifest` gate flags a new
  dependency, or one sourced from git/http instead of the registry, before it becomes routine.

align is **not** a fit for a single-file script (there's no graph to check), and today it only
understands JavaScript/TypeScript repos — pnpm workspaces are first-class, npm/yarn workspace
detection is on the roadmap (see [How align treats trust](#how-align-treats-trust)).

## Quickstart

align is not published to a registry yet — install it locally from this monorepo.

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

`align.config.ts` also imports directly from `@spikedpunch/align-core` (`import { defineProject }
from '@spikedpunch/align-core/dsl'`), so a target repo needs that package resolvable through
normal Node module resolution too. A repo nested inside this monorepo's tree (as `test-apps/*` is,
for dogfooding) inherits `@spikedpunch/align-core` for free by walking up to this repo's
`node_modules`. For a genuinely external repo, link it explicitly:

```bash
cd /path/to/align/packages/core && npm link
cd /path/to/your/repo && npm link @spikedpunch/align-core
```

> **Security note**: `align check` executes `align.config.ts` and any `custom.host` predicates it
> registers — do not run it against a repository whose config you have not reviewed. Cloning an
> untrusted repo and running an agent against it? Run `align check --untrusted` instead (after
> `align export-ir` has produced `.align/ruleset-ir.json` in a trusted checkout) — it never
> imports `align.config.ts` and refuses outright if that JSON artifact is missing. See
> [Untrusted mode](#untrusted-mode).

### Point it at a repo

```bash
cd /path/to/your/repo
align init                  # detects components, writes a starter align.config.ts, seeds the baseline
align check                 # fresh full scan; exit 0 iff green
```

`align init` writes three things:

- **`align.config.ts`** — a starter ruleset: cycles-first (`c.arch.noCycles()`), plus any layering
  suggestions inferred from today's measured cross-component edges, commented out for you to
  review and uncomment rather than auto-enabled.
- **The baseline** (`.align/baseline.json`) — every violation the first check finds, so the repo
  starts green instead of red. Interactively, `align init` prints a summary and asks; in CI or any
  non-interactive shell it requires an explicit `--accept-existing` flag and exits red without it —
  silence is never treated as consent (see [The baseline](#the-baseline)).
- **A `CLAUDE.md`/`AGENTS.md` block** — an idempotent, delimited agent-instructions section so a
  connected coding agent discovers align unprompted instead of defaulting to ad hoc `bash` habits.
  Verified on a live probe: a connected agent made **zero** align calls until this block existed,
  even with the MCP server available. Discovery is configuration, not chance.

### First fix, verified end to end

```bash
$ align check
  parse        green  0 violation(s)
  architecture green  0 violation(s)
  security     green  0 violation(s)

verdict: green

# introduce a cycle (bar now imports foo, which imports bar)
$ align check
  parse        green  0 violation(s)
  architecture RED    1 violation(s)
  security     green  0 violation(s)

  src/foo/index.ts:1 [arch.no-cycles:repo] Import cycle of 2 edge(s) detected: src/foo/index.ts -> src/bar/index.ts -> src/foo/index.ts.

verdict: red
$ echo $?
1

# remove the back-edge, then re-check
$ align check
verdict: green
```

That is the whole loop: check, fix the file the violation names, check again. Never assume a fix
worked without a fresh verdict — every `align check` is a full rescan, so there's nothing stale to
second-guess.

## Components & the typed DSL

`align.config.ts` maps stable component names to file globs (or package names), then a `rules`
function receives a typed `ComponentContext` and returns an array of `RuleIR`:

```ts
import { defineProject } from '@spikedpunch/align-core/dsl';

export default defineProject({
  components: {
    core: 'packages/core/**',
    pluginTypescript: 'packages/plugin-typescript/**',
    cli: 'packages/cli/**',
    agent: 'packages/agent/**',
  },
  rules: (c) => [
    c.arch.noCycles(),
    c.arch
      .layer(c.core)
      .cannotDependOn(c.pluginTypescript, c.cli, c.agent)
      .because('@spikedpunch/align-core has zero framework dependencies (zod only).'),
    c.arch
      .layer(c.cli)
      .canOnlyDependOn(c.core, c.pluginTypescript, c.agent)
      .because('cli is the composition root; nothing else may depend on it.'),
  ],
});
```

(Adapted from this repo's own `align.config.ts`, which dogfoods align against itself.)

`c.core`, `c.cli`, etc. are typed references generated from your `components` map — reference a
name that doesn't exist and TypeScript won't compile, so a component rename is a compiler error at
the config, not a silent no-op rule at check time. Autocomplete on `c.` lists every DSL verb your
installed version supports; there's no separate schema to memorize.

`.because(text)` is structural provenance, not a comment — `align explain <ruleId>` surfaces it
later, so "why does this rule exist" has an answer attached to the rule itself instead of living in
someone's memory or a stale PR description. That's the DX case over a plain JSON/YAML rules file:
an IDE catches a broken selector before `align check` ever runs.

## Architecture rules

align ships four `arch.*` rule kinds:

| Kind | DSL verb | Catches |
| --- | --- | --- |
| `arch.no-cycles` | `c.arch.noCycles(scope?, { includeTypeOnly? })` | An import cycle within a component or the whole repo. Violations carry the per-edge chain, not just a file name. |
| `arch.layers` | `c.arch.layer(x).canOnlyDependOn(...)` | `x` depending on anything outside an explicit allowlist. |
| `arch.no-dependency` | `c.arch.layer(x).cannotDependOn(y)` / `c.arch.component(x).isIsolated()` | A specific forbidden edge, or (via `isIsolated()`) any edge in or out of `x`. |
| `arch.metric` | `c.arch.component(x).maxLinesPerFile(max)` | A file in `x` growing past `max` lines. Today only `loc` is promoted — fan-in/fan-out/instability remain reserved pending evidence. |

```ts
c.arch.noCycles(),                                    // whole-repo, default scope
c.arch.noCycles(c.core, { includeTypeOnly: true }),   // one component, widened to type-only edges

c.arch.layer(c.api).canOnlyDependOn(c.core, c.db),    // api may depend only on these
c.arch.layer(c.core).cannotDependOn(c.api),           // core must never depend on api

c.arch.component(c.core).maxLinesPerFile(500),        // files in core stay under 500 lines
```

Lead with cycles — of every real repo tested against align so far, every one had latent import
cycles its own existing tooling never flagged:

> Found **2 real cycles** in kluster (455,931 LOC, one in shipped UI code), **207 real runtime
> cycles** in n8n (3.23M LOC, untouched), and **11 real production cycles** in this repo's own
> `test-apps/directus` — all on the first run.

A cycle violation isn't just a file name — `align explain <ruleId>` renders the actual edge chain
as a Mermaid diagram, including which edge would need to break:

```
$ align explain arch.no-cycles:repo
{
  "ruleId": "arch.no-cycles:repo",
  "kind": "arch.no-cycles",
  "components": [],
  "mermaid": "```mermaid\ngraph LR\n  n0[\"src/app/foo.ts\"]\n  n1[\"src/app/bar.ts\"]\n  n0 -->|\"./bar.js\"| n1\n  n1 -. \"BREAK: ./foo.js\" .-> n0\n```"
}
```

A cycle is invisible to `tsc`/`eslint`/a single-file diff — it only exists as a property of the
whole graph, which is exactly the class of bug align's fresh full scan exists to catch that
bash-native tooling structurally cannot see.

## The baseline

A new rule (or align's very first run) on a mature repo will almost always find pre-existing
violations. Without a baseline, that's a wall of red on day one and nobody adopts the tool. align's
baseline tolerates that debt as accepted, not fixed, and consent to accept it is always explicit,
never silent:

```bash
align init --accept-existing          # CI/non-interactive: required flag, or init exits red
align baseline accept                 # accept everything currently red
align baseline accept --rule arch.no-cycles:repo   # scope acceptance to one rule
align baseline show                   # list what's baselined, and why
align baseline show --rule arch.no-cycles:repo
align baseline prune                  # drop entries for violations that no longer exist
```

Baseline entries are fingerprinted on a content snippet hash, not a line number, so moving or
lightly editing a file doesn't silently un-baseline (or double-count) a violation — `align baseline
prune` detects and reports moved entries rather than treating them as new.

Baseline acceptance is a **human decision by design**: the MCP server never self-serves it
(`allowBaselineFromMcp` defaults to `false`) — an agent under pressure to reach green cannot grant
itself amnesty from a rule it's failing.

> `align init --accept-existing` on directus (six components auto-detected, 11 real cycles found)
> went from zero to a green, enforced baseline in **4.7 seconds** — every one of those 11 cycles
> still visible and traceable, not swept away.

## Greenfield mode

Declare your architecture before a single line of code exists, and get an honest verdict instead
of a false one.

**Why**: `align`'s empty-selector-fails-by-default safety (a component matching zero files is a
load-time error) exists to catch a renamed directory or a stale glob. But that same safety fights
you on day one of an architecture-first build, where *every* component is legitimately empty. The
old workaround — a permanent `allowEmpty: true` — traded one problem for a worse one: a component
with zero files makes every rule referencing it evaluate **vacuously green**, indistinguishable in
the verdict line from real compliance. Greenfield mode replaces that permanent flag with a
self-healing one, and makes the exception visible instead of silent.

```bash
align init --greenfield      # forces every detected component to empty: 'until-populated'
```

```ts
export default defineProject({
  components: {
    core: { pattern: 'src/core/**', empty: 'until-populated' },
    // ...
  },
  rules: (c) => [/* declare your rules now — they load immediately, and auto-arm per component */],
});
```

`empty` is a 3-state component policy (`'fail' | 'allow' | 'until-populated'`, ADR 003's amendment):

| Policy | Meaning |
| --- | --- |
| `'fail'` (default) | A component matching zero files is a load-time error — align's original safety, unchanged. |
| `'allow'` | Empty tolerated permanently — now surfaced, never silent (below). |
| `'until-populated'` | Empty tolerated *and* surfaced, but self-heals: once the component has ≥1 real file, this stops firing for it and its rules enforce normally. No flag to remember to flip. |

**Verified end to end** — a component declared with `empty: 'until-populated'` and zero files:

```
$ align check
  parse        green  0 violation(s)
  architecture green  0 violation(s)
  security     green  0 violation(s)

⚠ 1 component(s) matched no files (ungrounded, provisionally green): app
verdict: green
```

```json
// align check --json
{ "verdict": "green", "ungroundedComponents": [{ "name": "app", "selector": "src/**", "policy": "until-populated" }] }
```

The moment a real file lands, the warning line disappears on its own — `align doctor` then flags
the reverse transition (`until-populated-now-populated`) so you know the marker is safe to delete:

```
$ align doctor
  until-populated-now-populated (1):
    - Component 'app' is now populated (1 file(s) classified) — remove its empty: 'until-populated' marker, it's no longer needed.
```

**The architecture-first triad workflow** — an ADR (or a plain design doc) + an implementation plan
+ an `align` rules doc, written *before* any `src/` file exists, then built one feature at a time
against a green `align check`. Validated end to end in `test-apps/GREENFIELD_TRIAD_REPORT.md` (a
4-layer, 156-line demo, 6 commits): 8 of 10 rules-doc sections compiled to enforceable rules; the
DSL caught a real design mistake before any code existed (`isIsolated()` reads as "core is a leaf"
but is symmetric — it also forbids everything else from depending on core, which is backwards for
a shared base layer); and a deliberate architecture violation in Stage 3 was caught immediately,
file and line, quoting the ADR's own rationale back at the author.

**Tier-2 `.because()`**: the report's own sharpest finding was that structured `- **Rule**:`
bullets had no way to carry a rationale — only fenced-block JSON did. That gap is now closed: a
bullet can end with an optional `Because <rationale>.` clause, parsed straight into the rule's
`.because()` provenance:

```markdown
- **Rule**: no cycles. Because a cyclic module graph is unreviewable.
```

```json
// align explain arch.no-cycles:repo
{ "because": "a cyclic module graph is unreviewable Enforced by ARCH.md:5: '- **Rule**: no cycles. Because a cyclic module graph is unreviewable.'" }
```

## Doc-as-ruleset (`align build`)

A markdown architecture doc can compile directly into the ruleset — `align build` treats it as a
buildable intent source the same way `package.json` resolves to a lockfile. There's a precision
ladder, most-trusted form first:

1. **Fenced ` ```align ` blocks** compile verbatim, zero LLM — the block is a JSON `RuleFragment`.
2. **Structured `- **Rule**: ...` bullets** parse deterministically against a fixed sentence
   grammar, optionally followed by a `Because <rationale>.` clause (see
   [Greenfield mode](#greenfield-mode)) — run `align skill --topic authoring` for every supported
   form.
3. **Free prose** goes through a two-pass human-confirmed clarification (`align_propose_rules`) —
   never straight from prose to rules without a human in the loop.

Real example, adapted from this repo's own `docs/ARCHITECTURE-RULES.md`:

````markdown
## No Cycles

```align
{"kind":"arch.no-cycles","scope":"repo"}
```

## Core Cannot Depend On CLI

- **Rule**: `core` must not depend on `cli`.

## CLI File Size

- **Rule**: files in `cli` must stay under 500 lines.
````

```bash
align build                    # dry-run: prints the diff + impact delta, writes nothing
align build --apply            # writes .align/generated-rules.json, rules.lock.json, an audit report
align check --frozen-rules     # also fails if the doc has drifted from the lockfile since the last --apply
```

Verified end to end: editing the doc after `--apply` and re-running `align check --frozen-rules`
reports `advisory (doc-drift): ARCHITECTURE.md has changed since the last align build --apply` and
turns the verdict red — so a doc and its compiled rules can't silently diverge in CI.

The distinguishing DX feature is provenance: a violation of a doc-built rule quotes your own
architecture doc's text back at you, not a generic rule-kind message —

```
src/api/task-service.ts:5 [arch.layers:api] ... Enforced by docs/ARCHITECTURE-RULES.md:34:
'{"kind":"arch.layers", ...,"because":"..."}'
```

— the person who wrote the prose recognizes their own sentence in the failure, which closes the
gap between "we have an architecture doc" and "the architecture doc is enforced."

## MCP server + agent integration

```bash
align mcp   # starts a stdio MCP server
```

```json
{
  "mcpServers": {
    "align": { "command": "align", "args": ["mcp"] }
  }
}
```

The server exposes `align_check`, `align_violations`, `align_explain_rule`, and
`align_propose_rules`, and declares its own fix-loop protocol in its native `instructions` field
(check → fix → re-check until green; red is blocking; never edit `align.config.ts`/`.align/**` to
force green; baseline acceptance is a human decision). `align init` also writes the same protocol
into `CLAUDE.md`/`AGENTS.md`, and `align skill --install` writes the full authoring/fixing
reference to `.claude/skills/align/SKILL.md` (`align skill --topic authoring|fixing|all` prints it
to stdout without installing anything) — verified: it writes a 16 KB, live-generated skill file
that can never drift from what the installed binary actually supports.

Token economy is why this matters in practice, not as an abstraction:

> A live discovery probe showed a connected agent, asked "are there architectural problems here?",
> making **zero** align calls and instead running a 5-subagent manual survey costing **~363K
> tokens and 4.5 minutes** — which still missed both real cycles align found in **2.3 seconds for
> under 900 tokens**.

Machine payloads carry structured fields only (file, line, specifier, snippet, fix hint) — never a
redundant prose `message` field — measured **51 tokens/violation vs. 182 tokens/violation** for the
equivalent prose payload, a 3.6x reduction. In an agent loop that runs check-fix-recheck dozens of
times per session, that difference is the gap between a check nobody calls and a check called
first, every time, because it's cheap enough to call first.

## The BYOK fix agent (`align agent run`)

```bash
export ANTHROPIC_API_KEY=sk-...
align agent run                 # DISCOVER -> GROUP -> PLAN+FIX -> APPLY -> VERIFY -> REPAIR -> ESCALATE -> DONE
align agent run --dry-run       # print proposed edits without applying or committing
align agent run --pr            # default: push a work branch and open a draft PR
align agent run --auto-merge    # fast-forward into base and delete the branch instead
```

**Provider-agnostic, not Anthropic-only**: the agent talks to any Anthropic-Messages-API-compatible
endpoint — set `ANTHROPIC_BASE_URL` (and, if needed, `ANTHROPIC_AUTH_TOKEN`) to point it at a local
Ollama proxy, Kimi, or any other compatible host, no code change required.

> Live-validated on Kimi K2.7 via a local Ollama-Cloud proxy: `align agent run` returned a
> schema-valid `FixProposal` on the **first call, zero schema retries**, and a full
> `--auto-merge` run converged to green in **one attempt** — proving the fix loop is genuinely
> provider-agnostic, not tuned to one vendor.

Safety rails, not defaults you have to remember to add: it refuses to run on a dirty worktree; every
applied fix is a real commit on a fresh `align/fixes-<date>` branch, never a silent working-tree
edit; it **never touches `align.config.ts` or `.align/**`** — it cannot weaken the rule it's trying
to satisfy, only fix the code the rule points at; by default it refuses to touch a file with zero
detected test coverage (`--allow-untested` opts in) and escalates rather than commits a fix that
deletes an exported symbol (`--allow-symbol-removals` opts in). Edits are search/replace blocks
matched against a unique byte offset in the original file, never full-file rewrites or line-number
diffs — an LLM is reliable at fix content but not at exact offsets, so align keeps that arithmetic
out of the model's hands entirely.

The DX case: a red check that would otherwise interrupt a human mid-task can instead be handed to a
bounded, auditable agent loop that produces a normal PR to review, not a diff you have to trust
blind. **Green from the fix agent still only means "conforms to the declared architecture," never
"correct"** — see [How align treats trust](#how-align-treats-trust).

## Security gate (`security.manifest.*`)

```ts
c.security.manifest.sourceHygiene()
  .because('Non-registry dependency sources need explicit human sign-off before they enter the tree.'),
c.security.manifest.newDependencyGate()
  .because('A newly added dependency is a new externally-sourced surface; review it before it becomes routine.'),
```

| Rule | Fires on | Notes |
| --- | --- | --- |
| `security.manifest.source-hygiene` | A dependency specifier resolving to a `git`/`http(s)`/`file`/`link` source instead of the registry or `workspace:` | Repo-wide, no component scoping. Name-level, so a routine version bump never re-trips it. |
| `security.manifest.new-dependency` | A dependency name not present at baseline time | Fingerprints every current runtime/dev dependency once; reuses the same baseline-consent machinery as architecture rules. |

**Verified end to end** — adding `left-pad` to `package.json` with these two rules active turns the
check red immediately:

```
security     RED    1 violation(s)

  package.json:6 [security.manifest.new-dependency] package.json declares dependency 'left-pad'
  (dependencies) via '^1.3.0', not yet accepted into the baseline, which rule
  'security.manifest.new-dependency' flags.
```

`security.manifest.source-hygiene` flags real, hand-verified hits on n8n: `xlsx` pinned to a
SheetJS CDN tarball and `wa-sqlite` pinned to an unreleased git commit. Both rules are name-level,
not version-level, deliberately — a non-registry specifier is exactly the kind of thing an attacker
would use to smuggle a non-reviewable artifact past registry-level scanning, so the gate asks for a
human's eyes at the one moment — the dependency's first appearance — where that review is cheap.

## `custom.host` predicates

For an invariant the built-in rule kinds can't express, register a pure function over the graph in
`align.config.ts`'s sibling `hostRules` export and reference it by name:

```ts
import { defineProject } from '@spikedpunch/align-core/dsl';
import type { HostPredicate, HostRuleContext, HostViolation } from '@spikedpunch/align-core';

export default defineProject({
  components: { app: 'src/**' },
  rules: (c) => [
    c.custom.host('noDirectFsImports')
      .because('Direct node:fs imports bypass our storage abstraction; use src/storage instead.'),
  ],
});

export const hostRules: Record<string, HostPredicate> = {
  noDirectFsImports: (ctx: HostRuleContext): HostViolation[] => {
    const violations: HostViolation[] = [];
    for (const edge of ctx.graph.externalEdges) {
      if (edge.to !== 'external:node:fs') continue;
      violations.push({ file: edge.from, message: `${edge.from} imports node:fs directly.` });
    }
    return violations;
  },
};
```

**Verified**: importing `node:fs` from a file in `app` turns this red —

```
src/app/fsuser.ts:1 [custom.host:noDirectFsImports] src/app/fsuser.ts: src/app/fsuser.ts imports
node:fs directly. (rule 'custom.host:noDirectFsImports', host predicate 'noDirectFsImports').
```

— removing the import returns it to green. **Registration is mandatory and checked at gate time,
never silently ignored**: `custom.host('someName')` with no matching `hostRules.someName`
predicate makes the architecture gate report `error`, never a silent green — closing off a real
HIGH-severity bug class this repo hit and fixed (an unregistered predicate used to count as a
vacuously passing rule). A predicate must be a pure function over its `HostRuleContext` — no I/O —
so custom rules get the same freshness guarantee as the built-in ones. `custom.host` rules are
**not portable to [untrusted mode](#untrusted-mode)** — see that section.

## Telemetry (opt-in, local-only)

align can log its own usage to a local, append-only file — **never a network call, ever** (ADR 015,
the same trust posture untrusted mode already holds itself to). It's off by default; turn it on
with any of:

```bash
ALIGN_TELEMETRY=1 align check   # env var
align check --telemetry         # per-invocation flag (check, baseline accept/prune, build, agent run)
```

or add `telemetry: true` as a named export in `align.config.ts`. `--no-telemetry` overrides all
three for one invocation. Enabled, every `check`/`baseline accept`/`baseline prune`/`build`/
`agent run` appends one JSON line to `.align/telemetry.jsonl` — verdicts, gate counts, wall-clock
latency, which rules fired, baseline accept/prune counts, doc-build impact deltas, and (for
`align agent run`) attempt/convergence counts plus token usage when the provider surfaces it.
**Paths and rule ids only, never file contents.** Both telemetry files are gitignored by default —
`align init` adds both entries to your repo's `.gitignore` automatically.

```bash
align telemetry               # human-readable summary
align telemetry --json        # structured summary
align telemetry --file <path> # read a JSONL file from somewhere other than .align/telemetry.jsonl
```

**Verified end to end** — three checks with telemetry on (green, then a seeded cycle, then the
fix) produce a real time-to-green measurement:

```
$ align telemetry
align telemetry — 5 event(s) read

check latency:
  p50=12ms  p90=13ms  p99=13ms  (n=3)

top-firing rules:
     1  arch.no-cycles:repo

time-to-green per rule (appeared -> resolved):
  arch.no-cycles:repo: avg=1.4s median=1.4s (n=1)

dead rules (in the active ruleset, never fired):
  none.

baseline-vs-fix:
  baselined=0  resolved(fixed)=1  baseline-ratio=0%
```

The summary is what actually informs the next round of rule tuning: check-latency percentiles,
which rules fire most, time-to-green per rule (the fastest way to tell a useful rule from noise),
**dead rules** (declared but never fired — candidates for removal), the baseline-vs-fix ratio, and
a friction ranking of `error` events by kind. This is the **360-feedback loop** every earlier
promotion decision (`arch.metric`, `security.manifest.*`, untrusted mode itself) was justified by
one-shot spike evidence alone — telemetry closes the gap between "measured once" and "measured
across weeks of real use." Nothing here is ever sent anywhere; asserted by a dedicated test, not
just documented — nothing under align's telemetry code path imports a network primitive.

## Supporting commands

```bash
align explain <ruleId>       # kind, .because() rationale, constrained components; Mermaid diagram for cycles/deps
align doctor                 # read-only advisory survey; never fails, exit code always 0
align doctor --json
align baseline show [--rule <ruleId>]
align baseline prune
```

`align explain` is pull-on-demand, not something to run reflexively before every fix — call it when
a violation's cause isn't obvious from the check output alone. `align doctor` catches the class of
problem that's invisible to a green check because it's about scan blind spots, not rule failures:
dead `tsconfig` path aliases, files matched by no component selector, packages present on disk but
outside any `pnpm-workspace.yaml` glob, a breakdown of every uncertain specifier by reason, and
(with [greenfield mode](#greenfield-mode)) which components are still ungrounded vs. ready to have
their `until-populated` marker removed. Because it never fails, it's safe to run on any repo, any
time, purely for information — it found a dead tsconfig alias and 13 workspace-orphaned packages on
a real target repo the first time it ran against it.

## Untrusted mode

<details>
<summary><strong>Check a repo without ever executing its config</strong> — expand for the full <code>--untrusted</code>/<code>export-ir</code> workflow</summary>

`align check` executes repo-controlled code on every run, twice over: it dynamically imports
`align.config.ts`, and it invokes every `custom.host` predicate that file registers. That's fine in
a repo you wrote or trust — it's arbitrary code execution against a repo you don't, and align's own
adoption design (an agent that follows a CLAUDE.md instruction to run `align check` unprompted)
makes that scenario targeted, not hypothetical.

**The fix: separate export from check.** Run `align export-ir` once, in a trusted checkout, to
write the effective ruleset (components + rules, zero functions) as portable JSON. Then
`align check --untrusted` reads only that committed file — it never imports `align.config.ts`,
never invokes a `hostRules` predicate, and refuses outright (never falls back to trusted execution)
if the artifact is missing or corrupted.

```bash
align export-ir                 # trusted context: writes .align/ruleset-ir.json
align check --untrusted         # untrusted context: reads only that file, executes nothing
```

**Verified end to end** — a clean ruleset:

```
$ align export-ir
align export-ir: wrote 3 rule(s), 1 component(s) to .align/ruleset-ir.json
$ align check --untrusted
  parse        green  0 violation(s)
  architecture green  0 violation(s)
  security     green  0 violation(s)

verdict: green
```

— and a ruleset containing a `custom.host` rule, which refuses rather than silently drops coverage:

```
$ align check --untrusted
align check --untrusted: --untrusted refuses to evaluate 1 custom.host rule(s):
custom.host:noDirectFsImports. A custom.host predicate is host-side code by definition, and
--untrusted's entire guarantee is that no repo-controlled code executes — there is no predicate
registry to consult because align.config.ts is never imported in this mode. Options: run
`align check` without --untrusted on a repo you trust to execute code, or remove/replace these
rules with a portable arch.*/security.manifest.* kind before running `align export-ir` again.
```

**Why refuse instead of skip-with-a-warning**: a silently skipped rule reports green while
enforcing nothing — the same vacuous-green class this project treats as severity-zero everywhere
else, not a UX nicety to soften. The tradeoff: a ruleset with real `custom.host` rules cannot be
fully enforced under `--untrusted` — replace them with a portable `arch.*`/`security.manifest.*`
kind, or accept reduced untrusted-mode coverage for that specific rule.

**Residual, honest, not closed**: the scanner still *reads* (parses, never executes) every source
file in the repo under `--untrusted` too — a maliciously crafted file could still exploit a bug in
TypeScript's own parser, which is outside align's threat model to close.

</details>

## How align treats trust

- **Every check is a fresh scan.** No result cache in the verification path, no flag that weakens
  this. A scan-once cache tested during development served a byte-identical stale verdict after
  violations were already fixed; the connected agent detected it in one iteration and
  **permanently** stopped trusting the tool for the rest of the session.
- **A false green is a severity-zero bug class.** Every name an IR rule references (a component, a
  `custom.host` predicate) must resolve at check time or the gate reports `error` — never green,
  never a silent skip. Greenfield mode's own ungrounded-component surfacing (above) is this
  doctrine applied to its one sanctioned exception: an intentionally-empty component still can't
  hide inside a plain `green`.
- **Honest limitations.** align verifies architecture, not behavior — a fix that satisfies every
  `arch.*` rule can still be wrong, and green means "conforms to the declared architecture," never
  "correct." Whatever behavioral safety a fix has beyond that is bounded by whatever tests the
  target repo already has. Excludes and unresolved-specifier handling are config-time human
  judgment, not machine-verified — a badly configured exclude can hide a real edge as effectively
  as a stale cache, just without a stale cache's false confidence.
- **Telemetry, when enabled, never leaves your machine** — opt-in, local-file-only, asserted by a
  dedicated network-abstinence test, not just documented.
- **JS/TS only, today.** pnpm workspaces are first-class. npm/yarn workspace detection is a known
  gap on the roadmap — running against an npm workspace repo today under-detects components (one
  real test: npm's 12 declared workspace globs yielded only 3 pnpm-inferred components and left
  971 files unmapped) rather than silently mis-detecting; `align doctor`'s unmapped-files advisory
  surfaces the gap instead of hiding it.

## CI usage

```bash
align check --json           # structured payload: verdict, per-gate counts, violations, advisories
align check --frozen-rules   # also red if a doc-built ruleset has drifted from its lockfile
align init --accept-existing # required in non-interactive CI; align init exits red without it
```

`align check` exits `0` iff the verdict is green and `1` otherwise, so it composes directly as a
pipeline gate with no extra parsing:

```bash
align check --json || exit 1
```

`--json` payloads follow the same token-economy discipline as the MCP tools: passing gates report
counts only, violations carry structured fields (`file`, `line`, rule id, snippet) with no
duplicated prose, and everything is priority-sorted `architecture > security > types > lint >
format` before any pagination applies.

## Full CLI reference

<details>
<summary>Every top-level command, generated live from the installed binary (<code>align skill --topic all</code>)</summary>

| Command | What it does |
| --- | --- |
| `align init [options]` | Detect components, write a starter `align.config.ts`, and seed the baseline. |
| `align check [options]` | Run architecture rules against a fresh scan of the repo. Exit 0 iff green. |
| `align export-ir [options]` | Trusted context only: write the effective ruleset as portable JSON to `.align/ruleset-ir.json`, the data source `--untrusted` reads. |
| `align baseline accept/prune/show [options]` | Manage the violation baseline (tolerated debt). |
| `align explain [options] <ruleId>` | Explain one rule: kind, rationale, constrained components. |
| `align doctor [options]` | Read-only advisory survey. Never fails — exit code always 0. |
| `align build [options]` | Compile a markdown architecture doc into the ruleset. Dry-run by default. |
| `align agent run [options]` | Built-in BYOK LLM fix loop (requires `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` for a compatible endpoint). |
| `align mcp [options]` | Start the align MCP server (stdio). |
| `align skill [options]` | Print the LLM-facing authoring/fixing guide. `--install` writes `.claude/skills/align/SKILL.md`. |
| `align telemetry [options]` | Summarize `.align/telemetry.jsonl` — latency percentiles, top-firing rules, time-to-green, dead rules, friction ranking. |

Gates run in a fixed priority order — `architecture > security > types > lint > format`:

| Gate | Status |
| --- | --- |
| `parse` | implemented (v1) |
| `architecture` | implemented (v1) |
| `security` | implemented (v1) |
| `types` / `lint` / `format` | reserved — Stage 5 tool-wrapping growth path, not yet wired up |

</details>

## Repo layout

```
packages/
├── core/               # @spikedpunch/align-core — Violation model, RuleIR (zod), the DSL (@spikedpunch/align-core/dsl),
│                       #   gate stack, baseline, orchestrator. Zero framework dependencies.
├── plugin-typescript/  # @spikedpunch/align-plugin-typescript — ts-morph/compiler-API dependency graph + adapters
├── cli/                # @spikedpunch/align-cli — commander CLI; hosts `align mcp` (stdio MCP server)
└── agent/              # @spikedpunch/align-agent — built-in BYOK fix loop (`align agent run`)
```

## Development

```bash
pnpm install
pnpm build       # tsc -p per package
pnpm typecheck
pnpm test        # vitest, per package — 508 tests passing across core/plugin-typescript/cli/agent
pnpm check       # align checking itself (dogfood) — packages/cli/dist/index.js check
```
