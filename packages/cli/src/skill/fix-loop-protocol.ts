/**
 * Fix-loop protocol (Stage 5 static prose — hand-written, stable; not schema-generated). This is
 * the single source both the full `align skill --topic fixing` markdown
 * (`packages/cli/src/skill/static-sections.ts`) and the condensed MCP server `instructions` field
 * (`packages/cli/src/skill/condensed.ts`) render from, so the two surfaces cannot say different
 * things about the same protocol — only how much of it they show.
 *
 * One point per line, ordered by how often an agent needs to be reminded of it (spike probe 2:
 * the agent independently verified fixes and refused to burn edits against a stale signal — this
 * protocol is what codifies that behavior for every future session, not just the one that
 * discovered it).
 */
export interface ProtocolPoint {
  readonly summary: string; // ~one line, used in the condensed MCP instructions
  readonly detail: string; // full explanation, used in the full skill markdown
}

export const FIX_LOOP_PROTOCOL: readonly ProtocolPoint[] = [
  {
    summary: 'check → fix → re-check until green.',
    detail:
      'Run `align check` / `align_check` after every structural change. Fix what it reports, then re-check — ' +
      'never assume a fix worked without a fresh verdict. Every check is a full fresh scan (ADR 005): there is ' +
      'no stale cache to distrust, so trust every verdict as current.',
  },
  {
    summary: 'RED IS BLOCKING.',
    detail:
      'A red `align check` / `align_check` means the change is not done. Do not consider a structural change ' +
      'complete, hand control back, or move on to the next task while red.',
  },
  {
    summary: 'Never edit align.config.ts or .align/** to force green.',
    detail:
      'Removing, weakening, or suppressing a rule in align.config.ts, or hand-editing anything under .align/ ' +
      '(baseline.json, generated-rules.json, rules.lock.json, cache), is not a fix — it hides the finding ' +
      'instead of resolving it. Fix the code the rule is pointing at.',
  },
  {
    summary: 'Baseline acceptance is a HUMAN decision.',
    detail:
      '`align baseline accept` / `align_baseline_accept` (gated off by default, ADR 006) tolerates a violation ' +
      'as existing debt — it does not fix it. An agent under pressure to reach green must not self-serve this; ' +
      'propose it to the human instead of calling it unprompted.',
  },
  {
    summary: 'Explain on demand, not by default.',
    detail:
      'Use `align explain <ruleId>` / `align_explain_rule` to understand WHY a rule fired — its kind, ' +
      '`.because()` rationale, and constrained components (plus a Mermaid diagram for cycle/dependency ' +
      'violations) — before proposing a fix, not as a first-pass survey of the whole ruleset.',
  },
  {
    summary: 'Payloads are structured-fields-only — render prose yourself if you need it.',
    detail:
      'Machine payloads (`align_check`, `align_violations`, `align check --json`) carry structured fields only ' +
      '(file, line, specifier, snippet, fixHint) — no redundant prose `message` field (ADR 007, measured 3.6x ' +
      'token reduction). Passing gates report counts only, never per-item text.',
  },
];
