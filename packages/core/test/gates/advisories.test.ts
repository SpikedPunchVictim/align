import { describe, expect, it } from 'vitest';
import {
  areAdvisoriesComplete,
  buildBaselineGrowthAdvisories,
  buildScanBlindSpotAdvisories,
  buildUncertaintyAdvisories,
  isRunComplete,
} from '../../src/gates/advisories.js';
import { computeFingerprint } from '../../src/baseline/fingerprint.js';
import { toComponentName, toRepoRelativePath, toRuleId } from '../../src/types/branded.js';
import type { BaselineEntry } from '../../src/baseline/store.js';
import type { CheckRun } from '../../src/gates/types.js';
import type { ScanBlindSpot, UncertaintyMarker } from '../../src/types/graph.js';
import type { Violation } from '../../src/types/violation.js';

function marker(specifier: string, reason: UncertaintyMarker['reason']): UncertaintyMarker {
  return {
    file: toRepoRelativePath('src/index.ts'),
    specifier,
    line: 1,
    reason,
  };
}

describe('buildUncertaintyAdvisories', () => {
  it('collapses external-package unresolvable specifiers into a single missing-dependencies advisory, keeping other reasons separate', () => {
    const advisories = buildUncertaintyAdvisories([
      marker('lodash', 'unresolvable-specifier'),
      marker('some-external-pkg/subpath', 'unresolvable-specifier'),
      marker('./styles.css', 'asset-specifier'),
      marker('./missing-relative', 'unresolvable-specifier'),
    ]);

    expect(advisories).toHaveLength(3);
    expect(advisories[0]).toMatchObject({ kind: 'missing-dependencies' });
    expect(advisories[0]?.message).toContain('2 external specifier(s)');
    expect(advisories[0]?.message).toContain('1 file(s)');
    expect(advisories[0]?.message).toContain('install dependencies');

    const remaining = advisories.slice(1);
    // The two external unresolvable specifiers are gone from the per-reason group; a relative
    // unresolvable specifier and the asset specifier remain as their own uncertainty advisories.
    expect(remaining.some((a) => a.kind === 'uncertainty' && a.message.includes('reason: asset-specifier'))).toBe(true);
    expect(remaining.some((a) => a.kind === 'uncertainty' && a.message.includes('reason: unresolvable-specifier'))).toBe(true);
  });

  it('does NOT collapse a `#`-prefixed subpath import into missing-dependencies (package-internal, not an npm dep)', () => {
    const advisories = buildUncertaintyAdvisories([marker('#internal/thing', 'unresolvable-specifier')]);
    // A `#foo` import maps via the package's own `imports` field — an unresolvable one is not a
    // missing dependency and must not flip the verdict provisional; it stays a plain uncertainty.
    expect(advisories.some((a) => a.kind === 'missing-dependencies')).toBe(false);
    expect(advisories.some((a) => a.kind === 'uncertainty' && a.message.includes('reason: unresolvable-specifier'))).toBe(true);
  });

  it('collapses even a single external unresolvable specifier — the signal is the scan, not a node_modules check (partial-install regression)', () => {
    // Before the fix this only fired when a node_modules heuristic said "not installed"; a repo with
    // align installed but its own deps absent (one unresolvable external) was missed. Now the marker
    // itself is the signal.
    const advisories = buildUncertaintyAdvisories([marker('react', 'unresolvable-specifier')]);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ kind: 'missing-dependencies' });
    expect(advisories[0]?.message).toContain('1 external specifier(s)');
  });

  it('does not emit a missing-dependencies advisory when there are no external unresolvable specifiers', () => {
    const advisories = buildUncertaintyAdvisories([
      marker('./styles.css', 'asset-specifier'),
      marker('`./modules/${name}`', 'non-literal-dynamic-specifier'),
    ]);
    expect(advisories.every((a) => a.kind !== 'missing-dependencies')).toBe(true);
  });

  it('returns an empty array when there are no markers', () => {
    expect(buildUncertaintyAdvisories([])).toEqual([]);
  });
});

// FRAGILE #8 (bug hunt 2026-08-03): `arch.metric`'s fingerprint is deliberately file-identity-only
// (never `value`, never `threshold`) — a baselined over-length file can grow without the
// fingerprint ever changing, so this advisory is the only signal a human/agent gets that it's
// still growing. It must never change what's baselined, only surface growth.
function metricViolation(file: string, ruleId: string, value: number): Violation {
  const filePath = toRepoRelativePath(file);
  const rule = toRuleId(ruleId);
  return {
    id: computeFingerprint(['metric', rule, filePath]),
    ruleId: rule,
    category: 'architecture',
    severity: 'error',
    file: filePath,
    range: { startLine: 1, endLine: 1 },
    snippet: `// ${file}`,
    fixHint: { code: 'split-file', file: filePath },
    kind: 'metric',
    metric: 'loc',
    component: toComponentName('api'),
    value,
    threshold: 800,
  };
}

