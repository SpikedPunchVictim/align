import { describe, expect, it } from 'vitest';
import { selectRange } from '../src/migrations/range.js';
import type { VersionRegistryEntry } from '../src/migrations/types.js';

// ADR 022's range-selection contract, exercised against synthetic version lists — "at 0.2.0 every
// real range today is a single hop," but `selectRange` makes no assumption about hop count, so
// these tests can and do cover multi-hop, downgrade, and unknown-provenance behavior thoroughly
// without needing a second real release to exist yet.

function entry(version: string): VersionRegistryEntry {
  return { version, notes: [], validators: [], transforms: [] };
}

const REGISTRY: readonly VersionRegistryEntry[] = [entry('0.1.0'), entry('0.1.4'), entry('0.2.0'), entry('0.3.0')];

describe('selectRange', () => {
  it('single hop: from the immediately prior version selects exactly the next entry', () => {
    const result = selectRange(REGISTRY, '0.1.4', '0.2.0');
    expect(result.entries.map((e) => e.version)).toEqual(['0.2.0']);
  });

  it('multi-hop: from an older version selects every intervening entry in ascending order', () => {
    const result = selectRange(REGISTRY, '0.1.0', '0.3.0');
    expect(result.entries.map((e) => e.version)).toEqual(['0.1.4', '0.2.0', '0.3.0']);
  });

  it('multi-hop is order-independent of registry declaration order — sorts ascending regardless of input order', () => {
    const shuffled = [entry('0.3.0'), entry('0.1.0'), entry('0.2.0'), entry('0.1.4')];
    const result = selectRange(shuffled, '0.1.0', '0.3.0');
    expect(result.entries.map((e) => e.version)).toEqual(['0.1.4', '0.2.0', '0.3.0']);
  });

  it('from === to: empty range — nothing between a version and itself', () => {
    const result = selectRange(REGISTRY, '0.2.0', '0.2.0');
    expect(result.entries).toEqual([]);
  });

  it('from unknown: selects every entry up to and including `to` (the conservative default — see selectRange doc comment)', () => {
    const result = selectRange(REGISTRY, 'unknown', '0.2.0');
    expect(result.entries.map((e) => e.version)).toEqual(['0.1.0', '0.1.4', '0.2.0']);
  });

  it('from unknown excludes entries newer than `to`', () => {
    const result = selectRange(REGISTRY, 'unknown', '0.1.4');
    expect(result.entries.map((e) => e.version)).toEqual(['0.1.0', '0.1.4']);
  });

  it('from unknown: preserves "unknown" on the result so a caller can distinguish it from a known from-version', () => {
    const result = selectRange(REGISTRY, 'unknown', '0.2.0');
    expect(result.from).toBe('unknown');
  });

  it('downgrade (from newer than to): empty range, not an error — migrations describe moving forward only', () => {
    const result = selectRange(REGISTRY, '0.3.0', '0.1.4');
    expect(result.entries).toEqual([]);
  });

  it('a version present in the registry but newer than `to` is excluded even with a known from', () => {
    const result = selectRange(REGISTRY, '0.1.0', '0.1.4');
    expect(result.entries.map((e) => e.version)).toEqual(['0.1.4']);
    expect(result.entries.map((e) => e.version)).not.toContain('0.2.0');
    expect(result.entries.map((e) => e.version)).not.toContain('0.3.0');
  });

  it('an empty registry selects nothing, for any from/to combination', () => {
    expect(selectRange([], '0.1.0', '0.2.0').entries).toEqual([]);
    expect(selectRange([], 'unknown', '0.2.0').entries).toEqual([]);
  });

  it('a from-version not itself present in the registry still selects every entry strictly after it', () => {
    const result = selectRange(REGISTRY, '0.1.2', '0.3.0');
    expect(result.entries.map((e) => e.version)).toEqual(['0.1.4', '0.2.0', '0.3.0']);
  });

  it('to a version not present in the registry still selects every entry up to it', () => {
    const result = selectRange(REGISTRY, '0.1.4', '0.2.5');
    expect(result.entries.map((e) => e.version)).toEqual(['0.2.0']);
  });
});
