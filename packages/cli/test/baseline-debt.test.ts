import { describe, expect, it } from 'vitest';
import { computeBaselineDebt } from '../src/baseline-debt.js';
import type { BaselineEntry, CheckRun, FileExistenceProbe, GateResult, RepoRelativePath, ScanBlindSpot } from '@spikedpunch/align-core';

/** N opaque entries, for the cases that read only `.length`. Entries that must be located on disk
 * use `entriesAt` instead — `computeBaselineDebt` reads `.file` since the D016 fix. */
function baselineOf(n: number): readonly BaselineEntry[] {
  return Array.from({ length: n }, (_, i) => ({ file: `unobserved-${i}.ts` }) as BaselineEntry);
}

function entriesAt(...files: string[]): readonly BaselineEntry[] {
  // Distinct fingerprints unless a test deliberately collides them (see `entriesSharingFingerprint`).
  return files.map((file) => ({ file, fingerprint: `fp-${file}` }) as BaselineEntry);
}

/** Two baseline rows carrying ONE fingerprint — a hand-edited or merge-mangled `baseline.json`.
 * `baselineFileSchema` permits it and `writeBaseline` does not dedupe, so it reaches production. */
function entriesSharingFingerprint(fingerprint: string, ...files: string[]): readonly BaselineEntry[] {
  return files.map((file) => ({ file, fingerprint }) as BaselineEntry);
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
    observedViolations: [],
    componentMatchCounts: new Map(),
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
    //
    // EVERY FILE IS OBSERVED, and that is load-bearing rather than incidental. With the empty
    // `observedFiles` this test used to pass, mechanism 3 (`isUnderAbsentDirectory`) retained all
    // three entries on its own, so deleting the tier-1 guard entirely left this test green — the
    // D016 fix silently converted a working pin into a vacuous one. Observing the files disables
    // every retention arm, which is what leaves tier 1 as the only thing that can produce this
    // result. Verified by mutation: removing tier 1 now fails exactly this test and the one below.
    const run = runWith('error', [gate({ status: 'error', baselinedCount: 0 })], { observed: ['a.ts', 'b.ts', 'c.ts'] });
    expect(computeBaselineDebt(entriesAt('a.ts', 'b.ts', 'c.ts'), run, nothingOnDisk)).toEqual({ previous: 3, current: 3, delta: 0 });
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
    // `vendor/other.ts` is observed so that mechanism 3 cannot fire for this directory, and the
    // probe reports nothing on disk so mechanism 2 cannot either. That leaves the blind-spot test as
    // the only arm able to retain these entries — without it the test passed via mechanism 3 and
    // named the wrong mechanism.
    const run = runWith('green', [gate({ baselinedCount: 0 })], { blindSpots: hiddenByExcludes, observed: ['app.ts', 'vendor/other.ts'] });
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
    // `live.ts` observed, so only `vendor/a.ts` has a retention arm available. Without tier 1 the
    // answer would be `2 → 1 (-1)`; with it, no change. Previously both files were unobserved and
    // mechanism 3 retained both, making the two answers identical and the test vacuous.
    const run = runWith('error', [gate({ status: 'error', baselinedCount: 0 })], { blindSpots: hiddenByExcludes, observed: ['live.ts'] });
    expect(computeBaselineDebt(entriesAt('vendor/a.ts', 'live.ts'), run, nothingOnDisk)).toEqual({ previous: 2, current: 2, delta: 0 });
  });
});


/**
 * Two further causes of the same fabricated delta, found by adversarial review after the D016 fix
 * shipped. Both are S-09 again — the fix enumerated the cause it reproduced and stopped there.
 */
describe('computeBaselineDebt cannot fabricate a delta from double-counting or duplicate rows', () => {
  it('a move-transferred entry is counted ONCE, not as both matched and unobservable', () => {
    // Measured against the built binary before this fix: `{previous:1, current:2, delta:+1}`.
    // `matched` counts violations under their POST-transfer path; the retention partition counts
    // previous-baseline entries under their PRE-transfer path, so one entry appears in both
    // coordinate systems and the `!observed.has(entry.file)` pre-filter — which the code's comment
    // claimed made double counting impossible — excludes nothing.
    //
    // `store.applyMoves` does refuse to transfer anything the partition would retain, which is why
    // no repository state reaches this today. But that safety lives in another package, is stated
    // nowhere, and the two predicate sets are evaluated over DIFFERENT inputs (`applyMoves` sees one
    // domain's blind spots; this sees the union), so it is incidental rather than guaranteed.
    const run = runWith('green', [gate({ baselinedCount: 1 })], { observed: ['new/here.ts'] });
    expect(computeBaselineDebt(entriesAt('gone/old.ts'), run, nothingOnDisk)).toEqual({ previous: 1, current: 1, delta: 0 });
  });

  it('duplicate fingerprints in baseline.json do not read as a permanent debt drop', () => {
    // `InMemoryBaselineStore` keys by fingerprint, so two rows sharing one are ONE entry to every
    // consumer — but `previous` counted rows. Measured before this fix: `{previous:2, current:1,
    // delta:-1}` reported on EVERY run, for a repository where nothing was fixed and nothing
    // changed. D016's symptom from a third cause its fix did not enumerate.
    const run = runWith('green', [gate({ baselinedCount: 1 })], { observed: ['a.ts', 'b.ts'] });
    expect(computeBaselineDebt(entriesSharingFingerprint('fp-shared', 'a.ts', 'b.ts'), run, nothingOnDisk)).toEqual({
      previous: 1,
      current: 1,
      delta: 0,
    });
  });

  it('is calibrated: distinct fingerprints on the same file still count separately', () => {
    // Guards the dedupe from over-collapsing. Two DIFFERENT rules violated in one file are two
    // entries and two units of debt; collapsing by file rather than fingerprint would hide one.
    const run = runWith('green', [gate({ baselinedCount: 2 })], { observed: ['a.ts'] });
    const two = [
      { file: 'a.ts', fingerprint: 'fp-1' },
      { file: 'a.ts', fingerprint: 'fp-2' },
    ] as unknown as readonly BaselineEntry[];
    expect(computeBaselineDebt(two, run, nothingOnDisk)).toEqual({ previous: 2, current: 2, delta: 0 });
  });
});
