import { describe, expect, it } from 'vitest';
import { InMemoryBaselineStore } from '../src/baseline/store.js';
import { computeContentFingerprint, computeFingerprint } from '../src/baseline/fingerprint.js';
import { toComponentName, toRepoRelativePath, toRuleId } from '../src/types/branded.js';
import type { Violation } from '../src/types/violation.js';
import { blindSpot, neverOnDisk, onDisk } from './helpers.js';

/**
 * ADR 028 Stage 2, mechanism 2: the injected `FileExistenceProbe`.
 *
 * Mechanism 1 (the blind-spot record) is exactly as complete as our enumeration of the ways a scan
 * can be narrower than the repository — and ADR 028 exists because the previous enumeration missed
 * five. This is the guard against the sixth: a file that is STILL ON DISK, absent from the scan,
 * with no blind spot covering it. Whatever caused that, the file was not renamed and was not
 * deleted, so neither destructive inference is sound.
 *
 * Every test here constructs the probe as a plain function. Core touches no filesystem — the
 * `chmod 000` case that justifies keeping BOTH mechanisms needs a real one, so it lives in
 * `packages/cli/test/prune-existence-probe.test.ts` where a filesystem is allowed.
 */

function makeViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    id: computeFingerprint(['no-dependency', 'r1', 'a.ts', 'b.ts', './b']),
    ruleId: toRuleId('r1'),
    category: 'architecture',
    severity: 'error',
    file: toRepoRelativePath('a.ts'),
    range: { startLine: 1, endLine: 1 },
    snippet: `import './b'`,
    fixHint: { code: 'remove-import', file: toRepoRelativePath('a.ts'), line: 1 },
    kind: 'no-dependency',
    fromFile: toRepoRelativePath('a.ts'),
    toFile: toRepoRelativePath('b.ts'),
    fromComponent: toComponentName('x'),
    toComponent: toComponentName('y'),
    specifier: './b',
    line: 1,
    ...overrides,
  } as Violation;
}

/** An accepted entry for `file`, plus a live never-accepted violation elsewhere carrying the SAME
 * content fingerprint — the collision that turns an absent file into a forged transfer. This is the
 * shape of the reproduced severity-zero, staged once and reused. */
function stageCollision(file: string, liveFile = 'lib/service.ts') {
  const snippet = `import './target'`;
  const accepted = makeViolation({
    id: computeFingerprint(['no-dependency', 'r1', file, 'target.ts', './target']),
    file: toRepoRelativePath(file),
    snippet,
  });
  const liveUnaccepted = makeViolation({
    id: computeFingerprint(['no-dependency', 'r1', liveFile, 'target.ts', './target']),
    file: toRepoRelativePath(liveFile),
    snippet,
  });
  // The collision is the premise: if these two ever stop sharing a content fingerprint, every test
  // below passes vacuously because there is nothing for `applyMoves` to match against.
  expect(computeContentFingerprint(accepted.ruleId, accepted.snippet)).toBe(
    computeContentFingerprint(liveUnaccepted.ruleId, liveUnaccepted.snippet),
  );
  return { accepted, liveUnaccepted, knownFiles: new Set([toRepoRelativePath(liveFile)]) };
}

describe('FileExistenceProbe — the transfer arm (reached on every `align check`)', () => {
  it('does not forge a transfer when the file is still on disk but absent from the scan and from every blind spot', () => {
    const { accepted, liveUnaccepted, knownFiles } = stageCollision('src/unscanned.ts');
    // No blind spot at all — mechanism 1 is blind here, by construction. This is the
    // unknown-future-cause the probe exists for.
    const store = new InMemoryBaselineStore([], onDisk('src/unscanned.ts'));
    store.accept([accepted], 'manual');

    const moves = store.reconcileMoves([liveUnaccepted], knownFiles, []);

    expect(moves).toEqual([]);
    expect(store.isBaselined(liveUnaccepted.id)).toBe(false); // never silently pre-accepted
    expect(store.show()[0]?.file).toBe('src/unscanned.ts'); // provenance never moved
    expect(store.show()[0]?.acceptedBy).toBe('manual');
  });

  it('still forges nothing when the blind-spot record covers it and the probe is blind (both mechanisms, either alone suffices)', () => {
    const { accepted, liveUnaccepted, knownFiles } = stageCollision('locked/service.ts');
    // `neverOnDisk` models exactly what `fs.existsSync` reports for a file inside a `chmod 000`
    // directory: ABSENT. The probe cannot save this one — the record has to.
    const store = new InMemoryBaselineStore([], neverOnDisk);
    store.accept([accepted], 'manual');

    const moves = store.reconcileMoves([liveUnaccepted], knownFiles, [
      blindSpot('locked', { kind: 'unreadable', error: 'EACCES: permission denied' }),
    ]);

    expect(moves).toEqual([]);
    expect(store.show()[0]?.file).toBe('locked/service.ts');
  });

  it('DOES still transfer a genuine rename — the file is gone from the scan AND gone from disk', () => {
    const { accepted, liveUnaccepted, knownFiles } = stageCollision('src/old-name.ts', 'src/new-name.ts');
    const store = new InMemoryBaselineStore([], neverOnDisk); // old-name.ts really is gone
    store.accept([accepted], 'manual');

    const moves = store.reconcileMoves([liveUnaccepted], knownFiles, []);

    // The whole point of ADR 006's move-transfer: a rename must not turn CI red for one cycle.
    // Over-retention would break that, so this test is the one that stops the fix overreaching.
    expect(moves).toMatchObject([{ from: accepted.id, to: liveUnaccepted.id }]);
    expect(store.isBaselined(liveUnaccepted.id)).toBe(true);
    expect(store.show()[0]?.acceptedBy).toBe('manual'); // provenance carried, not re-stamped
  });

  it('a broken symlink reads as absent and still transfers — nothing on disk means nothing to retain', () => {
    const { accepted, liveUnaccepted, knownFiles } = stageCollision('src/broken.ts', 'src/real.ts');
    // `fs.existsSync` follows symlinks, so a BROKEN one is `false`. That is the correct answer:
    // the target does not exist, so the entry is genuinely orphaned.
    const store = new InMemoryBaselineStore([], onDisk('src/real.ts'));
    store.accept([accepted], 'manual');

    expect(store.reconcileMoves([liveUnaccepted], knownFiles, [])).toMatchObject([
      { from: accepted.id, to: liveUnaccepted.id },
    ]);
  });
});

