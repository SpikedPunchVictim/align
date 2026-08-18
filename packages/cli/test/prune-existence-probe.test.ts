import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toRepoRelativePath, toRuleId, toViolationId } from '@spikedpunch/align-core';
import { baselinePrune } from '../src/commands/baseline.js';
import { runInit } from '../src/commands/init.js';
import { readBaseline } from '../src/align-dir.js';
import { createFileExistenceProbe } from '../src/file-existence.js';
import { seedBaseline } from './seed-baseline.js';

/**
 * ADR 028 Stage 2 against a REAL filesystem — the half core cannot test, because `packages/core`
 * imports `node:fs` nowhere and that is a standing constraint, not an accident.
 *
 * The load-bearing test here is `chmod 000`. ADR 028's decision is two overlapping mechanisms and
 * the single most likely way to damage it is for someone to conclude the probe makes the blind-spot
 * record redundant. It does not, and this file proves it by measurement rather than by assertion:
 * `fs.existsSync` returns FALSE for a file inside an unreadable directory because it swallows the
 * `EACCES`. The probe alone loses one of the two reproduced severity-zeros.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string | undefined;

function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

async function withCapturedLogs<T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly logs: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    const result = await run();
    return { result, logs: lines.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

function buildRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-probe-test-')));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n` +
      `export default defineProject({\n` +
      `  components: { app: 'src/**' },\n` +
      `  rules: (c) => [c.arch.noCycles()],\n` +
      `});\n`,
    'utf8',
  );
  linkAlignCore(dir);
  return dir;
}

afterEach(() => {
  if (tmpDir !== undefined) {
    // Restore any 0o000 directory before cleanup — `rmSync` cannot descend into one either.
    const locked = path.join(tmpDir, 'locked');
    if (fs.existsSync(locked)) fs.chmodSync(locked, 0o755);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('the measurement that justifies BOTH mechanisms existing (ADR 028)', () => {
  it('a file inside a chmod 000 directory reads as ABSENT — the probe alone loses mechanism #5', () => {
    tmpDir = buildRepo();
    fs.mkdirSync(path.join(tmpDir, 'locked'));
    fs.writeFileSync(path.join(tmpDir, 'locked', 'hidden.ts'), 'export const h = 1;\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'plain.ts'), 'export const p = 1;\n', 'utf8');
    fs.symlinkSync(path.join(tmpDir, 'plain.ts'), path.join(tmpDir, 'link.ts'));
    fs.symlinkSync(path.join(tmpDir, 'nope.ts'), path.join(tmpDir, 'broken.ts'));
    fs.chmodSync(path.join(tmpDir, 'locked'), 0o000);

    const probe = createFileExistenceProbe(tmpDir);

    expect(probe(toRepoRelativePath('plain.ts'))).toBe(true);
    expect(probe(toRepoRelativePath('link.ts'))).toBe(true); // a symlink is a path that exists — #7
    // A DANGLING symlink also reads present, and this is a deliberate change from ADR 028's
    // original `existsSync` table (which reported `false` here). Something does occupy that path;
    // concluding "deleted" and dropping the consent record would be an unproven inference, which is
    // the one thing this design refuses to make. It also makes the probe AGREE with Stage 1's
    // record, which already retains every symlink as `not-regular-file` — previously the two
    // mechanisms disagreed here and the record silently won. Command behaviour is unchanged either
    // way; the test below pins that.
    expect(probe(toRepoRelativePath('broken.ts'))).toBe(true);
    expect(probe(toRepoRelativePath('gone.ts'))).toBe(false); // genuinely deleted
    // THE ONE THAT MATTERS. The file is right there; listing its parent throws EACCES, so the probe
    // says no — exactly as `existsSync` did by swallowing the same error.
    // If this ever starts returning `true`, re-read ADR 028 before concluding the record is now
    // redundant — the record also carries the REASON, which the probe never can.
    expect(probe(toRepoRelativePath('locked/hidden.ts'))).toBe(false);
  });

  it('is case-EXACT even on a case-insensitive filesystem — a case-only rename must still transfer', () => {
    tmpDir = buildRepo();
    fs.writeFileSync(path.join(tmpDir, 'utils.ts'), 'export const u = 1;\n', 'utf8');
    const probe = createFileExistenceProbe(tmpDir);

    expect(probe(toRepoRelativePath('utils.ts'))).toBe(true);
    // `fs.existsSync` answers TRUE here on macOS and Windows. That made the orphaned `Utils.ts`
    // entry look present, suppressed ADR 006's move-transfer, turned `align check` RED on a pure
    // rename, and retained the stale entry forever — contradicting ADR 028's own consequence that
    // case-only renames are "recorded rather than fixed". Comparing directory entry names is exact
    // on every platform, which also means a developer's Mac and Linux CI now agree about a shared,
    // committed baseline.
    expect(probe(toRepoRelativePath('Utils.ts'))).toBe(false);
  });

  it('refuses to probe outside the repo, so a corrupt baseline cannot pin an entry on a foreign path', () => {
    tmpDir = buildRepo();
    const probe = createFileExistenceProbe(tmpDir);

    // `.align/baseline.json`'s schema is `z.string().min(1)` and the brand only normalizes
    // separators, so a hand-edited entry can carry `..`. Answering for a path align does not own
    // would make that entry permanently un-prunable.
    expect(probe(toRepoRelativePath('../../../../../../etc/passwd'))).toBe(false);
    expect(probe(toRepoRelativePath('/etc/passwd'))).toBe(false);
    expect(probe(toRepoRelativePath('..'))).toBe(false);
    // ...but an interior `..` that stays inside the repo is fine.
    expect(probe(toRepoRelativePath('src/../src/a.ts'))).toBe(true);
  });
});

describe('align baseline prune — the existence probe retains what the record cannot explain', () => {
  it('retains an entry whose file is on disk but absent from the scan with NO covering blind spot, byte-for-byte', async () => {
    tmpDir = buildRepo();
    // Finding a path that is on disk, unscanned, and NOT blind-spot-recorded is deliberately hard
    // after Stage 1 — the walk records every exit it knows about. Exactly one silent exit remains,
    // and ADR 028 §1 names it: an extension outside `SOURCE_EXTENSIONS` (mechanism #6), left
    // unrecorded because enumerating every non-source file in a repo is expensive and noisy, and
    // explicitly delegated to mechanism 2. So this fixture IS the real unenumerated cause, not a
    // simulation of one. The cross-version story ADR 028 tells for #6 is the realistic path here: a
    // baseline written by a version whose extension set included `.vue` (or any future plugin's),
    // read by one whose set does not.
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'notes', 'orphan.vue'), '<template />\n', 'utf8');
    const entry = {
      fingerprint: toViolationId('probe-retained'),
      ruleId: toRuleId('arch.no-cycles'),
      file: toRepoRelativePath('notes/orphan.vue'),
      acceptedAt: 1234,
      acceptedBy: 'manual' as const,
      contentFingerprint: toViolationId('content-abc'),
    };
    seedBaseline(tmpDir, [entry]);
    const before = fs.readFileSync(path.join(tmpDir, '.align', 'baseline.json'), 'utf8');

    const { result: code, logs } = await withCapturedLogs(() => baselinePrune(tmpDir!, { yes: true }));

    expect(code).toBe(0);
    expect(logs).toMatch(/Pruned 0 fixed violation\(s\)/);
    expect(logs).toMatch(/Retained 1 entry/);
    expect(logs).toContain('still on disk, but this scan produced no result for it');
    // Byte-level, not a count: the irreplaceable half of a consent record is `acceptedAt` and
    // `acceptedBy`, and a retention that rewrote either would be a quieter version of the bug.
    expect(fs.readFileSync(path.join(tmpDir, '.align', 'baseline.json'), 'utf8')).toBe(before);
    expect(readBaseline(tmpDir)).toEqual([entry]);
  });

  it('a genuinely deleted file is still pruned — retention does not become a permanent leak', async () => {
    tmpDir = buildRepo();
    seedBaseline(tmpDir, [
      {
        fingerprint: toViolationId('genuinely-gone'),
        ruleId: toRuleId('arch.no-cycles'),
        // `src/` IS observed (src/a.ts survives), so this file's absence is a real deletion and not
        // a missing tree — ADR 028 mechanism 3 (2026-08-17) retains only when the whole directory
        // produced nothing. Was `notes/deleted.ts`, whose directory never existed at all; that case
        // is now retained on purpose and is pinned by `prune-retention-and-consent.test.ts`.
        file: toRepoRelativePath('src/deleted.ts'), // never created
        acceptedAt: 1,
        acceptedBy: 'manual',
        contentFingerprint: toViolationId('content-xyz'),
      },
    ]);

    const { result: code, logs } = await withCapturedLogs(() => baselinePrune(tmpDir!, { yes: true }));

    expect(code).toBe(0);
    expect(logs).toMatch(/Pruned 1 fixed violation\(s\)/);
    expect(logs).not.toMatch(/Retained/);
    expect(readBaseline(tmpDir)).toEqual([]);
  });

  it('a file the scan OBSERVED is still pruned, though it plainly exists — the precondition, pinned', async () => {
    tmpDir = buildRepo();
    // `src/a.ts` is scanned every run and has no violation. It exists on disk, so an unconditional
    // probe would retain it — and would retain essentially every fixed violation in every repo,
    // turning `prune` into a permanent no-op. This test is what caught that during Stage 2.
    seedBaseline(tmpDir, [
      {
        fingerprint: toViolationId('observed-and-fixed'),
        ruleId: toRuleId('arch.no-cycles'),
        file: toRepoRelativePath('src/a.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    const { result: code, logs } = await withCapturedLogs(() => baselinePrune(tmpDir!, { yes: true }));

    expect(code).toBe(0);
    expect(logs).toMatch(/Pruned 1 fixed violation\(s\)/);
    expect(logs).not.toMatch(/Retained/);
    expect(readBaseline(tmpDir)).toEqual([]);
  });

  // The plan for this stage expected "broken symlink -> correctly gone, still prunes", reasoning
  // from the probe alone. Stage 1 overrides that and this test records the override: the walk
  // records EVERY symlink as `not-regular-file`, broken or not, because it cannot tell them apart
  // without following — and ADR 028 explicitly DEFERRED following symlinks. So the record retains
  // it and the more conservative mechanism wins, which is the correct precedence. The probe's own
  // answer for a broken link is still `false`, pinned in the measurement test above; the two facts
  // are consistent, and the command being conservative is the intended composition.
  it('a broken symlink is retained by the record, even though the probe alone would call it gone', async () => {
    tmpDir = buildRepo();
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    fs.symlinkSync(path.join(tmpDir, 'notes', 'nope.ts'), path.join(tmpDir, 'notes', 'broken.ts'));
    seedBaseline(tmpDir, [
      {
        fingerprint: toViolationId('broken-link'),
        ruleId: toRuleId('arch.no-cycles'),
        file: toRepoRelativePath('notes/broken.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    const { result: code, logs } = await withCapturedLogs(() => baselinePrune(tmpDir!, { yes: true }));

    expect(code).toBe(0);
    expect(logs).toMatch(/Pruned 0 fixed violation\(s\)/);
    expect(logs).toMatch(/Retained 1 entry/);
    expect(logs).toContain('not a regular file');
    expect(readBaseline(tmpDir)).toHaveLength(1);
  });

  it('an entry inside a chmod 000 directory is retained by the RECORD, which the probe could not do', async () => {
    tmpDir = buildRepo();
    fs.mkdirSync(path.join(tmpDir, 'locked'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'locked', 'hidden.ts'), 'export const h = 1;\n', 'utf8');
    fs.chmodSync(path.join(tmpDir, 'locked'), 0o000);
    const entry = {
      fingerprint: toViolationId('behind-eacces'),
      ruleId: toRuleId('arch.no-cycles'),
      file: toRepoRelativePath('locked/hidden.ts'),
      acceptedAt: 99,
      acceptedBy: 'manual' as const,
    };
    seedBaseline(tmpDir, [entry]);

    const { result: code, logs } = await withCapturedLogs(() => baselinePrune(tmpDir!, { yes: true }));

    expect(code).toBe(0);
    expect(logs).toMatch(/Retained 1 entry/);
    // Named as unreadable, not as "still on disk" — the probe said absent (asserted above), so this
    // retention came from Stage 1's record and the message proves which mechanism fired.
    expect(logs).toContain('unreadable');
    expect(readBaseline(tmpDir)).toEqual([entry]);
  });
});


/**
 * F7 from the Stage 2 review: `init`'s probe arm was pinned by prose only. It matters because
 * `init` is the OTHER destructive baseline writer and its drop path never touches `store.prune` —
 * a guard living only in the baseline store would have protected `prune` and missed both of init's
 * write paths, which is the fix-one-arm-miss-the-other shape ADR 027's F1 was.
 *
 * It also pins the union at `commands/init.ts`: `observedFiles` must be `source ∪ manifest`.
 * Narrowed to `source` alone, every `package.json` entry would read as unobserved, the probe would
 * find it on disk, and manifests would be retained forever with nothing failing.
 */
