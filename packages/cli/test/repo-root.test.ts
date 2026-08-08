import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoNotFoundMessage, requireRepoRoot, resolveRepoRoot } from '../src/repo-root.js';

// Bug hunt 2026-08-03, Needs-Review #2: every CLI command used to pass `process.cwd()` straight
// through with no repo-root detection anywhere, so `align check` (etc.) run from a subdirectory
// silently scanned/wrote only that subdirectory. Decision: commands are repo-scoped — resolve the
// nearest ancestor with `align.config.ts` or `.align/` instead of trusting cwd blindly.

let tmpDir: string;

function makeTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-repo-root-test-'));
  tmpDir = dir;
  return dir;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveRepoRoot', () => {
  it('resolves the root itself when align.config.ts lives there', () => {
    const root = makeTmpRepo();
    fs.writeFileSync(path.join(root, 'align.config.ts'), 'export default {};\n');
    expect(resolveRepoRoot(root)).toBe(root);
  });

  it('walks up from a nested subdirectory to find align.config.ts', () => {
    const root = makeTmpRepo();
    fs.writeFileSync(path.join(root, 'align.config.ts'), 'export default {};\n');
    const nested = path.join(root, 'packages', 'core', 'src');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveRepoRoot(nested)).toBe(root);
  });

  it('resolves via a `.align/` directory alone — no align.config.ts required (ADR 014 --untrusted checkouts)', () => {
    const root = makeTmpRepo();
    fs.mkdirSync(path.join(root, '.align'));
    const nested = path.join(root, 'packages', 'core');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveRepoRoot(nested)).toBe(root);
  });

  it('takes the nearest marker, not the outermost one (a nested align.config.ts wins over an ancestor .align/)', () => {
    const outer = makeTmpRepo();
    fs.mkdirSync(path.join(outer, '.align'));
    const inner = path.join(outer, 'sub-repo');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'align.config.ts'), 'export default {};\n');
    const nested = path.join(inner, 'src');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveRepoRoot(nested)).toBe(inner);
  });

  it('returns undefined when neither marker exists anywhere above the start directory', () => {
    const root = makeTmpRepo();
    const nested = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveRepoRoot(nested)).toBeUndefined();
  });
});

