import { describe, expect, it } from 'vitest';
import {
  BASELINE_SCHEMA_VERSION,
  baselineEntrySchema,
  baselineEnvelopeSchema,
  legacyBaselineArraySchema,
} from '../../src/baseline/schema.js';

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

  // FRAGILE #8 (bug hunt 2026-08-03): `acceptedValue` is the growth-advisory field, added the
  // same way `contentFingerprint` was — optional, so back-compat holds the same way.
  describe('acceptedValue (FRAGILE #8 growth-advisory support)', () => {
    it('parses an entry carrying acceptedValue', () => {
      const parsed = baselineEntrySchema.parse({
        fingerprint: 'f1',
        ruleId: 'arch.metric:loc:api',
        file: 'src/api/big.ts',
        acceptedAt: 1234,
        acceptedBy: 'manual',
        acceptedValue: 900,
      });
      expect(parsed.acceptedValue).toBe(900);
    });

    // Load-bearing back-compat check, same class as contentFingerprint's above: every entry ever
    // written before this field existed — and every non-metric entry ever written, period — lacks
    // it. A regression here breaks every existing repo's baseline on upgrade.
    it('back-compat: a legacy entry with NO acceptedValue parses fine', () => {
      const parsed = baselineEntrySchema.parse({
        fingerprint: 'f1',
        ruleId: 'arch.no-cycles',
        file: 'src/a.ts',
        acceptedAt: 1000,
        acceptedBy: 'init-seed',
      });
      expect(parsed.acceptedValue).toBeUndefined();
    });
  });
});

const ENTRY = { fingerprint: 'f1', ruleId: 'r', file: 'a.ts', acceptedAt: 0, acceptedBy: 'manual' };

/** The pre-0.2.0 shape. Every 0.1.x repository still has it on disk, so these cases are not history —
 * they are the contract for reading a file this align did not write (ADR 006's 2026-08-19
 * amendment). */
describe('legacyBaselineArraySchema — the bare array, retroactively schema version 1', () => {
  it('parses an array of entries', () => {
    expect(legacyBaselineArraySchema.parse([ENTRY])).toHaveLength(1);
  });

  it('parses an empty array', () => {
    expect(legacyBaselineArraySchema.parse([])).toEqual([]);
  });

  it('rejects a non-array root (e.g. an object)', () => {
    expect(() => legacyBaselineArraySchema.parse({})).toThrow();
  });

  it('rejects a non-array root (e.g. a string, the shape a truncated-mid-write file might produce)', () => {
    expect(() => legacyBaselineArraySchema.parse('not an array')).toThrow();
  });
});

describe('baselineEnvelopeSchema — the versioned shape align writes from 0.2.0', () => {
  it('parses a versioned envelope and exposes its entries', () => {
    const parsed = baselineEnvelopeSchema.parse({ schemaVersion: BASELINE_SCHEMA_VERSION, entries: [ENTRY] });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.schemaVersion).toBe(BASELINE_SCHEMA_VERSION);
  });

  it('parses an envelope with zero entries — a baseline can legitimately be empty', () => {
    // Distinct from a MISSING file, which `readBaseline` reports as `[]` without parsing anything.
    // Both are "no accepted debt"; only one of them is a statement the file makes.
    expect(baselineEnvelopeSchema.parse({ schemaVersion: BASELINE_SCHEMA_VERSION, entries: [] }).entries).toEqual([]);
  });

  it('does NOT pin the version itself — that check belongs to the reader, with its own message', () => {
    // `z.literal(2)` here would turn "written by a newer align" into a shape error listing fields,
    // which is the least actionable thing align could say about it. `readBaseline` compares the
    // number and explains what to do; this schema only asserts the number exists and is sane.
    expect(baselineEnvelopeSchema.parse({ schemaVersion: 99, entries: [] }).schemaVersion).toBe(99);
  });

  it('rejects a non-numeric, zero or negative version', () => {
    for (const schemaVersion of ['2', 0, -1, 1.5]) {
      expect(() => baselineEnvelopeSchema.parse({ schemaVersion, entries: [] })).toThrow();
    }
  });

  it('tolerates an unknown sibling field, so a later align adding one does not brick this one', () => {
    // Same `.passthrough()` discipline as the entry schema, for the same reason: a stricter envelope
    // would make every field a future align adds turn the file unreadable here — and unreadable, for
    // THIS file, means a hard failure on every command rather than a degraded one.
    expect(baselineEnvelopeSchema.parse({ schemaVersion: BASELINE_SCHEMA_VERSION, entries: [], writtenBy: 'x' }).entries).toEqual([]);
  });

  it('rejects an envelope whose entries are not baseline entries', () => {
    expect(() => baselineEnvelopeSchema.parse({ schemaVersion: BASELINE_SCHEMA_VERSION, entries: [{ nope: true }] })).toThrow();
  });
});
