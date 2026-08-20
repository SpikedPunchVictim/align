import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderConfig } from '../src/init/render-config.js';
import { runCheck } from '../src/commands/check.js';
import { runInit } from '../src/commands/init.js';

/**
 * LEDGER **D041** (bug hunt B4) — a directory name must not become executable code in the
 * `align.config.ts` that `align init` writes.
 *
 * `render-config.ts` interpolated the component PATTERN into a single-quoted TypeScript literal
 * unescaped — `'${c.pattern}'` — while escaping the component NAME with `JSON.stringify` on the very
 * same line. The pattern is built straight from a directory name (`detect-components.ts`:
 * `pattern: \`${e.name}/**\``), so any apostrophe in a directory name broke the file.
 *
 * The bug hunt reported that as "writes a syntactically invalid config". It is worse than that.
 * Measured, with a directory named `a', zz: (()=>{throw new Error('INJECTED-CODE-EXECUTED')})() && 'b`:
 *
 *     $ align init -y --no-scripts
 *     Detected 2 component(s): aZzThrowNewErrorINJECTEDCODEEXECUTEDB, core
 *     Wrote align.config.ts ...
 *     $ align check
 *     align check: INJECTED-CODE-EXECUTED
 *
 * The injected expression is EVALUATED, because align loads the config it just wrote. So cloning an
 * untrusted repository and running `align init` is enough for a directory name in that repository to
 * run arbitrary code as the user, on the next `align check`. That is a different severity class from
 * a syntax error, and the ledger's scale (which grades data loss) has no row for it.
 *
 * That payload needs parentheses, though, and align's glob dialect rejects `(...)` — so after the fix
 * it fails the selector lint, and a test resting on it could not tell "the code did not run" from
 * "something else fired first". A paren-free payload settles it, and was measured in BOTH directions
 * through `runInit` + `runCheck` on the built CLI:
 *
 *     directory: a', zz: globalThis.__ALIGN_D041_RCE_MARKER__ = 'executed', b: 'c
 *
 *     unfixed  "aZz…": 'a', zz: globalThis.__ALIGN_D041_RCE_MARKER__ = 'executed', b: 'c/**',
 *              MARKER value: 'executed'  -> CODE EXECUTED
 *     fixed    "aZz…": "a', zz: globalThis.__ALIGN_D041_RCE_MARKER__ = 'executed', b: 'c/**",
 *              MARKER value: undefined   -> did not execute
 *
 * A bare assignment needs no call syntax, so it clears the dialect lint and the escaping is the only
 * thing standing between it and execution.
 *
 * The plain-apostrophe case is the same defect without the malice, and it leaves the repository
 * STUCK: measured, `align init` had already written `CLAUDE.md` and `.gitignore` before failing with
 * `align init: Expected ',', got 'ident'` — naming no file and no line — and re-running `init` will
 * not repair it ("align.config.ts already exists — leaving it as-is").
 *
 * **Why escaping is the whole fix, and why the same line is the proof.** `JSON.stringify` is exactly
 * what the name beside it already used, and a correctly quoted `"don't/**"` still matches the
 * directory — there is nothing to reject, only something to quote. Component NAMES need no change:
 * `sanitizeName`/`dedupeNames` already reduce them to identifier-safe camelCase, and their comments
 * name the `c.foo - 2` hazard that discipline exists for.
 */

let tmpDir: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The payload from the original reproduction: closes the quote, throws from an IIFE, reopens it. */
const THROWING_INJECTION = `a', zz: (()=>{throw new Error('INJECTED-CODE-EXECUTED')})() && 'b`;

/**
 * A second payload that executes with NO parentheses and no braces — a bare assignment.
 *
 * Needed because the first one stops proving anything once the fix is in: align's glob dialect
 * rejects `(...)` as an extglob group, so after escaping, that config fails the selector lint before
 * it would have run anything. A test resting on it alone could not tell "the code did not run"
 * from "a different check happened to fire first" [S-05]. This one passes the dialect lint, so the
 * ONLY thing standing between it and execution is the escaping.
 */
