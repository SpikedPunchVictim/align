import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';
import { runExportIr } from '../src/commands/export-ir.js';

// Bug hunt 2026-08-03, Needs-Review #2: end-to-end verification that `program.ts`'s command
// actions actually use the resolved repo root rather than `process.cwd()` — `repo-root.test.ts`
// covers `resolveRepoRoot`/`requireRepoRoot` in isolation, this file drives the real `Command`
// tree (`buildProgram().parseAsync(...)`) from a real chdir'd subdirectory, the way a user
// actually invokes the CLI. No child_process spawning (align's own dogfood rule bans
// `node:child_process` in this component outside the audited git rails) — `process.chdir` is a
// same-process cwd change, not a spawn, so it stays within that rule.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string | undefined;
const originalCwd = process.cwd();

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-repo-root-e2e-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  tmpDir = dest;
  return dest;
}

function makeEmptyRepo(): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-repo-root-e2e-'));
  tmpDir = dest;
  return dest;
}

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

async function withCapturedConsole<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  // eslint-disable-next-line no-console
  console.log = ((...args: unknown[]) => logs.push(args.map(String).join(' '))) as typeof console.log;
  // eslint-disable-next-line no-console
  console.error = ((...args: unknown[]) => errors.push(args.map(String).join(' '))) as typeof console.error;
  try {
    const result = await run();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('align <command> resolves the repo root instead of trusting cwd blindly', () => {
  it('`align check` run from a nested subdirectory resolves to and scans the repo root', async () => {
    const root = copyFixture('simple-app');
    const nested = path.join(root, 'src');
    process.chdir(nested);

    const { errors } = await withCapturedConsole(async () => {
      await buildProgram().parseAsync(['node', 'align', 'check'], { from: 'node' });
    });

    expect(process.exitCode).toBe(0);
    // The one-line notice: resolved root differs from cwd, so it must say so.
    expect(errors.some((line) => line.includes(root) && line.includes(nested))).toBe(true);
  });

  it('`align check --untrusted` resolves via a `.align/`-only checkout (no align.config.ts present)', async () => {
    const root = copyFixture('simple-app');
    // Produce .align/ruleset-ir.json from the still-present config, then remove the config itself
    // — the scenario ADR 014's --untrusted mode exists for (a trimmed, config-free checkout).
    const exportCode = await runExportIr(root);
    expect(exportCode).toBe(0);
    fs.rmSync(path.join(root, 'align.config.ts'));
    expect(fs.existsSync(path.join(root, '.align'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'align.config.ts'))).toBe(false);

    const nested = path.join(root, 'src');
    process.chdir(nested);

    await withCapturedConsole(async () => {
      await buildProgram().parseAsync(['node', 'align', 'check', '--untrusted'], { from: 'node' });
    });

    expect(process.exitCode).toBe(0);
  });

  it('no align.config.ts or .align/ anywhere above cwd: a clean, actionable error and a non-zero exit — not a crash', async () => {
    const root = makeEmptyRepo();
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    process.chdir(nested);

    const { errors } = await withCapturedConsole(async () => {
      // Must not throw — parseAsync should resolve cleanly even though the command can't run.
      await buildProgram().parseAsync(['node', 'align', 'check'], { from: 'node' });
    });

    expect(process.exitCode).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain('align init');
  });

  it('`align init` still targets cwd — does NOT resolve up to an ancestor align.config.ts', async () => {
    const root = makeEmptyRepo();
    fs.writeFileSync(path.join(root, 'align.config.ts'), 'export default { components: {} };\n', 'utf8');
    const nested = path.join(root, 'packages', 'sub');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(nested, 'src'));
    fs.writeFileSync(path.join(nested, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
    fs.writeFileSync(
      path.join(nested, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
      'utf8',
    );
    process.chdir(nested);

    const { logs } = await withCapturedConsole(async () => {
      await buildProgram().parseAsync(['node', 'align', 'init', '--no-scripts', '-y'], { from: 'node' });
    });

    // init targeted the nested cwd, not the ancestor root that happens to have align.config.ts.
    expect(fs.existsSync(path.join(nested, 'align.config.ts'))).toBe(true);
    expect(logs.some((line) => line.includes('Initializing align in') && line.includes(nested))).toBe(true);
    // The ancestor's align.config.ts (the sentinel content above) was left untouched.
    expect(fs.readFileSync(path.join(root, 'align.config.ts'), 'utf8')).toContain('components: {}');
  });

  // `align doctor`'s contract is "never fails — exit code is always 0" (`config.ts`'s `loadConfig`
  // doc comment). The first version of Part B's repo-root fix ran doctor through the same
  // resolve-or-fail path as every other command, which regressed that contract: a directory with
  // no align.config.ts/.align/ anywhere used to exit 0 (loadConfig failed internally, doctor
  // turned it into a `config-error` advisory); it started exiting 1 instead, and an agent loop or
  // CI step running `align doctor` unconditionally (its whole point, being the one command safe
  // to run without checking the result) would start failing on a directory align isn't set up in.
  // These two tests pin the corrected contract so it can't regress again silently.
  describe('align doctor is the one exception — it never fails, even with no repo root at all', () => {
    it('resolves to the repo root from a nested subdirectory, same as every other command', async () => {
      const root = copyFixture('simple-app');
      const nested = path.join(root, 'src');
      process.chdir(nested);

      const { errors } = await withCapturedConsole(async () => {
        await buildProgram().parseAsync(['node', 'align', 'doctor'], { from: 'node' });
      });

      expect(process.exitCode).toBe(0);
      expect(errors.some((line) => line.includes(root) && line.includes(nested))).toBe(true);
    });

    it('no align.config.ts or .align/ anywhere above cwd: exits 0 and reports it as an advisory, not a CLI error', async () => {
      const root = makeEmptyRepo();
      const nested = path.join(root, 'a', 'b');
      fs.mkdirSync(nested, { recursive: true });
      process.chdir(nested);

      const { logs, errors } = await withCapturedConsole(async () => {
        await buildProgram().parseAsync(['node', 'align', 'doctor'], { from: 'node' });
      });

      expect(process.exitCode).toBe(0);
      // Delivered as a doctor advisory (stdout, via its normal report formatting) — NOT via
      // reportCliError (which would print `align doctor: ...` to stderr and set a non-zero exit).
      expect(logs.join('\n')).toContain('repo-not-found');
      expect(logs.join('\n')).toContain(nested);
      expect(logs.join('\n')).toContain('align init');
      expect(errors).toEqual([]);
    });

    it('--json: no repo root anywhere reports the same condition as a structured advisory, still exit 0', async () => {
      const root = makeEmptyRepo();
      const nested = path.join(root, 'a', 'b');
      fs.mkdirSync(nested, { recursive: true });
      process.chdir(nested);

      // doctor's --json branch writes via `process.stdout.write`, not `console.log`.
      const chunks: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => {
        chunks.push(chunk);
        return true;
      }) as typeof process.stdout.write;
      try {
        await buildProgram().parseAsync(['node', 'align', 'doctor', '--json'], { from: 'node' });
      } finally {
        process.stdout.write = originalWrite;
      }

      expect(process.exitCode).toBe(0);
      const payload = JSON.parse(chunks.join('')) as { advisories: { kind: string; message: string }[] };
      expect(payload.advisories.some((a) => a.kind === 'repo-not-found' && a.message.includes('align init'))).toBe(true);
    });
  });
});