function noDependencyViolation(file: string, ruleId: string): Violation {
  const filePath = toRepoRelativePath(file);
  const toFile = toRepoRelativePath('ui/other.ts');
  return {
    id: computeFingerprint(['no-dependency', ruleId, file, 'ui/other.ts', './other']),
    ruleId: toRuleId(ruleId),
    category: 'architecture',
    severity: 'error',
    file: filePath,
    range: { startLine: 1, endLine: 1 },
    snippet: `import './other'`,
    fixHint: { code: 'remove-import', file: filePath, line: 1 },
    kind: 'no-dependency',
    fromFile: filePath,
    toFile,
    fromComponent: toComponentName('api'),
    toComponent: toComponentName('ui'),
    specifier: './other',
    line: 1,
  };
}

function baselineEntryFor(v: Violation, acceptedValue?: number): BaselineEntry {
  return {
    fingerprint: v.id,
    ruleId: v.ruleId,
    file: v.file,
    acceptedAt: 0,
    acceptedBy: 'manual',
    ...(acceptedValue === undefined ? {} : { acceptedValue }),
  };
}

describe('buildBaselineGrowthAdvisories', () => {
  it('fires when the current value exceeds the accepted value by more than the threshold, naming both numbers', () => {
    const v = metricViolation('api/big.ts', 'arch.metric:loc:api', 1200); // accepted at 900 -> now 1200 (33% growth)
    const entry = baselineEntryFor(v, 900);
    const advisories = buildBaselineGrowthAdvisories([v], [entry]);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.kind).toBe('baseline-growth');
    expect(advisories[0]?.message).toContain('900');
    expect(advisories[0]?.message).toContain('1200');
    expect(advisories[0]?.message).toContain('api/big.ts');
    expect(advisories[0]?.ruleIds).toEqual(['arch.metric:loc:api']);
  });

  it('does not fire when growth is below the threshold', () => {
    const v = metricViolation('api/big.ts', 'arch.metric:loc:api', 1000); // 900 -> 1000 is ~11%, below 20%
    const entry = baselineEntryFor(v, 900);
    expect(buildBaselineGrowthAdvisories([v], [entry])).toEqual([]);
  });

  it('does not fire on exactly the threshold boundary (inclusive)', () => {
    const v = metricViolation('api/big.ts', 'arch.metric:loc:api', 1080); // exactly 900 * 1.2
    const entry = baselineEntryFor(v, 900);
    expect(buildBaselineGrowthAdvisories([v], [entry])).toEqual([]);
  });

  it('does not fire, and does not throw, for a legacy entry with no recorded acceptedValue', () => {
    const v = metricViolation('api/big.ts', 'arch.metric:loc:api', 5000);
    const entry = baselineEntryFor(v, undefined);
    expect(entry.acceptedValue).toBeUndefined();
    expect(() => buildBaselineGrowthAdvisories([v], [entry])).not.toThrow();
    expect(buildBaselineGrowthAdvisories([v], [entry])).toEqual([]);
  });

  it('ignores a metric violation that has no baseline entry at all (not baselined)', () => {
    const v = metricViolation('api/big.ts', 'arch.metric:loc:api', 5000);
    expect(buildBaselineGrowthAdvisories([v], [])).toEqual([]);
  });

  it('leaves a non-metric baselined violation unaffected — no value is recorded for it, so it never participates', () => {
    const v = noDependencyViolation('api/a.ts', 'arch.no-dependency:api->ui');
    const entry = baselineEntryFor(v); // acceptedValue never set for a non-metric kind
    expect(entry.acceptedValue).toBeUndefined();
    expect(buildBaselineGrowthAdvisories([v], [entry])).toEqual([]);
  });

  it('returns an empty array when there are no violations', () => {
    expect(buildBaselineGrowthAdvisories([], [])).toEqual([]);
  });
});

// ADR 023 "second axis: incomplete ≠ errored" — the advisories-level half of the same predicate.
// `isRunComplete` delegates to this (below); `doctor.ts` calls it directly since it only holds a
// bare advisories array, not a full `CheckRun`. Pinned here so the `missing-dependencies` literal
// stays compared in exactly one place.
describe('areAdvisoriesComplete', () => {
  it('is true for an empty advisories array', () => {
    expect(areAdvisoriesComplete([])).toBe(true);
  });

  it('is false when a missing-dependencies advisory is present', () => {
    expect(areAdvisoriesComplete([{ kind: 'missing-dependencies', message: 'deps missing' }])).toBe(false);
  });

  it('is true when other advisory kinds are present but not missing-dependencies', () => {
    expect(
      areAdvisoriesComplete([
        { kind: 'uncertainty', message: 'x' },
        { kind: 'stale-skill', message: 'y' },
      ]),
    ).toBe(true);
  });
});

