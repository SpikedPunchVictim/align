import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBaseline } from '../src/align-dir.js';
import { baselineAccept, baselinePrune } from '../src/commands/baseline.js';
import { runCheck } from '../src/commands/check.js';
import { runInit } from '../src/commands/init.js';

/**
 * LEDGER **D035** (bug hunt B3) — `align init` after a rename must not leave an entry that can never
 * be transferred again.
 *
 * `init`'s seed merge carried `contentFingerprint` from a prior entry found by STRUCTURAL fingerprint.
 * A rename changes that fingerprint by construction (`store.ts`: "a rename produces a brand-new
 * fingerprint and orphans the old baseline entry"), so the lookup missed and the field was dropped —
 * and an entry with no `contentFingerprint` can never participate in a move-transfer. The next rename
 * therefore made it an unmatchable orphan, and `align baseline prune` deleted it reporting
 * **"Pruned 1 fixed violation(s)"** at exit 0 while `align check` was RED on the violation it had just
 * called fixed. That is CLAUDE.md rule 6's severity-zero class, reached from two ordinary renames.
 *
 * `init.ts` asserted the opposite in a comment — "a violation whose file MOVED keeps its fingerprint" —
 * which is CLAUDE.md rule 5: a doc comment asserting a safety property nothing implemented.
 *
 * The fix DERIVES the field from the violation, exactly as `store.accept` already does, instead of
 * carrying it from a guessed prior. Deriving cannot carry one violation's consent onto another, which
 * a content-match lookup could — so this closes the chain without opening a forged-transfer path.
 */

let tmpDir: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * The committed `simple-app-violation` fixture, copied — NOT a hand-built repo.
 *
 * The first draft of this suite built its own tree and silently exercised the wrong path: the entry
 * was RETAINED by `partitionAndRefuseIfBaselineWriteAtRisk` rather than re-seeded, so it kept its
 * `contentFingerprint` for a reason that had nothing to do with the fix, and every assertion below
 * passed against the unfixed code. A premise assertion caught it — the entry's `file` was still
 * `src/api/old.ts`, proving `init` had never re-created it. This fixture is the one the defect was
 * originally reproduced against by hand.
 */
function repo(): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-init-rename-')));
  fs.cpSync(path.join(fixtures, 'simple-app-violation'), dir, { recursive: true });
  // The fixture's `align.config.ts` imports `@spikedpunch/align-core/dsl`, and `loadConfig` resolves
  // it from the TARGET repo (that is the whole point of the align-core-missing error). Without this
  // link `runInit` fails config load, writes nothing, and every assertion below passes against an
  // untouched baseline — which is exactly how the first draft of this suite fooled itself. Same
  // approach as `mcp-test-helpers.ts`.
  fs.mkdirSync(path.join(dir, 'node_modules', '@spikedpunch'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'packages', 'core'), path.join(dir, 'node_modules', '@spikedpunch', 'align-core'));
  return dir;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const out = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
  }
}

describe('align init after a rename', () => {
  it('seeds every entry with a contentFingerprint, so the entry can still transfer', async () => {
    const dir = repo();
    await quiet(() => baselineAccept(dir));
    fs.renameSync(path.join(dir, 'src/api/service.ts'), path.join(dir, 'src/api/renamed.ts'));

    expect(await quiet(() => runInit(dir, { acceptExisting: true, nonInteractive: true }))).toBe(0);

    const entries = readBaseline(dir);
    expect(entries).toHaveLength(1);
    // PREMISE first [S-05]: the rename must actually have re-keyed the entry, or everything below is
    // asserted about an entry `init` never touched. `acceptedBy` flipping to 'accept-existing' is the
    // observable proof that the seed path re-created it rather than retaining the original.
    expect(entries[0]?.file).toBe('src/api/renamed.ts');
    expect(entries[0]?.acceptedBy).toBe('accept-existing');
    // The field whose absence made the entry permanently untransferable.
    expect(entries[0]?.contentFingerprint).toBeDefined();
  });

  it('closes the chain: a SECOND rename now transfers instead of being pruned as "fixed"', async () => {
    // The whole severity-zero, end to end. Before the fix this printed "Pruned 1 fixed violation(s)"
    // at exit 0 and left `align check` red. Asserted on the OUTCOME rather than on the field, because
    // the field is only interesting for what it enables.
    const dir = repo();
    await quiet(() => baselineAccept(dir));
    fs.renameSync(path.join(dir, 'src/api/service.ts'), path.join(dir, 'src/api/renamed.ts'));
    expect(await quiet(() => runInit(dir, { acceptExisting: true, nonInteractive: true }))).toBe(0);

    fs.renameSync(path.join(dir, 'src/api/renamed.ts'), path.join(dir, 'src/api/renamed2.ts'));
    expect(await quiet(() => baselinePrune(dir, { yes: true, allowIncomplete: true }))).toBe(0);

    expect(readBaseline(dir).map((e) => e.file)).toEqual(['src/api/renamed2.ts']);
    // The assertion that would have caught the original defect: the repository agrees with the report.
    expect(await quiet(() => runCheck(dir, { json: false }))).toBe(0);
  });

  it('still preserves acceptedBy and acceptedAt when the file did NOT move', async () => {
    // Calibration: deriving the content fingerprint must not disturb the provenance merge that
    // `init-seed-provenance.test.ts` pins. A re-run of `init` on an unchanged tree is the common case.
    const dir = repo();
    await quiet(() => baselineAccept(dir));
    const before = readBaseline(dir)[0];

    expect(await quiet(() => runInit(dir, { acceptExisting: true, nonInteractive: true }))).toBe(0);

    const after = readBaseline(dir)[0];
    expect(after?.acceptedBy).toBe(before?.acceptedBy);
    expect(after?.acceptedAt).toBe(before?.acceptedAt);
  });
});