const RCE_MARKER = '__ALIGN_D041_RCE_MARKER__';
const ASSIGNING_INJECTION = `a', zz: globalThis.${RCE_MARKER} = 'executed', b: 'c`;

/** Collects everything written to `console.log`/`console.error` AND suppresses it. Must not be
 * combined with `quiet()` — see the note at its one call site for why that combination silently
 * captures nothing. */
function captureConsole(): string[] {
  const said: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void said.push(a.map(String).join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void said.push(a.map(String).join(' ')));
  return said;
}

/** The `process.stdout.write` half of `quiet()`, without touching the console spies. */
async function withSilentStdout<T>(fn: () => Promise<T>): Promise<T> {
  const out = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
  }
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const out = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
  }
}

/**
 * A two-package repo whose SECOND package directory is named by the caller.
 *
 * Two packages, not one: `detectFromTopLevelPackageDirs` returns `[]` when no directory holds a
 * `package.json`, and a lone one falls through to `detectSinglePackage`'s hardcoded `app`/`src/**`
 * — which is inert for this defect and is how the bug hunt's first attempt failed to reproduce it.
 * The pattern only carries a directory name down this path.
 */
function repoWithPackageDir(dirName: string): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-init-escape-')));
  for (const name of ['core', dirName]) {
    fs.mkdirSync(path.join(dir, name, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'src/index.ts'), 'export const x = 1;\n', 'utf8');
    fs.writeFileSync(path.join(dir, name, 'package.json'), JSON.stringify({ name: 'p' }), 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true }), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    'utf8',
  );
  fs.mkdirSync(path.join(dir, 'node_modules', '@spikedpunch'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'packages', 'core'), path.join(dir, 'node_modules', '@spikedpunch', 'align-core'));
  return dir;
}

describe('renderConfig escapes the component pattern', () => {
  it('an apostrophe in a pattern does not terminate the string literal', () => {
    const rendered = renderConfig([{ name: 'dont', pattern: "don't/**" }], []);

    expect(rendered).not.toContain("'don't/**'");
    expect(rendered).toContain(JSON.stringify("don't/**"));
  });

  it('escapes the greenfield branch too — the same interpolation appears twice', () => {
    // Both arms of the ternary interpolated the pattern raw. Fixing only the one the reproduction
    // happened to take would be shape [S-09] committed while fixing an S-09 instance.
    const rendered = renderConfig([{ name: 'dont', pattern: "don't/**" }], [], new Set(['dont']));

    expect(rendered).toContain(`pattern: ${JSON.stringify("don't/**")}`);
    expect(rendered).not.toContain("pattern: 'don't/**'");
  });

  it('escapes a backslash, which would otherwise start an escape sequence', () => {
    // Legal in a directory name on macOS and Linux, and it corrupts the literal quietly rather than
    // loudly: `'a\b/**'` parses fine and means something else.
    const rendered = renderConfig([{ name: 'a', pattern: 'a\\b/**' }], []);

    expect(rendered).toContain(JSON.stringify('a\\b/**'));
  });
});

