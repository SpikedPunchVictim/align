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

// R4 (greenfield mode, IMPLEMENTATION_PLAN.md Design Reserve): `align init` on a repo where a
// detected component matches zero files should scaffold it as `empty: 'until-populated'`
// out of the box — architecture-first authoring (rules declared before code) works immediately
// instead of the first `align check` hitting `ComponentValidationError`.
describe('align init — greenfield scaffolding (R4)', () => {
  function makeEmptyRepo(): string {
    // A repo with no source files at all (only a tsconfig) — `detectComponents` falls back to a
    // single `app` component whose selector matches zero files (the "Stage 0, zero files under
    // src/" scenario from GREENFIELD_TRIAD_REPORT.md).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-init-greenfield-test-'));
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
      'utf8',
    );
    return dir;
  }

  it('auto-detects a zero-file component and writes it with empty: \'until-populated\', printing a one-line explanation', async () => {
    tmpDir = makeEmptyRepo();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = ((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    }) as typeof console.log;
    let code: number;
    try {
      code = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    } finally {
      console.log = originalLog;
    }
    expect(code).toBe(0);

    const configTs = fs.readFileSync(path.join(tmpDir, 'align.config.ts'), 'utf8');
    expect(configTs).toContain("empty: 'until-populated'");

    expect(logs.join('\n')).toMatch(/matched zero files.*until-populated/);

    // The point of R4: architecture-first authoring works out of the box — no
    // ComponentValidationError, no manual edit required before the first `align check`.
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });

  it('a populated repo does NOT get the until-populated marker without --greenfield', async () => {
    tmpDir = makeSinglePackageRepo();
    const code = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    expect(code).toBe(0);
    const configTs = fs.readFileSync(path.join(tmpDir, 'align.config.ts'), 'utf8');
    expect(configTs).not.toContain('until-populated');
  });

  it('--greenfield forces the marker even on a repo that already has files', async () => {
    tmpDir = makeSinglePackageRepo();
    const code = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true, greenfield: true });
    expect(code).toBe(0);
    const configTs = fs.readFileSync(path.join(tmpDir, 'align.config.ts'), 'utf8');
    expect(configTs).toContain("empty: 'until-populated'");
    // Still checks green — a populated 'until-populated' component just evaluates normally
    // (auto-arm, R2), it isn't ungrounded.
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });
});

// create-align hardening (deliverable 2): `align init` offers to add a single
// `"align": "align check"` npm script to the target repo's package.json — idempotent,
// non-interactive-defaults-to-yes (low risk, purely additive — unlike baseline seeding's
// silence-is-never-consent doctrine), and skippable via --no-scripts.
describe('align init — npm-script offer', () => {
  function writePackageJson(dir: string, content: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(content, null, 2), 'utf8');
  }

  it('adds the "align" script by default in non-interactive mode (no --yes needed)', async () => {
    tmpDir = makeSinglePackageRepo();
    writePackageJson(tmpDir, { name: 'target-repo', version: '1.0.0' });
    const code = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true });
    expect(code).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.align).toBe('align check');
  });

  it('--no-scripts skips the offer entirely — package.json scripts stay untouched', async () => {
    tmpDir = makeSinglePackageRepo();
    writePackageJson(tmpDir, { name: 'target-repo', version: '1.0.0' });
    const code = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true });
    expect(code).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.align).toBeUndefined();
  });

  it('is idempotent — re-running does not touch an already-present "align" script', async () => {
    tmpDir = makeSinglePackageRepo();
    writePackageJson(tmpDir, { name: 'target-repo', version: '1.0.0', scripts: { align: 'align check --json' } });
    const code = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true, yes: true });
    expect(code).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    // Never overwritten, even though it differs from the default "align check".
    expect(pkg.scripts?.align).toBe('align check --json');
  });

  it('no-ops silently when the target repo has no package.json at all', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-init-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/index.ts'), `export const x = 1;\n`, 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
      'utf8',
    );
    const code = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true, yes: true });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'package.json'))).toBe(false);
  });
});
