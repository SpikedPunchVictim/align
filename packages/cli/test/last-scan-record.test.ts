import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastScanPath, readLastScanRecord, writeLastScanRecord } from '../src/last-scan-file.js';
import type { RepoRelativePath, RuleId, ScanObservationRecord, ViolationId } from '@spikedpunch/align-core';

let tmpDir: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tmp(): string {
  return (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-last-scan-')));
}

function record(overrides: Partial<ScanObservationRecord> = {}): ScanObservationRecord {
  return {
    recordVersion: 1,
    alignVersion: '0.2.0',
    scopeIdentity: 'scope-abc',
    observedAt: 1_755_000_000_000,
    observed: {
      source: ['src/a.ts' as RepoRelativePath],
      manifest: ['package.json' as RepoRelativePath],
    },
    components: { api: { matchCount: 3, selectorIdentity: 'sel-api' } },
    ruleDefinitions: { 'arch.no-dependency:api-to-db': 'rule-hash-1' },
    violations: [
      { file: 'src/a.ts' as RepoRelativePath, ruleId: 'arch.no-dependency:api-to-db' as RuleId, contentFingerprint: 'cf1' as ViolationId },
    ],
    ...overrides,
  };
}

/** Every path this suite plants that must come back as "no history", and the shape of the failure
 * that plants it. Enumerated as a table rather than as one test per case, because the property under
 * test is a UNIVERSAL — *no* read failure escapes as an exception — and a per-case test invites the
 * next reader to add a seventh failure mode without adding a case. */
const UNUSABLE: readonly { readonly why: string; readonly bytes: string }[] = [
  { why: 'truncated mid-write (the crash this file is most likely to see)', bytes: '{"recordVersion":1,"observed":{"sou' },
  { why: 'empty — a zero-length file from a killed writer', bytes: '' },
  { why: 'valid JSON of the wrong shape entirely', bytes: '{"hello":"world"}' },
  { why: 'right shape, wrong record version (written by a future align)', bytes: JSON.stringify({ ...record(), recordVersion: 2 }) },
  { why: 'a field with the wrong type', bytes: JSON.stringify({ ...record(), observedAt: 'yesterday' }) },
  { why: 'a negative match count', bytes: JSON.stringify({ ...record(), components: { api: { matchCount: -1, selectorIdentity: 's' } } }) },
];

describe('.align/last-scan.json round-trips what ADR 029 §2 says it holds', () => {
  it('writes and reads back every field', () => {
    const dir = tmp();
    const written = record();

    writeLastScanRecord(dir, written);

    expect(readLastScanRecord(dir)).toEqual(written);
  });

  it('is absent, not empty, before anything has written it', () => {
    // `undefined` and "a record observing nothing" must never collapse: the second is a positive
    // claim that align looked and saw nothing, and would license inferences the first must not.
    expect(readLastScanRecord(tmp())).toBeUndefined();
  });

  it('creates `.align/` if the repository does not have one yet', () => {
    const dir = tmp();
    writeLastScanRecord(dir, record());
    expect(fs.existsSync(lastScanPath(dir))).toBe(true);
  });

  it('tolerates an unknown field, so a downgrade does not disable the mechanism', () => {
    // `.passthrough()`, same discipline as the baseline schema: a stricter parse would make every
    // field a later align adds turn this record unreadable on the previous one — silently reverting
    // that user to no history at all rather than merely ignoring a key it does not use.
    const dir = tmp();
    fs.mkdirSync(path.dirname(lastScanPath(dir)), { recursive: true });
    fs.writeFileSync(lastScanPath(dir), JSON.stringify({ ...record(), fieldFromTheFuture: 42 }));

    expect(readLastScanRecord(dir)?.scopeIdentity).toBe('scope-abc');
  });
});

/**
 * **THE RULE THIS FILE EXISTS TO PIN, and it is the opposite of `readBaseline`'s.**
 *
 * `.align/baseline.json` throws on corruption because it holds irreplaceable human consent and an
 * empty read there is followed by a full-snapshot overwrite (BUG #1). None of that is true here:
 * this is a gitignored machine-local cache align rewrites on its own schedule, and an absent read
 * yields `known: false` from every `ScanHistoryProbe` question — ADR 029 §5's definition of exactly
 * today's behaviour. Throwing would fail every `align check` in the repository over a file the user
 * cannot see in `git status`, until they deleted it by hand.
 *
 * ADR 030 §4 records this project making that exact misapplication one day earlier, on `.align/.lock`
 * — a lock that refused to be broken at any age because "corrupt is not absent", and bricked the
 * repository it was protecting. ADR 029 §7.4 as written repeats it; this suite is the amendment.
 *
 * Red-before-green measured in that order (LEDGER D021): with the throwing version in place, the
 * integration scenario leaves the truncated record in place permanently and prints nothing, because
 * the writer's own catch swallows the throw — a safety mechanism that is silently dead rather than a
 * loud failure. That is the outcome these tests exist to prevent.
 */
describe('an unusable record reads as no-history and never as an exception', () => {
  for (const { why, bytes } of UNUSABLE) {
    it(`treats a record that is ${why} as absent`, () => {
      const dir = tmp();
      fs.mkdirSync(path.dirname(lastScanPath(dir)), { recursive: true });
      fs.writeFileSync(lastScanPath(dir), bytes);
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(readLastScanRecord(dir)).toBeUndefined();

      // Loud, not silent. A mechanism that has gone inert because a file is unreadable must say so,
      // or the next person to look concludes from the absence of complaint that it is working.
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(lastScanPath(dir)));
    });
  }

  it('is replaced by the next write rather than needing a human to delete it', () => {
    // The self-healing property that makes reading-as-absent cheap: one warning, then the same run
    // overwrites the file. Without this the warning would repeat forever and the advice would have
    // to be "delete this file yourself".
    const dir = tmp();
    fs.mkdirSync(path.dirname(lastScanPath(dir)), { recursive: true });
    fs.writeFileSync(lastScanPath(dir), 'not json at all');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(readLastScanRecord(dir)).toBeUndefined();

    writeLastScanRecord(dir, record());

    expect(readLastScanRecord(dir)?.alignVersion).toBe('0.2.0');
  });
});
