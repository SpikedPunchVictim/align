import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALIGN_VERSION } from '../src/telemetry/index.js';
import { ensureAlignDir, readVersionFile, recordBaselineReconciled, writeBaseline } from '../src/align-dir.js';
import { withAlignDirLock } from '../src/align-lock.js';

/**
 * LEDGER **D031**. `.align/version.json` got ADR 030's atomic write and neither its lock nor its
 * token. That was defensible while `baselineReconciledBy` had no readers — a field nothing consults
 * cannot lose anything that matters. **D028 made it the field `align upgrade` gates on**, and the
 * write discipline was not re-derived at that moment; this suite is that correction.
 *
 * The lost update, concretely: A runs `recordBaselineReconciled`, setting both fields; B is inside
 * `stampAlignVersion`, having read BEFORE A wrote, so B's `{ ...current }` carries no
 * `baselineReconciledBy` and its write erases A's. The user is then offered a reconciliation they just
 * finished — conservative, hence S3, but a lost update of the field deciding whether `upgrade` runs.
 */

let tmpDir: string;
afterEach(() => { if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true }); });
function repo(): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-versionlock-')));
  ensureAlignDir(dir);
  return dir;
}
function lockFile(dir: string): string {
  return path.join(dir, '.align', '.lock');
}

describe('the version file is written under the lock', () => {
  it('recordBaselineReconciled waits for a lock held by another align, and refuses rather than racing', () => {
    // A live holder on another machine: not stale, so not breakable. Before this change the write went
    // straight through while another align was mid-commit.
    const dir = repo();
    fs.writeFileSync(
      lockFile(dir),
      JSON.stringify({ pid: 4821, host: 'some-other-host', command: 'align baseline accept', acquiredAt: new Date().toISOString() }),
    );

    expect(() => recordBaselineReconciled(dir)).toThrow(/timed out .* waiting for the .align\/ lock/);
    // Nothing written — a refusal that still stamped would be the defect wearing an exception.
    expect(readVersionFile(dir)).toBeUndefined();
  });

  it('writes normally when nothing else holds it', () => {
    const dir = repo();

    recordBaselineReconciled(dir);

    expect(readVersionFile(dir)?.baselineReconciledBy).toBe(ALIGN_VERSION);
  });
});

describe('the lock is re-entrant within one process, or align deadlocks against itself', () => {
  it('writeBaseline still succeeds, though it stamps the version file from inside its own lock', () => {
    // The hazard this change created and had to close in the same breath: `writeBaseline` holds the
    // lock and calls `stampAlignVersion`, which now wants it too. Without re-entrancy that is align
    // waiting 10s for a lock it is holding, then reporting a CONCURRENT ALIGN — a self-inflicted
    // failure on the most ordinary write in the product.
    const dir = repo();

    expect(() => writeBaseline(dir, [], undefined)).not.toThrow();

    expect(readVersionFile(dir)?.alignVersion).toBe(ALIGN_VERSION);
    expect(fs.existsSync(lockFile(dir))).toBe(false);
  });

  it('a nested acquire runs inside the outer one and does not release it early', () => {
    // The property that makes re-entrancy safe rather than merely quiet: the INNER frame must not
    // release. If it did, the outer frame would finish its commit unprotected — worse than the
    // deadlock, because it is silent.
    const dir = repo();
    const alignDir = path.join(dir, '.align');
    let lockPresentInsideOuterAfterInner = false;

    withAlignDirLock(alignDir, 'outer', () => {
      withAlignDirLock(alignDir, 'inner', () => undefined);
      lockPresentInsideOuterAfterInner = fs.existsSync(lockFile(dir));
    });

    expect(lockPresentInsideOuterAfterInner).toBe(true);
    // ...and the outer frame still releases on exit.
    expect(fs.existsSync(lockFile(dir))).toBe(false);
  });
});
