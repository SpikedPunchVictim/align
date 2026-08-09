/**
 * ADR 024 (implementing the ADR 006:40-43 clause that was documented but never wired to a check):
 * the single gate over every MCP-reachable write to `.align/baseline.json`.
 *
 * Defined over the CAPABILITY — "an MCP call is about to accept violations into the baseline" —
 * not over any one tool name. `align_propose_rules`'s `accept_new_into_baseline` is the only
 * caller today (`mcp/server.ts`), but a future MCP tool that grows a second baseline-writing path
 * MUST call `decideMcpBaselineWrite` too: scoping the gate to a tool name (the never-shipped
 * `align_baseline_accept`) is exactly the mistake ADR 024 documents — it left the real write path
 * (`align_propose_rules`) ungated because nothing was checking the capability itself.
 *
 * Scope, stated precisely (do not oversell this in a caller's error handling or comments):
 * `accept_new_into_baseline` only ever accepts `result.impact.addedNew` — violations newly
 * introduced by the rules proposed in that same call, not arbitrary pre-existing debt. An agent
 * cannot use it to clear a violation it is stuck on; that narrower scope is what makes gating it
 * (rather than removing it) proportionate.
 *
 * A refused write is a Result, not a throw (CODING_BEST_PRACTICES.md #23) — an unopted-in repo is
 * an expected, everyday outcome, not a programmer error or a broken invariant.
 */
export type McpBaselineWriteDecision = { readonly allowed: true } | { readonly allowed: false; readonly message: string };

/**
 * @param allowBaselineFromMcp The repo's `align.config.ts` `allowBaselineFromMcp` export
 *   (`config.ts`'s `LoadedConfig.allowBaselineFromMcp`, default `false` — a human-only opt-in, no
 *   MCP tool can set it).
 * @param affectedRuleIds The rule ids of the violations this call would accept into the baseline
 *   (`result.impact.addedNew.map(v => v.ruleId)`), used only to make the refusal's CLI-equivalent
 *   pointer concrete instead of a bare placeholder.
 */
export function decideMcpBaselineWrite(allowBaselineFromMcp: boolean, affectedRuleIds: readonly string[]): McpBaselineWriteDecision {
  if (allowBaselineFromMcp) return { allowed: true };

  const uniqueRuleIds = [...new Set(affectedRuleIds)];
  const cliEquivalent =
    uniqueRuleIds.length > 0
      ? uniqueRuleIds.map((ruleId) => `align baseline accept --rule ${ruleId}`).join(' && ')
      : 'align baseline accept --rule <ruleId>';

  return {
    allowed: false,
    message:
      `accept_new_into_baseline was refused: MCP baseline writes are disabled by default ` +
      `(\`allowBaselineFromMcp\` is false or unset in align.config.ts — ADR 006, ADR 024). An agent cannot ` +
      `grant itself amnesty from a rule it is failing. Nothing was written. A human can either add ` +
      `\`export const allowBaselineFromMcp = true;\` to align.config.ts to allow this over MCP, or accept ` +
      `the debt from the CLI instead: \`${cliEquivalent}\`.`,
  };
}
