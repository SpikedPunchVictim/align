import { describe, expect, it } from 'vitest';
import { computeBaselineDebt } from '../src/commands/check.js';
import type { BaselineEntry, CheckRun, GateResult } from '@spikedpunch/align-core';

// Only `.length` of the previous baseline is read, so N opaque entries stand in for a baseline of N.
function baselineOf(n: number): readonly BaselineEntry[] {
  return Array.from({ length: n }, () => ({}) as BaselineEntry);
}

function gate(overrides: Partial<GateResult> = {}): GateResult {
  return { gate: 'architecture', status: 'green', violations: [], baselinedCount: 0, durationMs: 1, cacheHits: 0, dependsOn: [], ...overrides };
}

function runWith(verdict: CheckRun['verdict'], gates: GateResult[]): CheckRun {
  return { verdict, gates, advisories: [], scannedAt: 0, ungroundedComponents: [], skippedNestedCheckouts: [] };
}

describe('computeBaselineDebt — the one guarded computation shared by check/MCP/builder (NEW-1)', () => {
  it('reports a real reduction on a fully-evaluated run (the ratchet)', () => {
    // 3 on disk, 1 still baselined this scan → 2 were fixed.
    const run = runWith('green', [gate({ baselinedCount: 1 })]);
    expect(computeBaselineDebt(baselineOf(3), run)).toEqual({ previous: 3, current: 1, delta: -2 });
  });

  it('does NOT fabricate a debt drop on an error run (gates report 0 baselined) — reports no change', () => {
    // The bug: summing baselinedCount here yields `3 → 0 (−3)` though nothing was verified. An
    // errored gate ⇒ verdict:'error' (deriveVerdict), and the guard must report no-change instead.
    const run = runWith('error', [gate({ status: 'error', baselinedCount: 0 })]);
    expect(computeBaselineDebt(baselineOf(3), run)).toEqual({ previous: 3, current: 3, delta: 0 });
  });
});
