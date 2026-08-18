import { describe, expect, it } from 'vitest';
import { toRepoRelativePath, toRuleId, toViolationId, type BaselineEntry } from '@spikedpunch/align-core';
import { parseForgetUnscannedPrefix, splitForgotten } from '../src/forget-unscanned.js';
import { describeForgetPrefixMatchedNothing, describeForgottenEntries, describePruneOutcome } from '../src/prune-report.js';
import type { RetainedCandidate } from '../src/scan-blind-spot-retention.js';

/**
 * The pure half of ADR 028 Stage 4. `prune-retention-and-consent.test.ts` drives the same code through
 * the real command against a real filesystem; this file covers the input shapes that command-level
 * test cannot reach — a Windows-style separator, a trailing slash — and pins the two report
 * wordings, which are the part of Stage 4 a user actually reads.
 */

function retained(file: string): RetainedCandidate<BaselineEntry> {
  return {
    candidate: {
      fingerprint: toViolationId(`fp-${file}`),
      ruleId: toRuleId('arch.no-cycles'),
      file: toRepoRelativePath(file),
      acceptedAt: 1,
      acceptedBy: 'manual',
    },
    reason: { kind: 'present-on-disk' },
  };
}

describe('parseForgetUnscannedPrefix', () => {
  it.each([
    ['vendor', 'vendor'],
    ['vendor/', 'vendor'],
    ['vendor///', 'vendor'],
    ['  vendor/lib  ', 'vendor/lib'],
    ['./vendor', 'vendor'],
    ['vendor\\lib', 'vendor/lib'],
    ['vendor/lib.ts', 'vendor/lib.ts'],
  ])('normalizes %j to %j', (raw, expected) => {
    const parsed = parseForgetUnscannedPrefix(raw);
    expect(parsed.ok && parsed.prefix).toBe(expected);
  });

  it.each([
    // Every one of these means "the repository root", which is the bare form ADR 028 Stage 4
    // forbids. The empty string is the realistic one: `--forget-unscanned "$DIR"` with `DIR` unset.
    ['', 'repository root'],
    ['   ', 'repository root'],
    ['.', 'repository root'],
    ['./', 'repository root'],
    ['/', 'absolute'],
    ['/etc/passwd', 'absolute'],
    ['..', 'outside'],
    ['../sibling', 'outside'],
    ['vendor/../..', 'outside'],
    ['a/../../b', 'outside'],
  ])('rejects %j', (raw) => {
    const parsed = parseForgetUnscannedPrefix(raw);
    expect(parsed.ok).toBe(false);
    // The message must name the flag and the value, because it is the only feedback a user gets
    // before the command exits.
    expect(parsed.ok === false && parsed.message).toContain('--forget-unscanned');
  });
});

describe('splitForgotten', () => {
  it('splits at-or-under the prefix, and matches whole segments only', () => {
    const input = [retained('vendor/lib.ts'), retained('vendor/nested/deep.ts'), retained('vendor-extra/x.ts'), retained('src/a.ts')];

    const split = splitForgotten(input, toRepoRelativePath('vendor'));

    expect(split.forgotten.map((f) => f.candidate.file)).toEqual(['vendor/lib.ts', 'vendor/nested/deep.ts']);
    // `vendor-extra/x.ts` is the case a `startsWith` implementation gets wrong, and it would be a
    // silent over-deletion in a destructive command.
    expect(split.retained.map((f) => f.candidate.file)).toEqual(['vendor-extra/x.ts', 'src/a.ts']);
  });

  it('matches an exact file path, not only a directory', () => {
    const split = splitForgotten([retained('vendor/lib.ts'), retained('vendor/other.ts')], toRepoRelativePath('vendor/lib.ts'));

    expect(split.forgotten.map((f) => f.candidate.file)).toEqual(['vendor/lib.ts']);
  });

  it('throws rather than forfeiting everything if an empty prefix ever reaches it', () => {
    // `parseForgetUnscannedPrefix` already rejects this, so the throw is unreachable through the
    // CLI — which is exactly why it is pinned here. A future caller that skips the parser gets a
    // loud failure instead of a silent whole-baseline forfeiture (core's `isUnderRepoPath`).
    expect(() => splitForgotten([retained('vendor/lib.ts')], toRepoRelativePath(''))).toThrow(/repository root/);
  });
});

describe('describePruneOutcome — the distinction ADR 028 §3 requires', () => {
  it('reports a real prune with its count', () => {
    expect(describePruneOutcome(3, 0, 1, 0)).toBe('Pruned 3 fixed violation(s) from the baseline; 1 entry transferred (file moves).');
  });

  it('says nothing was orphaned when there were no candidates at all', () => {
    expect(describePruneOutcome(0, 0, 0, 0)).toMatch(/^Nothing to prune — no baseline entry is orphaned;/);
  });

  it('says everything was retained when retention saved every candidate', () => {
    // The two lines above and below both used to read "Pruned 0 fixed violation(s)". A user watching
    // that number would have seen a healthy repo for as long as a misconfigured scan lasted.
    expect(describePruneOutcome(0, 4, 0, 0)).toMatch(/every candidate was retained, not deleted/);

    // The combination both reviewers found unpinned on 2026-08-17: nothing verified as fixed, but a
    // consent decision destroyed anyway on the user's instruction. "Nothing to prune" here is a lie.
    expect(describePruneOutcome(0, 0, 0, 1)).toMatch(/1 retained entry was forfeited on your instruction/);
    expect(describePruneOutcome(0, 0, 0, 1)).not.toMatch(/Nothing to prune/);
    // And a forfeiture alongside surviving retentions still leads with the destructive fact.
    expect(describePruneOutcome(0, 2, 0, 3)).toMatch(/3 retained entries were forfeited on your instruction/);
  });
});

describe('the --forget-unscanned report', () => {
  it('names the files it forfeited and says the consent is gone', () => {
    const message = describeForgottenEntries([retained('vendor/b.ts'), retained('vendor/a.ts')], toRepoRelativePath('vendor'));

    expect(message).toContain("Forgot 2 retained entries under 'vendor'");
    expect(message).toContain('vendor/a.ts, vendor/b.ts'); // sorted, for a stable diff
    expect(message).toMatch(/report the violations again as new/);
  });

  it('caps the file list like every other list align prints', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => retained(`vendor/${n}.ts`));

    expect(describeForgottenEntries(many, toRepoRelativePath('vendor'))).toContain('+2 more');
  });

  it('says so plainly when the prefix matched nothing — almost always a typo', () => {
    expect(describeForgetPrefixMatchedNothing(toRepoRelativePath('vendr'))).toMatch(/matched no retained entry/);
  });
});
