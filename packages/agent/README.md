# @align/agent

The Stage 4 BYOK (bring-your-own-key) LLM fix loop (ADR 010, `IMPLEMENTATION_PLAN.md` Stage 4).
Depends only on `@align/core` and `@anthropic-ai/sdk`; never imports `@align/plugin-typescript` or
`@align/cli` (enforced by align's own dogfooded `align.config.ts` layering rule). `@align/cli` is
the composition root that wires the real `TypeScriptPlugin` scanner, `node:fs`, and `git`/`gh`
into this package's `AgentEffects` interface (see `packages/cli/src/commands/agent.ts`).

## Safety bound — read before running against a real repo

**Behavioral safety is bounded by the target repo's own test suite.** No gate in align (or in this
agent) verifies *behavior* — only form (parses, doesn't create a forbidden dependency, doesn't
introduce a cycle). An LLM can satisfy every form gate by making code do less: the cleanest way to
remove a forbidden import is often to delete the import *and* the feature that used it. This
agent's guards reduce that risk but do not eliminate it:

- **Exported-symbol surface diff** flags (and by default refuses to commit) any fix that deletes an
  exported symbol, requiring explicit `--allow-symbol-removals` consent.
- **Zero-coverage refusal** declines to propose a fix for a file with no detected test coverage
  unless `--allow-untested` is passed. The v1 heuristic is **reachability, not real coverage**: a
  file is "covered" if any scanned test file (`**/*.{test,spec}.*`) imports it directly or
  transitively in the dependency graph. A test that imports a module but never exercises the
  specific lines being changed still counts as "covered" — this catches the worst case (nothing
  tests this file at all) cheaply, at the cost of false confidence on partially-exercised code.

Neither guard is a substitute for a real test suite. If the target repo has weak or no tests, the
agent's fixes carry the same behavioral risk any unreviewed automated edit would. Review the diff
(or the draft PR, which is the default terminal-merge mode) before merging to a protected branch.

## Suppressions — dormant machinery

`FixProposal.suppressions` is accepted and zod-validated per ADR 010 (the schema is shared with the
future tool-wrapping gate stack), but **arch-first v1 has no lint gates** — there is no rule
category a suppression could legitimately silence yet. Any proposal that *uses* `suppressions` is
rejected with "no suppressible rule categories active" (`rails.ts::usesSuppressions`, enforced in
`run.ts`). This is tested as dormant machinery (`test/run.test.ts`), not wired to any live
suppress-and-commit path — it exists now so the schema doesn't need a breaking change when
tool-wrapping gates (Stage 5) activate it.

## Design notes / deviations

- **Apply pipeline lives in `@align/core/fix`, not here** — per ADR 010 ("the LLM proposes, the
  engine applies... this pipeline is entirely engine-side... it introduces no dependency from
  `@align/core` on any LLM client"). `FixProposal`/`EditBlock` zod schemas and the deterministic
  byte-offset apply algorithm are pure data/algorithm with zero LLM awareness, so they belong in
  core alongside every other IR core validates — `@align/agent` only supplies the `FixProvider`
  that produces a `FixProposal` and the effects shell that applies one.
- **`condensedSymbolTable` is component-scoped**, not repo-wide or import-graph-reachability-scoped
  — a repo-wide symbol table would blow the token budget on any non-trivial repo; component scope
  is the cheapest reasonable proxy for "files the target may plausibly import" (`symbolTable.ts`).
- **VERIFY and the terminal merge both run a FULL, non-scoped `align check`** — v1 does not
  impact-scope verification inside the loop (impact scoping is Design Reserve). This is simpler and
  matches ADR 005's freshness doctrine at the cost of a full rescan per REPAIR attempt; acceptable
  given the measured ~1.4s full-rescan cost on the target repo class (`spike/SPIKE_REPORT.md`).
  Impact-scoped in-loop VERIFY is a future promotion candidate if REPAIR-heavy runs measure slow.
- **Model default is `claude-sonnet-5`**, not the `claude-api` skill's general-purpose
  `claude-opus-4-8` default — an explicit deviation directed by the Stage 4 task brief: a
  background fix loop that may issue many PLAN+FIX calls per run is exactly the
  cost-sensitive/high-volume workload Sonnet-tier targets. Override via `--model` or
  `ALIGN_AGENT_MODEL`.
- **No fuzzy/whitespace-normalized apply fallback** (Design Reserve, ADR 010) — exact match +
  `nearLine` disambiguation only, in `@align/core/fix`.

## `align agent run`

```
align agent run [--max-attempts N] [--pr|--auto-merge] [--allow-untested] \
                 [--allow-symbol-removals] [--model <id>] [--dry-run]
```

Requires `ANTHROPIC_API_KEY` in the environment (or any credential source the Anthropic SDK
resolves automatically — see the `claude-api` skill). `--dry-run` runs DISCOVER+GROUP+PLAN only and
prints proposed edits without applying or committing anything — a cheap smoke test that still calls
the real model.

## Testing

Every test in this package runs with no network access. `FakeFixProvider` (`test/fakeFixProvider.ts`)
scripts deterministic responses per file; `test/fakeEffects.ts` provides an in-memory `AgentEffects`
(including a git-revert-accurate undo log) for state-machine tests; `test/e2e-git.test.ts` exercises
the real `git`/`gh` shell-out effects against a temp repo. One optional live-API smoke test
(`test/live-smoke.test.ts`) runs only when `ALIGN_LIVE_SMOKE=1` and `ANTHROPIC_API_KEY` are both
set — it skips (not fails) otherwise, and is never depended on by CI.
