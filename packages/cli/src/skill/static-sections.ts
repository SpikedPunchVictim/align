/**
 * Hand-written, stable prose sections for `align skill` (Stage 5, IMPLEMENTATION_PLAN.md
 * "Elevated first items" — the plan explicitly separates these from the generated-from-schema
 * sections in rule-kinds.ts/dsl-verbs.ts/bullet-grammar.ts/gates.ts/cli-inventory.ts). These
 * describe protocol and doctrine, not the live rule/verb/gate surface, so there is nothing to
 * introspect — they're reviewed like any other doc, not tested for schema completeness.
 */
import { FIX_LOOP_PROTOCOL } from './fix-loop-protocol.js';

export function renderFixLoopProtocolSection(): string {
  return FIX_LOOP_PROTOCOL.map((p) => `- **${p.summary}** ${p.detail}`).join('\n');
}

export function renderDocAuthoringSection(): string {
  return [
    'A markdown architecture/best-practices doc is a buildable intent source (`align build`, ADR 011) — it',
    "compiles to rules the way `package.json` resolves to a lockfile. `align build` (dry-run by default) and",
    "the MCP `align_propose_rules` tool both compile a doc through the same **precision ladder**, most-trusted",
    'form first — always author at the highest tier your intent allows:',
    '',
    '1. **Fenced ` ```align ` blocks compile verbatim, zero LLM.** Block content is a JSON `RuleFragment` — the',
    "   structural fields of one rule kind, minus `id`/`provenance` (both are always assigned by the build",
    '   pipeline). Highest trust, most precise, most work to author by hand.',
    '2. **Structured `- **Rule**: ...` bullets parse deterministically** — see the generated bullet-grammar',
    '   section above for the exact sentence forms. An LLM only grounds fuzzy component-name selectors against',
    '   the components registry; it never invents rule structure.',
    '3. **Free prose goes through two-pass clarification** (`align_propose_rules`, ADR 011): pass 1',
    '   (Discovery) — read the doc, output a short list of *concerns*, no IR yet, human confirms or skips each.',
    '   Pass 2 (Refinement) — IR is generated only for confirmed concerns, each selector grounded against',
    '   component names (never raw paths), with a dry-run impact report before anything is written. This is the',
    '   least-trusted, most-scaffolded path — never skip straight to writing rules from prose without the',
    "   human confirmation gate in between; that's the overwhelm failure mode this mode exists to prevent.",
    '',
    'Nothing writes without an explicit `--apply` (CLI) or `apply: true` (MCP) — the default is always a',
    'dry-run diff + impact delta ("adds N new violations / masks M baselined"). A rule-level diff is minimized',
    "(IR-identical rules keep their ids verbatim), so a prose typo fix re-proposing a section yields an empty",
    'diff, not id churn.',
  ].join('\n');
}

export function renderBaselineConsentSection(): string {
  return [
    'The baseline tolerates existing debt so a new rule (or align\'s first run) on a mature repo does not',
    'demand a wall of red on day one. Consent is explicit, never silent (ADR 006):',
    '',
    '- `align init` seeds the baseline from the first full check. **Interactive**: prints a loud summary and',
    '  asks. **Non-interactive/CI**: requires an explicit `--accept-existing` flag — silence is never consent,',
    '  and without the flag `align init` exits red.',
    '- `align baseline accept [--rule <ruleId>]` accepts current violations (optionally scoped to one rule) —',
    '  a human-invoked CLI command.',
    '- **MCP never self-serves baseline acceptance by default**: `align_baseline_accept` is gated behind',
    '  `allowBaselineFromMcp`, default `false`. An agent cannot grant itself amnesty from a rule it is failing.',
    '  If a violation looks like it should be baselined as pre-existing debt rather than fixed, say so to the',
    "  human and let them run the acceptance — don't call an acceptance tool unprompted under pressure to turn",
    '  a red verdict green.',
  ].join('\n');
}

export function renderMcpPayloadReferenceSection(): string {
  return [
    '`align mcp` (stdio) exposes:',
    '',
    '- **`align_check`** — fresh full scan, green/red/error verdict + per-gate counts. No arguments.',
    '- **`align_violations`** — current violations in priority order (architecture > security > types > lint >',
    '  format), structured fields only, paginated (`cursor`).',
    '- **`align_explain_rule`** — one rule\'s kind, `.because()` rationale, constrained components with example',
    '  files, and a Mermaid diagram for cycle/dependency violations. Pull-on-demand only — never inlined into',
    '  `align_check`/`align_violations` payloads.',
    '- **`align_propose_rules`** — two-pass doc-to-rules compilation (see the doc-authoring section above).',
    '',
    'Payload discipline applies to every tool above (ADR 007): passing gates are counts, never per-item text;',
    'no `message` prose field duplicating structured fields (`fromFile`/`toFile`/`specifier`/`line`/`snippet`',
    'already exist structurally — render prose yourself if you need it); results are priority-sorted before',
    'pagination/truncation; caps and pagination are mandatory, not optional. A red `align_check` response for a',
    'handful of violations costs roughly 1K tokens, not tens of thousands.',
  ].join('\n');
}
