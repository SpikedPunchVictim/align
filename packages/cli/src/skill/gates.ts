/**
 * Gate-list reference for `align skill` — reads `@spikedpunch/align-core`'s `GATE_KINDS` (derived from
 * `CATEGORIES`, `types/violation.ts`), the same array `GateResult['gate']` is typed from.
 * Implementation status (which gates actually execute today vs. are reserved for the Stage 5
 * tool-wrapping growth path) is current-state prose, not itself schema-derived — there is no
 * runtime "is this gate wired up" flag in v1 — so it is hand-maintained here and covered by
 * `test/skill-completeness.test.ts` only insofar as every GATE_KINDS entry must be *named*
 * somewhere in the rendered section (not that its status prose is correct).
 */
import { GATE_KINDS } from '@spikedpunch/align-core';

const IMPLEMENTED: ReadonlySet<string> = new Set(['parse', 'architecture', 'security']);

export function renderGatesSection(): string {
  const order = 'Priority order (ADR 007, fixed even though not every gate is wired up yet): architecture > security > types > lint > format.';
  const rows = GATE_KINDS.map((gate) => {
    const status = IMPLEMENTED.has(gate) ? 'implemented (v1)' : 'reserved — Stage 5 tool-wrapping growth path, not yet wired up';
    return `- \`${gate}\` — ${status}`;
  });
  return [order, '', ...rows].join('\n');
}
