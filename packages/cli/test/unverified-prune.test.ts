import { describe, expect, it } from 'vitest';
import { toRepoRelativePath } from '@spikedpunch/align-core';
import { describeUnverifiablePrunes, selectUnverifiablePrunes } from '../src/unverified-prune.js';

const entry = (file: string, contentFingerprint?: string) => ({
  file: toRepoRelativePath(file),
  ...(contentFingerprint === undefined ? {} : { contentFingerprint }),
});
const known = (...files: string[]) => new Set(files.map((f) => toRepoRelativePath(f)));

describe('selectUnverifiablePrunes', () => {
  it('selects an entry with no contentFingerprint whose file is gone — a rename align could not rule out', () => {
    const gone = entry('src/api/old.ts');
    expect(selectUnverifiablePrunes([gone], known('src/api/other.ts'))).toEqual([gone]);
  });

  it('does NOT select one whose file is still in the scan, even with no contentFingerprint', () => {
    // The case that makes both conditions necessary. `applyMoves` only considers an orphan for
    // transfer once its file has genuinely disappeared (FRAGILE #7), so while the file is present
    // an absent violation really is fixed and the missing field changes nothing. Testing
    // `contentFingerprint` alone would over-report every init-seeded entry in the common case.
    const present = entry('src/api/still-here.ts');
    expect(selectUnverifiablePrunes([present], known('src/api/still-here.ts'))).toEqual([]);
  });

  it('does NOT select one that has a contentFingerprint — the move check ran and found nothing', () => {
    const checked = entry('src/api/old.ts', 'abc123');
    expect(selectUnverifiablePrunes([checked], known('src/api/other.ts'))).toEqual([]);
  });

  it('selects only the qualifying entries out of a mixed set', () => {
    const qualifies = entry('src/a.ts');
    const hasField = entry('src/b.ts', 'ff');
    const filePresent = entry('src/c.ts');
    const result = selectUnverifiablePrunes([qualifies, hasField, filePresent], known('src/c.ts'));
    expect(result).toEqual([qualifies]);
  });

  it('is empty for an empty input, without throwing', () => {
    expect(selectUnverifiablePrunes([], known('src/a.ts'))).toEqual([]);
  });
});

describe('describeUnverifiablePrunes', () => {
  it('names the count and what was not checked, and does not claim the deletion was verified', () => {
    const msg = describeUnverifiablePrunes([entry('src/a.ts'), entry('src/b.ts')]);
    expect(msg).toContain('2 of those entries carried no content fingerprint');
    expect(msg).toContain('could not tell a rename from a fix');
    expect(msg).toContain('src/a.ts');
    expect(msg).toContain('src/b.ts');
  });

  it('reads grammatically for one entry — singular pronouns throughout, not just a spliced noun', () => {
    const msg = describeUnverifiablePrunes([entry('src/a.ts')]);
    expect(msg).toContain('1 of those entries carried no content fingerprint and its file is gone');
    expect(msg).toContain('it is removed as fixed');
    // The first version of this message pluralized only the noun and left the pronouns plural
    // ("1 of those entry ... their file ... they are removed"). Assert their absence so the
    // singular path cannot regress to that.
    expect(msg).not.toContain('their file');
    expect(msg).not.toContain('they are removed');
  });

  it('reads grammatically for several entries', () => {
    const msg = describeUnverifiablePrunes([entry('src/a.ts'), entry('src/b.ts')]);
    expect(msg).toContain('their files are gone');
    expect(msg).toContain('they are removed as fixed');
  });

  it('caps the listed files and says how many more there are', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => entry(`src/${n}.ts`));
    const msg = describeUnverifiablePrunes(many);
    expect(msg).toContain('+2 more');
    expect(msg).toContain('src/a.ts');
    expect(msg).not.toContain('src/g.ts');
  });

  it('deduplicates files — several entries can share one file', () => {
    const msg = describeUnverifiablePrunes([entry('src/a.ts'), entry('src/a.ts')]);
    expect(msg.match(/src\/a\.ts/g)).toHaveLength(1);
  });
});
