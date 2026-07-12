import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { runCheck } from '../src/commands/check.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSinglePackageRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-init-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/index.ts'), `export const x = 1;\n`, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    'utf8',
  );
  return dir;
}

describe('align init', () => {
  it('writes align.config.ts, CLAUDE.md, and leaves check green on a clean single-package repo', async () => {
    tmpDir = makeSinglePackageRepo();
    const code = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'align.config.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'CLAUDE.md'))).toBe(true);
    const claudeMd = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('<!-- align:start -->');
    expect(claudeMd).toContain('align_check');

    // Carried Stage 3 affordance: align.config.ts gets the generated-rules auto-merge note too.
    const configTs = fs.readFileSync(path.join(tmpDir, 'align.config.ts'), 'utf8');
    expect(configTs).toContain('align:generated-rules-note:start');

    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });

  it('is idempotent — re-running does not duplicate the CLAUDE.md block', async () => {
    tmpDir = makeSinglePackageRepo();
    await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    const claudeMd = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd.split('<!-- align:start -->')).toHaveLength(2);
  });

  it('appends to a pre-existing CLAUDE.md without clobbering the human-authored content (ADR 009)', async () => {
    tmpDir = makeSinglePackageRepo();
    const humanContent = '# My Project\n\nSome hand-written project instructions.\n\n## Conventions\n\n- Use tabs.\n';
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), humanContent, 'utf8');

    await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    const afterFirstInit = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(afterFirstInit).toContain(humanContent.trim());
    expect(afterFirstInit).toContain('<!-- align:start -->');
    expect(afterFirstInit).toContain('<!-- align:end -->');

    // Re-running init (e.g. against an already-init'd repo) must be idempotent: the human content
    // survives unchanged, and the align block is replaced in place — never duplicated.
    await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    const afterSecondInit = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(afterSecondInit.split('<!-- align:start -->')).toHaveLength(2);
    expect(afterSecondInit).toContain(humanContent.trim());
    expect(afterSecondInit).toContain('- Use tabs.');
  });

  it('exits red non-interactively when violations exist and --accept-existing is absent', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-init-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    // A self-referential cycle so the cycles-first starter rule finds a real violation.
    fs.writeFileSync(path.join(tmpDir, 'src/a.ts'), `import { b } from './b.js';\nexport function a() { return b(); }\n`, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'src/b.ts'), `import { a } from './a.js';\nexport function b() { return a(); }\n`, 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
      'utf8',
    );

    const code = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    expect(code).toBe(1);
  });

  it('--accept-existing seeds the baseline non-interactively and exits 0', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-init-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/a.ts'), `import { b } from './b.js';\nexport function a() { return b(); }\n`, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'src/b.ts'), `import { a } from './a.js';\nexport function b() { return a(); }\n`, 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
      'utf8',
    );

    const code = await runInit(tmpDir, { acceptExisting: true, nonInteractive: true });
    expect(code).toBe(0);
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });
});
