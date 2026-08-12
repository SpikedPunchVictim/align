import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toComponentName } from '@spikedpunch/align-core';
import type { ComponentDefinitionIR } from '@spikedpunch/align-core';
import { TypeScriptScanner } from '../src/scanner.js';

// Task #25: a nested git checkout (a `git worktree`, a submodule, a vendored clone — anything
// carrying its own `.git`, directory or file) is auto-excluded from the scan and reported, never
// silently dropped. `align.config.ts`'s own `.claude` exclude (`docs/handoff.md`) is the exact
// workaround this feature replaces — excludes are prefix-anchored, so no exclude pattern catches
// an arbitrary nested checkout a user creates later.

function allComponent(): Record<string, ComponentDefinitionIR> {
  return { [toComponentName('all')]: { name: 'all', selector: { kind: 'glob', patterns: ['**'] }, empty: 'fail' } };
}

describe('TypeScriptScanner — nested git checkouts are auto-excluded (task #25)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-scanner-nested-checkout-test-'));
    // The scan root itself always has a `.git` — real repos always do, and every existing fixture
    // in this suite scans a directory without one only because it's a subdirectory of the real
    // align repo. Give the root one explicitly here so "the root is never skipped" is a real
    // assertion, not an accident of the fixture not having a `.git` at all.
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'root.ts'), 'export const root = 1;\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips a nested checkout whose `.git` is a directory (a submodule or plain clone)', async () => {
    const checkoutDir = path.join(dir, 'vendor', 'some-lib');
    fs.mkdirSync(path.join(checkoutDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkoutDir, 'index.ts'), 'export const lib = 1;\n');

    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: dir, components: allComponent(), excludes: [] });

    expect(graph.nodes.map((n) => n.file)).toContain('root.ts');
    expect(graph.nodes.map((n) => n.file)).not.toContain('vendor/some-lib/index.ts');
    expect(graph.skippedNestedCheckouts).toContain('vendor/some-lib');
  });

  it('skips a nested checkout whose `.git` is a FILE (a linked `git worktree`)', async () => {
    const checkoutDir = path.join(dir, '.claude', 'worktrees', 'wt-25');
    fs.mkdirSync(checkoutDir, { recursive: true });
    // A linked worktree's `.git` is a file pointing at the real repo's `.git/worktrees/<name>`
    // entry, not a directory — this is the exact shape `hasOwnGit` must also catch.
    fs.writeFileSync(path.join(checkoutDir, '.git'), 'gitdir: /some/real/repo/.git/worktrees/wt-25\n');
    fs.writeFileSync(path.join(checkoutDir, 'fixture.ts'), 'export const fixture = 1;\n');

    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: dir, components: allComponent(), excludes: [] });

    expect(graph.nodes.map((n) => n.file)).toContain('root.ts');
    expect(graph.nodes.map((n) => n.file)).not.toContain('.claude/worktrees/wt-25/fixture.ts');
    expect(graph.skippedNestedCheckouts).toContain('.claude/worktrees/wt-25');
  });

  it('never skips the scan root itself, even though it has its own `.git`', async () => {
    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: dir, components: allComponent(), excludes: [] });

    expect(graph.nodes.map((n) => n.file)).toContain('root.ts');
    expect(graph.skippedNestedCheckouts).toHaveLength(0);
  });

  it('reports every skipped checkout, sorted, in `skippedNestedCheckouts` — never silent', async () => {
    fs.mkdirSync(path.join(dir, 'b-checkout', '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'b-checkout', 'x.ts'), 'export const x = 1;\n');
    fs.mkdirSync(path.join(dir, 'a-checkout', '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a-checkout', 'y.ts'), 'export const y = 1;\n');

    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({ rootDir: dir, components: allComponent(), excludes: [] });

    expect(graph.skippedNestedCheckouts).toEqual(['a-checkout', 'b-checkout']);
  });

  it('the opt-out (`includeNestedCheckouts`) re-includes a checkout a human declared genuinely part of the project', async () => {
    const checkoutDir = path.join(dir, 'vendor', 'submodule');
    fs.mkdirSync(path.join(checkoutDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkoutDir, 'index.ts'), 'export const lib = 1;\n');

    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({
      rootDir: dir,
      components: allComponent(),
      excludes: [],
      includeNestedCheckouts: ['vendor/submodule'],
    });

    expect(graph.nodes.map((n) => n.file)).toContain('vendor/submodule/index.ts');
    expect(graph.skippedNestedCheckouts).toHaveLength(0);
  });

  it('an opted-in checkout still respects ordinary `excludes` inside it (opt-out is not a bypass of every other rule)', async () => {
    const checkoutDir = path.join(dir, 'vendor', 'submodule');
    fs.mkdirSync(path.join(checkoutDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(checkoutDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkoutDir, 'src.ts'), 'export const src = 1;\n');
    fs.writeFileSync(path.join(checkoutDir, 'dist', 'bundle.ts'), 'export const bundle = 1;\n');

    const scanner = new TypeScriptScanner();
    const graph = await scanner.scan({
      rootDir: dir,
      components: allComponent(),
      excludes: ['vendor/submodule/dist'],
      includeNestedCheckouts: ['vendor/submodule'],
    });

    expect(graph.nodes.map((n) => n.file)).toContain('vendor/submodule/src.ts');
    expect(graph.nodes.map((n) => n.file)).not.toContain('vendor/submodule/dist/bundle.ts');
  });
});
