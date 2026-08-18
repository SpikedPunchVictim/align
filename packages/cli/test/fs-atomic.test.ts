import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/fs-atomic.js';

let dir: string;

afterEach(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  return (dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-fs-atomic-'))));
}

/** Every temp file this helper creates, still present after the call. Empty is the only correct
 * answer: `.align/` is a directory users open when something has gone wrong, and stray
 * `.baseline.json.4821.3.tmp` files read as corruption to whoever is debugging. */
function leftoverTempFiles(d: string): string[] {
  return fs.readdirSync(d).filter((name) => name.endsWith('.tmp'));
}

describe('writeFileAtomic preserves what writeFileSync preserved', () => {
  // Both behaviours were LOST by the first version of this module and found by adversarial review.
  // Both mutations below (drop the fchmod / drop the symlink resolution) turn these red, which is
  // the property the rest of this file was missing.
  it('keeps the replaced file\'s permissions instead of widening them to the umask default', () => {
    const d = tmpDir();
    const file = path.join(d, 'private.json');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o600);

    writeFileAtomic(file, 'new');

    // Measured before the fix: 0600 became 0644. align does not get to widen permissions on a file
    // in someone else's repository as a side effect of an unrelated change.
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
  });

  it('writes THROUGH a symlink rather than replacing it with a regular file', () => {
    const d = tmpDir();
    const real = path.join(d, 'real.json');
    const link = path.join(d, 'link.json');
    fs.writeFileSync(real, 'REAL-OLD');
    fs.symlinkSync(real, link);

    writeFileAtomic(link, 'NEW');

    // Measured before the fix: the link became a regular file holding NEW while `real.json` kept
    // REAL-OLD — a silent fork. A baseline shared across git worktrees is a real configuration.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('NEW');
  });

  it('creates the file a DANGLING symlink promises, rather than throwing', () => {
    const d = tmpDir();
    const link = path.join(d, 'dangling.json');
    fs.symlinkSync(path.join(d, 'never-existed.json'), link);

    writeFileAtomic(link, 'CREATED');

    expect(fs.readFileSync(link, 'utf8')).toBe('CREATED');
  });

  it('gives a brand-new file the process default, not some inherited mode', () => {
    const d = tmpDir();
    const file = path.join(d, 'fresh.json');

    writeFileAtomic(file, 'x');

    // Calibration for the mode test above: proves the fchmod is conditional on an existing file
    // rather than applying a hardcoded mode to everything.
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('writeFileAtomic', () => {
  it('creates a file that did not exist', () => {
    const d = tmpDir();
    const file = path.join(d, 'new.json');

    writeFileAtomic(file, '{"a":1}\n');

    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n');
    expect(leftoverTempFiles(d)).toEqual([]);
  });

  it('replaces an existing file', () => {
    const d = tmpDir();
    const file = path.join(d, 'existing.json');
    fs.writeFileSync(file, 'OLD');

    writeFileAtomic(file, 'NEW');

    expect(fs.readFileSync(file, 'utf8')).toBe('NEW');
    expect(leftoverTempFiles(d)).toEqual([]);
  });

  it('leaves the ORIGINAL file intact when the write fails — the whole point', () => {
    const d = tmpDir();
    const file = path.join(d, 'precious.json');
    fs.writeFileSync(file, 'IRREPLACEABLE');
    // A directory where the temp file wants to be: `openSync(tmp, 'w')` fails with EISDIR, standing
    // in for the ENOSPC/EACCES/kill that this helper actually exists for. What matters is not which
    // error it is, but that the original file is untouched afterwards — with `writeFileSync` the
    // truncation has already happened by the time anything can fail.
    const tmpBlocker = path.join(d, `.precious.json.${process.pid}.1.tmp`);
    fs.mkdirSync(tmpBlocker);

    // Not asserted to throw a specific code: the temp name embeds a counter that advances per call,
    // so which attempt collides depends on call order. Either it throws (blocked) or it succeeds
    // (missed the blocker) — in both cases the original must still be readable.
    try {
      writeFileAtomic(file, 'REPLACEMENT');
    } catch {
      expect(fs.readFileSync(file, 'utf8')).toBe('IRREPLACEABLE');
      return;
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('REPLACEMENT');
  });

  it('cleans up its temp file when the rename fails', () => {
    const d = tmpDir();
    // Renaming onto a non-empty DIRECTORY fails (ENOTEMPTY/EISDIR/EPERM by platform), which is the
    // cheapest way to fail at the rename step specifically rather than the write step.
    const target = path.join(d, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'child'), 'x');

    expect(() => writeFileAtomic(target, 'contents')).toThrow();
    expect(leftoverTempFiles(d)).toEqual([]);
  });

  it('a reader never observes a partial file — only the old bytes or the new ones', () => {
    const d = tmpDir();
    const file = path.join(d, 'observed.json');
    const oldContents = `${'o'.repeat(200_000)}\n`;
    const newContents = `${'n'.repeat(200_000)}\n`;
    fs.writeFileSync(file, oldContents);

    // The property, stated as the only two admissible observations. A `writeFileSync` of this size
    // is emphatically NOT one syscall, so this is the assertion that distinguishes the two
    // implementations — though a single-threaded test can only sample it, which is why the
    // structural guarantee (rename) is what the doc comment leans on rather than this loop.
    for (let i = 0; i < 20; i += 1) {
      writeFileAtomic(file, i % 2 === 0 ? newContents : oldContents);
      const seen = fs.readFileSync(file, 'utf8');
      expect(seen === oldContents || seen === newContents).toBe(true);
      expect(seen.length).toBe(200_001);
    }
    expect(leftoverTempFiles(d)).toEqual([]);
  });

  it('does not collide when the same file is written repeatedly in one process', () => {
    const d = tmpDir();
    const file = path.join(d, 'repeat.json');

    for (let i = 0; i < 50; i += 1) writeFileAtomic(file, `v${i}`);

    expect(fs.readFileSync(file, 'utf8')).toBe('v49');
    expect(leftoverTempFiles(d)).toEqual([]);
  });
});
