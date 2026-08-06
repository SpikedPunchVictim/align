import { describe, expect, it } from 'vitest';
import { baselineEntrySchema, baselineFileSchema } from '../../src/baseline/schema.js';

// Bug hunt 2026-08-03, BUG #1: `readBaseline` (packages/cli/src/align-dir.ts) used to silently
// read a corrupted `.align/baseline.json` as `[]`, and the next `align baseline accept` would then
// overwrite the file with that empty read, permanently destroying every previously-accepted entry.
// These tests cover the schema half of the fix — the two constraints that are load-bearing for
// every existing repo upgrading to a version that has this schema are called out explicitly below.

describe('baselineEntrySchema', () => {
  it('parses a full, current-shape entry', () => {
    const parsed = baselineEntrySchema.parse({
      fingerprint: 'f1',
      ruleId: 'arch.no-dependency:api->ui',
      file: 'src/api/service.ts',
      acceptedAt: 1234,
      acceptedBy: 'manual',
      contentFingerprint: 'c1',
    });
    expect(parsed.fingerprint).toBe('f1');
    expect(parsed.contentFingerprint).toBe('c1');
  });

  it('accepts all three documented acceptedBy values (read from store.ts, not guessed)', () => {
    for (const acceptedBy of ['init-seed', 'accept-existing', 'manual'] as const) {
      expect(() =>
        baselineEntrySchema.parse({ fingerprint: 'f', ruleId: 'r', file: 'a.ts', acceptedAt: 0, acceptedBy }),
      ).not.toThrow();
    }
  });

  it('rejects an unrecognized acceptedBy value', () => {
    expect(() =>
      baselineEntrySchema.parse({ fingerprint: 'f', ruleId: 'r', file: 'a.ts', acceptedAt: 0, acceptedBy: 'bogus' }),
    ).toThrow();
  });

  // Load-bearing back-compat check (store.ts:12-15): "Optional so `.align/baseline.json` files
  // written before this field existed still parse." A regression here breaks every existing repo's
  // baseline on upgrade.
  it('back-compat: a legacy entry with NO contentFingerprint parses fine', () => {
    const parsed = baselineEntrySchema.parse({
      fingerprint: 'f1',
      ruleId: 'arch.no-cycles',
      file: 'src/a.ts',
      acceptedAt: 1000,
      acceptedBy: 'init-seed',
    });
    expect(parsed.contentFingerprint).toBeUndefined();
  });

  // Load-bearing openness check: a strict schema would reject any field added to BaselineEntry in
  // the future and turn every existing repo's next `align check` into a hard error on upgrade.
  it('passthrough: an entry carrying an unknown extra key parses fine, and the key survives', () => {
    const parsed = baselineEntrySchema.parse({
      fingerprint: 'f1',
      ruleId: 'r',
      file: 'a.ts',
      acceptedAt: 0,
      acceptedBy: 'manual',
      someFutureField: 'kept',
    });
    expect((parsed as Record<string, unknown>).someFutureField).toBe('kept');
  });

  it('rejects a missing required field', () => {
    expect(() => baselineEntrySchema.parse({ ruleId: 'r', file: 'a.ts', acceptedAt: 0, acceptedBy: 'manual' })).toThrow();
  });
});

describe('baselineFileSchema', () => {
  it('parses an array of entries', () => {
    const parsed = baselineFileSchema.parse([
      { fingerprint: 'f1', ruleId: 'r', file: 'a.ts', acceptedAt: 0, acceptedBy: 'manual' },
    ]);
    expect(parsed).toHaveLength(1);
  });

  it('parses an empty array', () => {
    expect(baselineFileSchema.parse([])).toEqual([]);
  });

  it('rejects a non-array root (e.g. an object)', () => {
    expect(() => baselineFileSchema.parse({})).toThrow();
  });

  it('rejects a non-array root (e.g. a string, the shape a truncated-mid-write file might produce)', () => {
    expect(() => baselineFileSchema.parse('not an array')).toThrow();
  });
});