describe('FileExistenceProbe — the prune arm', () => {
  it('routes a probe-positive orphan to `removed` rather than `moved`, the arm CLI retention protects', () => {
    const { accepted, liveUnaccepted, knownFiles } = stageCollision('src/unscanned.ts');
    const store = new InMemoryBaselineStore([], onDisk('src/unscanned.ts'));
    store.accept([accepted], 'manual');

    const result = store.prune([liveUnaccepted], knownFiles, []);

    expect(result.moved).toEqual([]);
    expect(result.removed).toEqual([accepted.id]);
    expect(store.isBaselined(liveUnaccepted.id)).toBe(false);
  });

  it('a genuinely deleted file with no content match still prunes — no over-retention', () => {
    const store = new InMemoryBaselineStore([], neverOnDisk);
    const v = makeViolation({ id: computeFingerprint(['gone']), file: toRepoRelativePath('src/deleted.ts') });
    store.accept([v], 'manual');

    expect(store.prune([], new Set()).removed).toEqual([v.id]);
    expect(store.isBaselined(v.id)).toBe(false);
  });

  it('a file the scan OBSERVED with no violation this run still prunes, even though it is on disk', () => {
    // The over-retention regression this stage introduced and its own suite caught: every scanned
    // file also exists on disk, so a probe applied without the "absent from the scan" precondition
    // retains every genuinely-fixed violation and makes `prune` a permanent no-op. The store gets
    // this right because `knownFiles` is tested first; `cli/src/scan-blind-spot-retention.ts`
    // needed the precondition stated explicitly.
    const store = new InMemoryBaselineStore([], onDisk('src/fixed.ts'));
    const v = makeViolation({ id: computeFingerprint(['fixed']), file: toRepoRelativePath('src/fixed.ts') });
    store.accept([v], 'manual');

    const result = store.prune([], new Set([toRepoRelativePath('src/fixed.ts')]));

    expect(result.removed).toEqual([v.id]);
    expect(store.isBaselined(v.id)).toBe(false);
  });

  it('the probe is consulted only for files the scan did not observe (no needless filesystem work)', () => {
    const asked: string[] = [];
    const store = new InMemoryBaselineStore([], (file) => {
      asked.push(file);
      return false;
    });
    const observed = makeViolation({ id: computeFingerprint(['obs']), file: toRepoRelativePath('src/observed.ts') });
    const unobserved = makeViolation({ id: computeFingerprint(['unobs']), file: toRepoRelativePath('src/unobserved.ts') });
    store.accept([observed, unobserved], 'manual');

    store.prune([], new Set([toRepoRelativePath('src/observed.ts')]));

    expect(asked).toEqual(['src/unobserved.ts']);
  });
});

/**
 * CLAUDE.md rule 4: "Add-only and transfer-only consumers are exempt, but the exemption must be
 * pinned by a test." Three of the six `InMemoryBaselineStore` construction sites never reach a
 * destructive inference — `baselineAccept` and `build --accept-new-into-baseline` only ever call
 * `accept`, `baselineShow` only reads. Each is handed the REAL probe anyway (a `() => false` stub
 * would be a false statement about the working tree that merely happens not to matter), so the
 * claim worth pinning is not "they pass a stub" but "these methods never consult it".
 */
describe('the add-only / read-only exemption (CLAUDE.md rule 4), pinned rather than asserted', () => {
  it('accept, acceptByRule, show and snapshot never consult the existence probe', () => {
    const asked: string[] = [];
    const store = new InMemoryBaselineStore([], (file) => {
      asked.push(file);
      return true;
    });
    const v = makeViolation();

    store.accept([v], 'manual');
    store.acceptByRule(v.ruleId, [v]);
    store.isBaselined(v.id);
    store.show();
    store.show({ ruleId: v.ruleId });
    store.snapshot();

    // If this ever fails, one of those methods grew a destructive inference and needs the ADR 023
    // guards and a write-set, not a quick edit to this expectation.
    expect(asked).toEqual([]);
  });
});
