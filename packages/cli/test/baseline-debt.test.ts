import { describe, expect, it } from 'vitest';
import { computeBaselineDebt } from '../src/commands/check.js';
import type { BaselineEntry, CheckRun, FileExistenceProbe, GateResult, RepoRelativePath, ScanBlindSpot } from '@spikedpunch/align-core';

/** N opaque entries, for the cases that read only `.length`. Entries that must be located on disk
 * use `entriesAt` instead — `computeBaselineDebt` reads `.file` since the D016 fix. */
function baselineOf(n: number): readonly BaselineEntry[] {
  return Array.from({ length: n }, (_, i) => ({ file: `unobserved-${i}.ts` }) as BaselineEntry);
}

function entriesAt(...files: string[]): readonly BaselineEntry[] {
  return files.map((file) => ({ file }) as BaselineEntry);
}

function gate(overrides: Partial<GateResult> = {}): GateResult {
  return { gate: 'architecture', status: 'green', violations: [], baselinedCount: 0, durationMs: 1, cacheHits: 0, dependsOn: [], ...overrides };
}

function runWith(
  verdict: CheckRun['verdict'],
  gates: GateResult[],
  extra: { readonly blindSpots?: readonly ScanBlindSpot[]; readonly observed?: readonly string[] } = {},
): CheckRun {
  return {
    verdict,
    gates,
    advisories: [],
    scannedAt: 0,
    ungroundedComponents: [],
    blindSpots: extra.blindSpots ?? [],
    observedFiles: { source: new Set((extra.observed ?? []) as RepoRelativePath[]), manifest: new Set() },
  };
}

/** Nothing is on disk unless a test says so. Deliberately the default: a probe that answered `true`
 * everywhere would make every test below pass through mechanism 2 regardless of the mechanism it
 * names, which is shape S-05. */
const nothingOnDisk: FileExistenceProbe = () => false;
const onDisk = (...files: string[]): FileExistenceProbe => {
  const set = new Set<string>(files);
  return (file) => set.has(file);
};

describe('computeBaselineDebt — the one guarded computation shared by check/MCP/builder (NEW-1)', () => {
  it('reports a real reduction on a fully-evaluated run (the ratchet)', () => {
    // 3 on disk, 1 still baselined this scan → 2 were fixed. Their files were observed and carry no
    // violation, which is the one sound "fixed" reading.
    const run = runWith('green', [gate({ baselinedCount: 1 })], { observed: ['a.ts', 'b.ts', 'c.ts'] });
    expect(computeBaselineDebt(entriesAt('a.ts', 'b.ts', 'c.ts'), run, nothingOnDisk)).toEqual({ previous: 3, current: 1, delta: -2 });
  });

  it('does NOT fabricate a debt drop on an error run (gates report 0 baselined) — reports no change', () => {
    // The bug: summing baselinedCount here yields `3 → 0 (−3)` though nothing was verified. An
    // errored gate ⇒ verdict:'error' (deriveVerdict), and the guard must report no-change instead.
    const run = runWith('error', [gate({ status: 'error', baselinedCount: 0 })]);
    expect(computeBaselineDebt(baselineOf(3), run, nothingOnDisk)).toEqual({ previous: 3, current: 3, delta: 0 });
  });
});

/**
 * LEDGER D016. The second cause of the identical fabrication, added by ADR 028 and missed when the
 * errored-run guard above was written — shape S-09, *fixed one arm, missed the other*.
 *
 * An entry whose file the scan could not observe produces no current violation, so it contributes 0
 * to `Σ baselinedCount` exactly like a fixed one. Measured against the built binary before the fix:
 * two accepted entries behind one `excludes` pattern reported `baselined debt: 2 → 0 (-2)`, verdict
 * green, **exit 0**, with both entries still in `.align/baseline.json` and nothing fixed — while
 * `prune` on the same state correctly said `Retained 2 entries`. Two outputs of one release
 * contradicting each other.
 *
 * The fix counts an unobservable entry as STILL BASELINED rather than suppressing the whole line.
 * Suppression was the obvious move and is shape S-04 (*a guard correct in the unsafe direction and
 * wrong in the safe one*): with 500 entries, 2 hidden and 10 genuinely fixed, "report no change"
 * hides a real 10-entry paydown to protect against a 2-entry error. The third test below is the one
 * that pins that distinction, and it is the reason this fix is not three lines.
 */
describe('computeBaselineDebt — an unobservable entry is still debt, not paid-off debt (D016)', () => {
  const hiddenByExcludes: readonly ScanBlindSpot[] = [
    { path: 'vendor' as RepoRelativePath, reason: { kind: 'excluded', pattern: 'vendor/**' } },
  ];

  it('mechanism 1 — entries under a blind spot are counted as still baselined, not as a drop', () => {
    // The exact D016 repro, at unit scale: both entries hidden, no gate matched anything.
    const run = runWith('green', [gate({ baselinedCount: 0 })], { blindSpots: hiddenByExcludes, observed: ['app.ts'] });
    expect(computeBaselineDebt(entriesAt('vendor/a.ts', 'vendor/b.ts'), run, nothingOnDisk)).toEqual({
      previous: 2,
      current: 2,
      delta: 0,
    });
  });

  it('mechanism 2 — an unobserved entry whose file is still on disk is counted as still baselined', () => {
    // No blind spot covers it: the scan was simply narrower than the repository, which is the
    // residue the file-existence probe exists for.
    const run = runWith('green', [gate({ baselinedCount: 0 })], { observed: ['app.ts'] });
    expect(computeBaselineDebt(entriesAt('stale.ts'), run, onDisk('stale.ts'))).toEqual({ previous: 1, current: 1, delta: 0 });
  });

  it('still reports the genuinely-fixed part of a mixed run — a hidden entry must not mask a real paydown', () => {
    // THE ANTI-S-04 TEST. previous 3: one still violating (observed, baselinedCount 1), one truly
    // fixed (observed, gone from the violation set, absent from disk), one hidden behind the blind
    // spot. The honest answer is `3 → 2 (-1)`: the real paydown survives, the fabricated one does not.
    const run = runWith('green', [gate({ baselinedCount: 1 })], { blindSpots: hiddenByExcludes, observed: ['live.ts', 'fixed.ts'] });
    expect(computeBaselineDebt(entriesAt('live.ts', 'fixed.ts', 'vendor/a.ts'), run, nothingOnDisk)).toEqual({
      previous: 3,
      current: 2,
      delta: -1,
    });
  });

  it('calibration — an observed entry with no violation and no file is a real drop, not retention', () => {
    // Guards the fix against over-retention in the other direction: deleting the file that carried a
    // violation is the commonest way debt legitimately falls, and it must keep reading as a drop.
    // `fixed.ts` was observed by the scan, so neither the probe nor the absent-directory test applies.
    const run = runWith('green', [gate({ baselinedCount: 0 })], { observed: ['fixed.ts'] });
    expect(computeBaselineDebt(entriesAt('fixed.ts'), run, nothingOnDisk)).toEqual({ previous: 1, current: 0, delta: -1 });
  });

  it('the errored-run guard still wins over the retention arm', () => {
    // Both causes present at once. Tier order matters: an errored run verified nothing at all, so it
    // reports no change regardless of what the blind-spot partition would have said.
    const run = runWith('error', [gate({ status: 'error', baselinedCount: 0 })], { blindSpots: hiddenByExcludes });
    expect(computeBaselineDebt(entriesAt('vendor/a.ts', 'live.ts'), run, nothingOnDisk)).toEqual({ previous: 2, current: 2, delta: 0 });
  });
});
