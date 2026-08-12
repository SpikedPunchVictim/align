import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { expectMarkerRegionUnchanged, expectOnlyWrote, snapshotTree } from './write-set.js';

// ADR 026 fast-path coverage for `align init` — the command BUG #10 fired from
// (docs/adr/026-declared-write-sets.md). Additive: `test/init.test.ts` keeps its own assertions
// untouched, so a failure here points at the whole-tree invariant, never at a refactor of an
// existing test. Mirrors `test/init.test.ts`'s own inline fixture style (`makeSinglePackageRepo`)
// rather than the `test/fixtures/*` copies, matching this command's established test convention.

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSinglePackageRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-write-set-init-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/index.ts'), `export const x = 1;\n`, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'target-repo', version: '1.0.0' }, null, 2), 'utf8');
  return dir;
}

const INIT_WRITE_SET = ['align.config.ts', 'CLAUDE.md', '.gitignore', 'package.json', '.align', '.align/baseline.json', '.align/version.json'];

describe('`align init` write-set (ADR 026 fast path)', () => {
  it('zero-violations/reset path touches only its declared write-set', async () => {
    tmpDir = makeSinglePackageRepo();
    const before = snapshotTree(tmpDir);

    const code = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    expect(code).toBe(0);

    expectOnlyWrote(before, tmpDir, INIT_WRITE_SET);
  });

  it('seed path (--accept-existing) touches only its declared write-set', async () => {
    tmpDir = makeSinglePackageRepo();
    // A self-referential cycle so the cycles-first starter rule finds a real, seedable violation
    // (same shape as `test/init.test.ts`'s own `--accept-existing` test).
    fs.writeFileSync(path.join(tmpDir, 'src/a.ts'), `import { b } from './b.js';\nexport function a() { return b(); }\n`, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'src/b.ts'), `import { a } from './a.js';\nexport function b() { return a(); }\n`, 'utf8');
    const before = snapshotTree(tmpDir);

    const code = await runInit(tmpDir, { acceptExisting: true, nonInteractive: true });
    expect(code).toBe(0);

    expectOnlyWrote(before, tmpDir, INIT_WRITE_SET);
  });

  // The content-aware clause (ADR 026, BUG #10 as a property): a SECOND `init` run against a repo
  // that already has an align-owned block in both marker-owned files must change only the marked
  // region — the human's own CLAUDE.md content and the hand-authored ruleset in align.config.ts
  // must be byte-identical outside align's markers, not merely "the file still contains the
  // substring" (which a partial corruption could still satisfy).
  it('a second run only touches the marked region of CLAUDE.md and align.config.ts — the rest is byte-identical', async () => {
    tmpDir = makeSinglePackageRepo();
    const humanContent = '# My Project\n\nSome hand-written project instructions.\n\n## Conventions\n\n- Use tabs.\n';
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), humanContent, 'utf8');

    const first = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    expect(first).toBe(0);

    const claudeMdBefore = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    const configBefore = fs.readFileSync(path.join(tmpDir, 'align.config.ts'), 'utf8');
    const before = snapshotTree(tmpDir);

    const second = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    expect(second).toBe(0);

    // The second run is a no-op check-wise (nothing changed on disk to re-detect), so its ONLY
    // legitimate writes are the two marker-owned files (re-splicing an identical block still
    // rewrites the file, even though the bytes end up the same) plus the baseline/version
    // re-stamp `writeBaseline`/`recordBaselineReconciled` always perform on a re-run.
    expectOnlyWrote(before, tmpDir, ['CLAUDE.md', 'align.config.ts', '.align/baseline.json', '.align/version.json']);

    const claudeMdAfter = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    const configAfter = fs.readFileSync(path.join(tmpDir, 'align.config.ts'), 'utf8');
    expectMarkerRegionUnchanged(claudeMdBefore, claudeMdAfter, 'CLAUDE.md', '<!-- align:start -->', '<!-- align:end -->');
    expectMarkerRegionUnchanged(configBefore, configAfter, 'align.config.ts', '// align:generated-rules-note:start', '// align:generated-rules-note:end');
  });
});