// A polyglot monorepo whose git root holds several subprojects with align set up in exactly one of
// them (found live: sibling `typescript/`, `python/`, `website/` directories, align only in
// `typescript/`). The old message told the user to `align init` at the git root, which would create
// a second, competing setup above the real one.
describe('repoNotFoundMessage — nested-subproject pointer', () => {
  function mkdirs(...dirs: string[]): void {
    for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  }

  it('points at a depth-1 child holding align.config.ts, and does NOT suggest `align init`', () => {
    const root = makeTmpRepo();
    mkdirs(path.join(root, 'typescript'), path.join(root, 'python'), path.join(root, 'website'));
    fs.writeFileSync(path.join(root, 'typescript', 'align.config.ts'), 'export default {};\n');

    const message = repoNotFoundMessage(root);
    expect(message).toContain('typescript/');
    expect(message).not.toContain('align init');
  });

  it('points at a depth-1 child holding only `.align/` (ADR 014 config-free checkouts)', () => {
    const root = makeTmpRepo();
    mkdirs(path.join(root, 'services', '.align'));

    const message = repoNotFoundMessage(root);
    expect(message).toContain('services/');
    expect(message).not.toContain('align init');
  });

  it('points at a depth-2 grandchild', () => {
    const root = makeTmpRepo();
    mkdirs(path.join(root, 'projects', 'api'));
    fs.writeFileSync(path.join(root, 'projects', 'api', 'align.config.ts'), 'export default {};\n');

    const message = repoNotFoundMessage(root);
    expect(message).toContain('projects/api/');
    expect(message).not.toContain('align init');
  });

  it('does not look deeper than two levels below the start directory', () => {
    const root = makeTmpRepo();
    const deep = path.join(root, 'a', 'b', 'c');
    mkdirs(deep);
    fs.writeFileSync(path.join(deep, 'align.config.ts'), 'export default {};\n');

    const message = repoNotFoundMessage(root);
    expect(message).not.toContain('a/b/c');
    expect(message).toContain('align init');
  });

  it('keeps the original `align init` message verbatim when nothing is set up anywhere below', () => {
    const root = makeTmpRepo();
    mkdirs(path.join(root, 'a', 'b'), path.join(root, 'src'));

    expect(repoNotFoundMessage(root)).toBe(
      `no align.config.ts or .align/ directory found in ${root} or any parent directory. ` +
        'Run `align init` to set align up here, or run this command from inside an initialized repo.',
    );
  });

  it('names several setups up to the cap and indicates how many more there are', () => {
    const root = makeTmpRepo();
    for (const name of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      mkdirs(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'align.config.ts'), 'export default {};\n');
    }

    const message = repoNotFoundMessage(root);
    const named = ['p1/', 'p2/', 'p3/', 'p4/', 'p5/'].filter((n) => message.includes(n));
    expect(named).toHaveLength(3);
    expect(message).toContain('and 2 more');
    expect(message).not.toContain('align init');
  });

  it('does not descend into node_modules (a vendored copy of align is not the user\'s project)', () => {
    const root = makeTmpRepo();
    const vendored = path.join(root, 'node_modules', 'some-pkg');
    mkdirs(vendored);
    fs.writeFileSync(path.join(vendored, 'align.config.ts'), 'export default {};\n');

    const message = repoNotFoundMessage(root);
    expect(message).not.toContain('node_modules');
    expect(message).toContain('align init');
  });

  it('does not descend into .git, dist or build either', () => {
    const root = makeTmpRepo();
    for (const skipped of ['.git', 'dist', 'build']) {
      mkdirs(path.join(root, skipped));
      fs.writeFileSync(path.join(root, skipped, 'align.config.ts'), 'export default {};\n');
    }

    expect(repoNotFoundMessage(root)).toContain('align init');
  });
});

describe('requireRepoRoot', () => {
  function withCapturedStderr<T>(run: () => T): { result: T; errors: string[] } {
    const errors: string[] = [];
    const original = console.error;
    // eslint-disable-next-line no-console
    console.error = ((...args: unknown[]) => errors.push(args.map(String).join(' '))) as typeof console.error;
    try {
      return { result: run(), errors };
    } finally {
      console.error = original;
    }
  }

  it('returns { root } silently (no stderr notice) when cwd IS the resolved root', () => {
    const root = makeTmpRepo();
    fs.writeFileSync(path.join(root, 'align.config.ts'), 'export default {};\n');
    const { result, errors } = withCapturedStderr(() => requireRepoRoot('align check', root));
    expect(result).toEqual({ root });
    expect(errors).toEqual([]);
  });

  it('returns { root } and prints a one-line stderr notice when cwd is a subdirectory of the resolved root', () => {
    const root = makeTmpRepo();
    fs.writeFileSync(path.join(root, 'align.config.ts'), 'export default {};\n');
    const nested = path.join(root, 'packages', 'core');
    fs.mkdirSync(nested, { recursive: true });
    const { result, errors } = withCapturedStderr(() => requireRepoRoot('align check', nested));
    expect(result).toEqual({ root });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(root);
    expect(errors[0]).toContain(nested);
  });

  it('returns { exitCode: 1 } and prints an actionable error (naming the search dir, suggesting `align init`) when no marker is found', () => {
    const root = makeTmpRepo();
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    const { result, errors } = withCapturedStderr(() => requireRepoRoot('align check', nested));
    expect(result).toEqual({ exitCode: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(nested);
    expect(errors[0]).toContain('align init');
    expect(errors[0]).toContain('align check');
  });
});
