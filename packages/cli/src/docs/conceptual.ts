/**
 * `align docs <topic>` conceptual sections — the stable doctrine that lives in the root README but
 * does NOT ship with the npm package (`files: ["dist"]`). Curated prose, deliberately kept to
 * doctrine that doesn't version-drift; anything mechanical (rule kinds, DSL verbs, gate list, CLI
 * inventory) is generated live from the binary instead (see `docs/topics.ts`).
 */

export function overview(): string {
  return `align is an architecture-conformance verification **oracle** for humans and LLM coding agents — not a linter. It answers one question deterministically: does the code still conform to this repo's declared architecture (import cycles, layering, dependency direction, per-file size, dependency-source hygiene)?

Three theses drive every decision:

- **LLMs judge; deterministic tools verify.** The agent decides WHAT a fix is; align decides WHETHER it conforms.
- **Token economy is the product.** Violations surface as structured-fields-only payloads so an agent can afford to run check → fix → re-check every iteration.
- **A false green is a severity-zero bug class.** Every check is a fresh full scan (no cache to distrust); anything a rule references that can't be resolved reports \`error\`, never a silent green.

The loop: \`align check\` (red — names the file+line) → fix → \`align check\` (green). Exit code is \`0\` iff green. See \`align docs trust\` for the full doctrine.`;
}

export function baseline(): string {
  return `A new rule (or align's first run) on a mature repo will find pre-existing violations. The baseline tolerates them as **accepted debt** — never silently fixed — so day one is green instead of a wall of red. Consent is always explicit (ADR 006):

- \`align init\` seeds the baseline from the first check. Interactive: asks. CI/non-interactive: requires \`--accept-existing\`, else exits red — silence is never consent.
- \`align baseline accept [--rule <ruleId>]\` accepts current violations (optionally scoped to one rule). \`align baseline show\` lists what's baselined; \`align baseline prune\` drops entries for violations that no longer exist.

Entries are fingerprinted on a **content-snippet hash, not a line number**, so moving or lightly editing a file doesn't un-baseline or double-count — \`prune\` reports moved entries rather than treating them as new. The MCP server never self-serves acceptance (\`allowBaselineFromMcp\` defaults \`false\`): an agent can't grant itself amnesty from a rule it's failing.`;
}

export function greenfield(): string {
  return `Declare your architecture **before any code exists** and get an honest verdict. \`align init --greenfield\` sets every component to \`empty: 'until-populated'\`: rules load immediately, but a component with zero files is *provisionally green* (surfaced as a distinct "ungrounded" line, never plain green), and its rules **auto-arm the moment a real file lands** — no flag to flip later.

The \`empty\` policy is 3-state:

- \`'fail'\` (default) — a zero-match selector is a load error (the anti-stale-glob guard).
- \`'allow'\` — permanently optional; tolerated but surfaced, never silent.
- \`'until-populated'\` — self-healing greenfield: tolerated while empty, enforces normally once populated.

\`align doctor\` flags an \`until-populated\` component that's now populated, so you know the marker is safe to remove.`;
}

export function security(): string {
  return `The same scan carries an **opt-in \`security.manifest\` gate** — supply-chain checks at the one cheap moment to review: a dependency's first appearance. Add to \`align.config.ts\`:

\`\`\`ts
c.security.manifest.newDependencyGate(), // flags a dependency name not yet accepted into the baseline
c.security.manifest.sourceHygiene(),     // flags a dep sourced from git/http/file instead of the registry
\`\`\`

Both are **name-level** (a routine version bump never re-trips them) and reuse the same human-consent baseline machinery as the architecture rules — so adding a new dependency turns the check red until a human accepts it, then stays quiet. The scan reads \`package.json\` across every workspace member, so a dependency slipped into any package is caught.`;
}

