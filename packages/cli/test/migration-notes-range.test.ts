import { describe, expect, it } from 'vitest';
import { selectRange } from '../src/migrations/range.js';
import type { VersionRegistryEntry } from '../src/migrations/types.js';

// ADR 022's range assembly, exercised specifically over notes-bearing entries. Synthetic fixtures
// deliberately — real registry history has exactly one release so far (`registry.ts`'s own doc
// comment), so a multi-version range can only be demonstrated against a constructed registry, the
// same approach `migration-range.test.ts` already takes for entry ordering in general.

function entryWithNote(version: string, heading: string): VersionRegistryEntry {
  return { version, notes: [{ heading, body: `notes for ${version}` }], validators: [], transforms: [] };
}

const REGISTRY: readonly VersionRegistryEntry[] = [
  entryWithNote('0.3.0', 'third change'), // declared out of order — selectRange sorts, per its own contract
  entryWithNote('0.1.4', 'first change'),
  entryWithNote('0.2.0', 'second change'),
];

describe('selectRange over notes-bearing entries', () => {
  it('a multi-version range returns every entry, each carrying its own notes, in ascending version order', () => {
    const result = selectRange(REGISTRY, 'unknown', '0.3.0');
    expect(result.entries.map((e) => e.version)).toEqual(['0.1.4', '0.2.0', '0.3.0']);
    expect(result.entries.map((e) => e.notes.map((n) => n.heading))).toEqual([
      ['first change'],
      ['second change'],
      ['third change'],
    ]);
  });

  it('a narrower range excludes notes for versions outside it, on both ends', () => {
    const result = selectRange(REGISTRY, '0.1.4', '0.2.0');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.version).toBe('0.2.0');
    expect(result.entries[0]?.notes.map((n) => n.heading)).toEqual(['second change']);
  });

  it('each entry keeps its own notes distinct from its neighbors — no cross-version bleed', () => {
    const result = selectRange(REGISTRY, 'unknown', '0.3.0');
    const bodies = result.entries.map((e) => e.notes.map((n) => n.body));
    expect(bodies).toEqual([['notes for 0.1.4'], ['notes for 0.2.0'], ['notes for 0.3.0']]);
  });
});