describe('align init — the same probe protection as prune (ADR 028 Stage 2, both destructive writers)', () => {
  it('retains an existing entry whose file is on disk but unobserved, instead of dropping it on the zero-violation reset path', async () => {
    tmpDir = buildRepo();
    // Same mechanism-#6 fixture as the prune test: on disk, never scanned, no blind spot.
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'notes', 'orphan.vue'), '<template />\n', 'utf8');
    const entry = {
      fingerprint: toViolationId('init-probe-retained'),
      ruleId: toRuleId('arch.no-cycles'),
      file: toRepoRelativePath('notes/orphan.vue'),
      acceptedAt: 4321,
      acceptedBy: 'manual' as const,
    };
    seedBaseline(tmpDir, [entry]);

    // The fixture is green (`arch.noCycles` over a single file), so init takes its zero-violation
    // path — the one that used to `seedBaseline(rootDir, [])` straight over an existing baseline.
    const { result: code, logs } = await withCapturedLogs(() =>
      runInit(tmpDir!, { acceptExisting: false, nonInteractive: true }),
    );

    expect(code).toBe(0);
    expect(logs).toMatch(/Retained 1 entry/);
    expect(logs).toContain('still on disk, but this scan produced no result for it');
    expect(readBaseline(tmpDir)).toEqual([entry]); // acceptedAt/acceptedBy carried, not restamped
  });

  it('still drops a genuinely-absent entry on the same path — the probe did not make init a no-op', async () => {
    tmpDir = buildRepo();
    seedBaseline(tmpDir, [
      {
        fingerprint: toViolationId('init-genuinely-gone'),
        ruleId: toRuleId('arch.no-cycles'),
        // `src/` is observed, so this is a real deletion rather than a missing tree — see the note
        // on the prune-side twin above for why the path moved out of `notes/` (ADR 028 mechanism 3).
        file: toRepoRelativePath('src/never-existed.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    const { result: code, logs } = await withCapturedLogs(() =>
      runInit(tmpDir!, { acceptExisting: false, nonInteractive: true }),
    );

    expect(code).toBe(0);
    expect(logs).not.toMatch(/Retained/);
    expect(readBaseline(tmpDir)).toEqual([]);
  });
});
