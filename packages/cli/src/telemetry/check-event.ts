import type { AdvisoryCount, CheckEvent, CheckRun, CheckScope, GateSummary } from '@spikedpunch/align-core';

function countAdvisoriesByKind(advisories: CheckRun['advisories']): readonly AdvisoryCount[] {
  const counts = new Map<string, number>();
  for (const a of advisories) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

/** Maps a `CheckRun` (the same value `align check` already prints/emits as `--json`) to the
 * `check` telemetry event — real latency DISTRIBUTION across many invocations, not one cold
 * number (IMPLEMENTATION_PLAN.md's telemetry spec). `scope` is always `'all'` in v1 (ADR 005:
 * `align check` only ever does a full fresh scan) — see `CheckScope`'s doc comment. */
export function buildCheckEvent(run: CheckRun, wallMs: number, scope: CheckScope = 'all'): CheckEvent {
  const gates: GateSummary[] = run.gates.map((g) => ({
    gate: g.gate,
    status: g.status,
    newCount: g.violations.length,
    baselinedCount: g.baselinedCount,
    passCount: g.passCount ?? 0,
  }));
  return {
    kind: 'check',
    verdict: run.verdict,
    gates,
    wallMs,
    scope,
    ungroundedComponentCount: run.ungroundedComponents.length,
    advisoryCounts: countAdvisoriesByKind(run.advisories),
  };
}
