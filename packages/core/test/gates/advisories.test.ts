import { describe, expect, it } from 'vitest';
import { buildUncertaintyAdvisories } from '../../src/gates/advisories.js';
import { toRepoRelativePath } from '../../src/types/branded.js';
import type { UncertaintyMarker } from '../../src/types/graph.js';

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
