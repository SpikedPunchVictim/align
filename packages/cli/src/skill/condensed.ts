/**
 * Condensed fixing-topic skill for the MCP server's native `instructions` field (Stage 5,
 * IMPLEMENTATION_PLAN.md "Elevated first items" — "pairs with the packaging/bin item; both live
 * probes tried bare align/npx first"). Token-budgeted (~30 lines max): renders `FIX_LOOP_PROTOCOL`
 * summaries (`fix-loop-protocol.ts`) — the SAME source `align skill --topic fixing`'s full
 * markdown expands with `.detail` — plus a one-line tool pointer. Never hand-duplicated prose.
 */
import { FIX_LOOP_PROTOCOL } from './fix-loop-protocol.js';

const MAX_LINES = 30;

export function renderCondensedFixingSkill(): string {
  const lines: string[] = [
    'align — architecture-conformance oracle. Tools: align_check, align_violations, align_explain_rule, align_propose_rules.',
    '',
    'Fix-loop protocol:',
    ...FIX_LOOP_PROTOCOL.map((p) => `- ${p.summary}`),
    '',
    'Run `align_check` after structural changes. Every call is a fresh scan.',
  ];
  if (lines.length > MAX_LINES) {
    throw new Error(`skill/condensed.ts: renderCondensedFixingSkill() produced ${lines.length} lines, over the ${MAX_LINES}-line MCP instructions budget.`);
  }
  return lines.join('\n');
}