describe('align init cannot be made to write executable code [D041]', () => {
  it('a bare-assignment payload does not execute when align loads the config it wrote', async () => {
    // THE SECURITY ASSERTION, and the one arm where a false green would matter most. This payload
    // survives the glob-dialect lint, so escaping is the only thing preventing execution.
    const dir = repoWithPackageDir(ASSIGNING_INJECTION);
    delete (globalThis as Record<string, unknown>)[RCE_MARKER];

    const initCode = await quiet(() => runInit(dir, { acceptExisting: false, nonInteractive: true }));
    const checkCode = await quiet(() => runCheck(dir, { json: false }));

    // PREMISE [S-05] first: the directory must actually have reached the config, or nothing below is
    // about anything. The bug hunt's own first attempt reproduced nothing for exactly this reason.
    const config = fs.readFileSync(path.join(dir, 'align.config.ts'), 'utf8');
    expect(config).toContain(JSON.stringify(`${ASSIGNING_INJECTION}/**`));

    // THE SECURITY ASSERTION, and it is deliberately BEFORE the exit codes. Ordered the other way
    // round, an unfixed align fails on the exit code first and the suite never reaches this line —
    // so the property that matters would go unmeasured while the test still went red. It did exactly
    // that on the first draft.
    expect((globalThis as Record<string, unknown>)[RCE_MARKER]).toBeUndefined();

    // ...and the commands still work, which is what makes the escaping a fix rather than a refusal.
    expect(initCode).toBe(0);
    expect(checkCode).toBe(0);
  });

  it('the throwing payload never reaches the config at all — and no output carries its marker', async () => {
    // The original reproduction, and its outcome CHANGED once LEDGER D045 landed. This payload's
    // parentheses are an extglob group align's dialect cannot express and has no escape syntax for,
    // so `align init` now drops the directory outright rather than writing a selector that could
    // never match: the config contains `core` and nothing else, and the second component is
    // reported as skipped instead of written and then rejected at load. That is a strictly better
    // outcome than the escaped-but-unloadable config this test used to assert, so the assertion
    // moved with it rather than being relaxed — `toContain` became `not.toContain`.
    const dir = repoWithPackageDir(THROWING_INJECTION);
    // Capture instead of `quiet()`, and the difference is not stylistic. `quiet()` calls
    // `vi.spyOn(console, 'log').mockImplementation(() => undefined)`, and vitest returns the
    // ALREADY-INSTALLED spy for a method that is mocked — so a capturing spy set up before it is
    // silently replaced, `said` stays empty, and every `said.filter(...)` assertion passes over
    // nothing. That is what the earlier version of this test did [S-05]; found 2026-08-19 when
    // D045 changed the outcome and the new "the drop is announced" assertion failed against
    // output that had actually been printed.
    const said = captureConsole();

    await withSilentStdout(() => runInit(dir, { acceptExisting: false, nonInteractive: true }));
    await withSilentStdout(() => runCheck(dir, { json: false }));

    const config = fs.readFileSync(path.join(dir, 'align.config.ts'), 'utf8');
    // Not merely escaped — absent. No fragment of the payload survives into the file.
    expect(config).not.toContain('INJECTED-CODE-EXECUTED');
    expect(config).toContain('"core": "core/**"');
    // ...and the drop is announced, because an unreported omission is its own defect [D045].
    expect(said.some((m) => m.includes('glob dialect cannot'))).toBe(true);
    // The throw never happened: the marker appears only where align quotes the directory back at
    // the user, never as an error align raised because it evaluated the payload.
    expect(said.filter((m) => m.includes('align check: INJECTED-CODE-EXECUTED'))).toEqual([]);
    expect(said.filter((m) => m.includes('align init: INJECTED-CODE-EXECUTED'))).toEqual([]);
  });

  it('the ordinary apostrophe case leaves a working repository, not a stuck one', async () => {
    const dir = repoWithPackageDir("don't");

    expect(await quiet(() => runInit(dir, { acceptExisting: false, nonInteractive: true }))).toBe(0);
    // The whole point of the fix, stated as the user experiences it: the next command works.
    expect(await quiet(() => runCheck(dir, { json: false }))).toBe(0);
  });

  it('still writes a normal config for ordinary directory names', async () => {
    // Calibration [S-04]: a fix that escaped by MANGLING the pattern would satisfy everything above
    // while quietly changing which files each component matches.
    const dir = repoWithPackageDir('web');

    expect(await quiet(() => runInit(dir, { acceptExisting: false, nonInteractive: true }))).toBe(0);

    const config = fs.readFileSync(path.join(dir, 'align.config.ts'), 'utf8');
    expect(config).toContain('web/**');
    expect(config).toContain('core/**');
    expect(await quiet(() => runCheck(dir, { json: false }))).toBe(0);
  });
});
