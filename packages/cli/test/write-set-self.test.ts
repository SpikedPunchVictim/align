import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expectMarkerRegionUnchanged, expectOnlyWrote, snapshotTree } from './write-set.js';

// Self-test for the ADR 026 fast-path helper itself (`write-set.ts`) — the invariant every
// `write-set-*.test.ts` file depends on, so a bug HERE would silently blunt every one of them. No
// CLI command involved: plain filesystem operations against a tmpdir, asserting the helper's own
// contract (what it flags, what it lets through, and the exact failure message shape).

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'align-write-set-self-test-'));
}

describe('snapshotTree / expectOnlyWrote', () => {
  it('an untouched tree passes against an empty write-set', () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a', 'utf8');
    const before = snapshotTree(tmpDir);
    expect(() => expectOnlyWrote(before, tmpDir, [])).not.toThrow();
  });

  it('flags an undeclared new file, naming it as added', () => {
    tmpDir = makeTmpDir();
    const before = snapshotTree(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'surprise.txt'), 'unexpected', 'utf8');
    expect(() => expectOnlyWrote(before, tmpDir, [])).toThrow(/\+ added\s+surprise\.txt/);
  });

  it('flags an undeclared content change to an existing file, naming it as modified', () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'original', 'utf8');
    const before = snapshotTree(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'mutated', 'utf8');
    expect(() => expectOnlyWrote(before, tmpDir, [])).toThrow(/~ modified\s+a\.txt/);
  });

  it('flags an undeclared deletion, naming it as deleted', () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'original', 'utf8');
    const before = snapshotTree(tmpDir);
    fs.rmSync(path.join(tmpDir, 'a.txt'));
    expect(() => expectOnlyWrote(before, tmpDir, [])).toThrow(/- deleted\s+a\.txt/);
  });

  it('passes when every change is named in the write-set', () => {
    tmpDir = makeTmpDir();
    const before = snapshotTree(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'new.txt'), 'new', 'utf8');
    expect(() => expectOnlyWrote(before, tmpDir, ['sub/new.txt'])).not.toThrow();
  });

  it('licenses an implied ancestor directory without it being named explicitly', () => {
    tmpDir = makeTmpDir();
    const before = snapshotTree(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'new.txt'), 'new', 'utf8');
    // `sub/` itself is not in the write-set, only its child — the directory's own creation is
    // implied by the file the caller DID declare (mirrors `.align/`'s creation alongside
    // `.align/baseline.json` in the real command tests).
    expect(() => expectOnlyWrote(before, tmpDir, ['sub/new.txt'])).not.toThrow();
  });

  it('still flags an undeclared file inside an otherwise-licensed directory', () => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    const before = snapshotTree(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'sub', 'allowed.txt'), 'ok', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'sub', 'not-allowed.txt'), 'surprise', 'utf8');
    expect(() => expectOnlyWrote(before, tmpDir, ['sub/allowed.txt'])).toThrow(/not-allowed\.txt/);
  });

  it('never descends into a symlinked directory — it records the link target only', () => {
    tmpDir = makeTmpDir();
    const linkedTargetDir = makeTmpDir();
    fs.writeFileSync(path.join(linkedTargetDir, 'inside.txt'), 'untouched by the snapshot', 'utf8');
    fs.symlinkSync(linkedTargetDir, path.join(tmpDir, 'link'), 'dir');

    const before = snapshotTree(tmpDir);
    // Mutating the symlink TARGET must not register as a change under `tmpDir` — the helper
    // records the link itself (its target path), never traverses through it.
    fs.writeFileSync(path.join(linkedTargetDir, 'inside.txt'), 'mutated after the symlink', 'utf8');
    expect(() => expectOnlyWrote(before, tmpDir, [])).not.toThrow();
    fs.rmSync(linkedTargetDir, { recursive: true, force: true });
  });

  it('excludes .git from the snapshot by default', () => {
    tmpDir = makeTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, '.git', 'index'), 'v1', 'utf8');
    const before = snapshotTree(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.git', 'index'), 'v2', 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
    expect(() => expectOnlyWrote(before, tmpDir, [])).not.toThrow();
  });
});

describe('expectMarkerRegionUnchanged', () => {
  const START = '<!-- align:start -->';
  const END = '<!-- align:end -->';

  it('passes when only the region inside the markers changed', () => {
    const before = `# Human notes\n\n${START}\nold block\n${END}\n\nmore human notes\n`;
    const after = `# Human notes\n\n${START}\nNEW block\n${END}\n\nmore human notes\n`;
    expect(() => expectMarkerRegionUnchanged(before, after, 'CLAUDE.md', START, END)).not.toThrow();
  });

  it('throws, naming the file, when content OUTSIDE the markers changed', () => {
    const before = `# Human notes\n\n${START}\nblock\n${END}\n\nmore human notes\n`;
    const after = `# Human notes (edited!)\n\n${START}\nblock\n${END}\n\nmore human notes\n`;
    expect(() => expectMarkerRegionUnchanged(before, after, 'CLAUDE.md', START, END)).toThrow(/CLAUDE\.md.*OUTSIDE/s);
  });

  it('throws when the "before" snapshot has no well-formed marker pair (helper misuse, not a real diff)', () => {
    const before = `# Human notes\n\n${START}\nno closing marker\n`;
    const after = `# Human notes\n\n${START}\nno closing marker\n${END}\n`;
    expect(() => expectMarkerRegionUnchanged(before, after, 'CLAUDE.md', START, END)).toThrow(/"before" snapshot has no well-formed/);
  });

  it('throws when the "after" snapshot has no well-formed marker pair', () => {
    const before = `# Human notes\n\n${START}\nblock\n${END}\n`;
    const after = `# Human notes\n\n${START}\nblock\n`;
    expect(() => expectMarkerRegionUnchanged(before, after, 'CLAUDE.md', START, END)).toThrow(/"after" snapshot has no well-formed/);
  });
});