export function untrusted(): string {
  return `\`align check\` executes repo-controlled code (\`align.config.ts\` plus any \`custom.host\` predicates) — fine in a repo you trust, but arbitrary code execution against one you don't. **Untrusted mode separates export from check** (ADR 014):

\`\`\`bash
align export-ir           # trusted checkout: writes .align/ruleset-ir.json (functions stripped, portable JSON)
align check --untrusted   # reads ONLY that file — never imports align.config.ts, never runs a predicate
\`\`\`

It refuses outright if the artifact is missing (never falls back to execution), and **refuses rather than silently skips** a ruleset containing \`custom.host\` rules (a predicate is code by definition — a silently-skipped rule would report green while enforcing nothing). Residual, stated honestly: the scanner still *parses* (never executes) every source file.`;
}

export function telemetry(): string {
  return `align can log its own usage to a local, append-only file — **never a network call, ever** (asserted by a dedicated test, ADR 015). Off by default; enable with \`ALIGN_TELEMETRY=1\`, \`--telemetry\`, or \`export const telemetry = true\` in \`align.config.ts\`.

Enabled, each \`check\`/\`baseline\`/\`build\`/\`agent run\` appends one JSON line to \`.align/telemetry.jsonl\`: verdicts, gate counts, wall-clock latency, which rules fired, baseline counts — **paths and rule ids only, never file contents**. \`align telemetry\` summarizes it: check-latency percentiles, top-firing rules, time-to-green per rule, **dead rules** (declared but never fired), and the baseline-vs-fix ratio. \`align init\` gitignores both files.`;
}

export function agent(): string {
  return `\`align agent run\` is a built-in **BYOK (bring-your-own-key) fix loop** (ADR 010): point it at any Anthropic-Messages-compatible model (set \`ANTHROPIC_API_KEY\`, or \`ANTHROPIC_BASE_URL\` for a compatible endpoint) and it works through violations autonomously — DISCOVER → GROUP → PLAN+FIX → APPLY → VERIFY → REPAIR → ESCALATE.

\`\`\`bash
align agent run --dry-run     # print proposed edits, apply nothing
align agent run --pr          # default: push a work branch, open a draft PR
align agent run --auto-merge  # fast-forward into base instead
\`\`\`

Safe by default: refuses a dirty worktree; every fix is a real commit on a fresh branch; it **never** edits \`align.config.ts\` or \`.align/**\` to weaken a rule; refuses a file with zero detected test coverage (\`--allow-untested\` opts in) and escalates rather than deletes an exported symbol (\`--allow-symbol-removals\`). Green from the agent still means "conforms to the declared architecture," never "correct."`;
}

export function ci(): string {
  return `\`align check\` exits \`0\` iff the verdict is green, so it composes directly as a pipeline gate:

\`\`\`bash
align check || exit 1          # gate a PR on architecture conformance
align check --json             # structured payload: verdict, per-gate counts, violations, advisories
align check --frozen-rules     # also red if a doc-built ruleset has drifted from its lockfile
align init --accept-existing   # required in non-interactive CI; align init exits red without it
\`\`\`

\`--json\` payloads follow the token-economy discipline: passing gates report counts only, violations carry structured fields with no duplicated prose, everything priority-sorted \`architecture > security > types > lint > format\`.`;
}

export function trust(): string {
  return `How align treats trust — the doctrine behind every design decision:

- **Every check is a fresh scan.** No result cache in the verification path, no flag that weakens it. A single stale verdict permanently destroys an agent's trust in the tool — freshness is a hard invariant, not a performance knob.
- **A false green is severity-zero.** Every name a rule references (a component, a \`custom.host\` predicate) must resolve at check time or the gate reports \`error\` — never green, never a silent skip.
- **Honest limits.** align verifies architecture, not behavior — a fix satisfying every \`arch.*\` rule can still be wrong. Green means "conforms to the declared architecture," never "correct," and is bounded by whatever tests the repo already has.
- **Telemetry, when enabled, never leaves your machine** — opt-in, local-file-only.
- **JS/TS only today.** pnpm/npm/yarn/bun workspaces are supported.`;
}