// ADR 027's "never silent" half, generalized by ADR 028: a skipped path must be NAMED, not just
// counted, so a human/agent can correlate it with an empty component instead of the skip reading as
// an ordinary, unremarkable empty directory.
describe('buildScanBlindSpotAdvisories', () => {
  function spot(path: string, reason: ScanBlindSpot['reason'] = { kind: 'nested-checkout' }): ScanBlindSpot {
    return { path: toRepoRelativePath(path), reason };
  }

  it('returns no advisory when nothing was skipped', () => {
    expect(buildScanBlindSpotAdvisories([])).toEqual([]);
  });

  it('names every skipped checkout, sorted, in one advisory', () => {
    const advisories = buildScanBlindSpotAdvisories([spot('vendor/b-checkout'), spot('vendor/a-checkout')]);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.kind).toBe('nested-checkout-skipped');
    expect(advisories[0]?.message).toContain('vendor/a-checkout');
    expect(advisories[0]?.message).toContain('vendor/b-checkout');
    // Sorted, not insertion order — so the message is deterministic across scans.
    expect(advisories[0]?.message.indexOf('vendor/a-checkout')).toBeLessThan(advisories[0]?.message.indexOf('vendor/b-checkout') ?? -1);
    expect(advisories[0]?.message).toContain('includeNestedCheckouts');
  });

  it('reports unreadable directories and symlinks under their own kind, each naming its reason', () => {
    const advisories = buildScanBlindSpotAdvisories([
      spot('src/locked', { kind: 'unreadable', error: 'EACCES: permission denied' }),
      spot('src/vendored', { kind: 'not-regular-file' }),
    ]);
    expect(advisories.map((a) => a.kind)).toEqual(['scan-blind-spot', 'scan-blind-spot']);
    const unreadable = advisories.find((a) => a.message.includes('src/locked'));
    // The per-path detail rides the PATH, not the group header — an `unreadable` group can hold
    // several directories with different errors, and one standing in for all of them would be a
    // fabricated attribution.
    expect(unreadable?.message).toContain('EACCES: permission denied');
    expect(unreadable?.message).toContain('could not be read');
    const symlink = advisories.find((a) => a.message.includes('src/vendored'));
    expect(symlink?.message).toContain('symlink');
  });

  it('gives each unreadable directory its OWN error rather than borrowing the first', () => {
    const advisories = buildScanBlindSpotAdvisories([
      spot('a', { kind: 'unreadable', error: 'EACCES: permission denied' }),
      spot('b', { kind: 'unreadable', error: 'ENOTDIR: not a directory' }),
    ]);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.message).toContain('a (EACCES: permission denied)');
    expect(advisories[0]?.message).toContain('b (ENOTDIR: not a directory)');
  });

  // The RECORD is complete; the ADVISORY is selective. `node_modules`/`dist` and user-authored
  // `excludes` fire on essentially every scan of every repo and name nothing the user did not
  // already decide, so an advisory for them is the reliable way to train a human to stop reading
  // advisories. Retention still protects entries under them — that is the record's job, and
  // `prune`/`init` still print the reason at the moment an entry is actually retained.
  it('does NOT report excludes or always-excluded directory names — measured 143 of 200 blind spots in this repo', () => {
    const advisories = buildScanBlindSpotAdvisories([
      spot('node_modules', { kind: 'default-excluded-dir', name: 'node_modules' }),
      spot('packages/cli/dist', { kind: 'default-excluded-dir', name: 'dist' }),
      spot('test-apps/n8n', { kind: 'excluded', pattern: 'test-apps/**' }),
    ]);
    expect(advisories).toEqual([]);
  });

  it('caps the named paths and reports the remainder as `+N more`', () => {
    const advisories = buildScanBlindSpotAdvisories(
      Array.from({ length: 9 }, (_, i) => spot(`vendor/c${i}`)),
    );
    expect(advisories[0]?.message).toContain('9 nested git checkout(s)');
    expect(advisories[0]?.message).toContain('+4 more');
  });
});

// ADR 023 "second axis: incomplete ≠ errored" — the single shared predicate consumed by both
// `payload/builder.ts`'s `complete` field and the CLI's tier-2 `refuseIfRunIncomplete` guard
// (`packages/cli/src/errored-run.ts`). Pinned here directly so a future edit to either consumer
// can't silently re-inline the `.some(...)` expression this function replaced.
describe('isRunComplete', () => {
  function runWithAdvisories(advisories: CheckRun['advisories']): CheckRun {
    return {
      verdict: 'green',
      gates: [],
      advisories,
      scannedAt: Date.now(),
      ungroundedComponents: [],
      blindSpots: [],
      observedFiles: { source: new Set(), manifest: new Set() },
    };
  }

  it('is true when no missing-dependencies advisory fired', () => {
    expect(isRunComplete(runWithAdvisories([]))).toBe(true);
    expect(isRunComplete(runWithAdvisories([{ kind: 'uncertainty', message: 'x' }]))).toBe(true);
  });

  it('is false when a missing-dependencies advisory fired, regardless of other advisories present', () => {
    expect(isRunComplete(runWithAdvisories([{ kind: 'missing-dependencies', message: 'deps missing' }]))).toBe(false);
    expect(
      isRunComplete(runWithAdvisories([{ kind: 'uncertainty', message: 'x' }, { kind: 'missing-dependencies', message: 'deps missing' }])),
    ).toBe(false);
  });
});
