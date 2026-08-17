import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toComponentName } from '@spikedpunch/align-core';
import type { ComponentDefinitionIR, DependencyGraph, ScanBlindSpot, ScanBlindSpotReason } from '@spikedpunch/align-core';
import { TypeScriptScanner } from '../src/scanner.js';

/**
 * ADR 028 Stage 1: every exit in `walkSourceFiles` that drops a path records a `ScanBlindSpot` with
 * its reason. The stakes are not cosmetic — a path absent from the graph with no record is read by
 * `store.prune` as "fixed" (the entry is deleted at exit 0) and by `applyMoves` as "renamed" (a
 * real human's `acceptedAt`/`acceptedBy` is forged onto a violation nobody reviewed, on every plain
 * `align check`). Two of the six reasons below were reproduced against the built binary before this
 * fix existed.
 */

function allComponent(): Record<string, ComponentDefinitionIR> {
  return { [toComponentName('all')]: { name: 'all', selector: { kind: 'glob', patterns: ['**'] }, empty: 'allow' } };
}

function spotsOf(graph: DependencyGraph, kind: ScanBlindSpotReason['kind']): readonly ScanBlindSpot[] {
  return graph.blindSpots.filter((s) => s.reason.kind === kind);
}

describe('walkSourceFiles records every path it declined to look at (ADR 028)', () => {
  let dir: string;
  const scan = (overrides: { excludes?: string[] } = {}): Promise<DependencyGraph> =>
    new TypeScriptScanner().scan({
      rootDir: dir,
      components: allComponent(),
      excludes: overrides.excludes ?? [],
    });

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-blind-spots-')));
    fs.writeFileSync(path.join(dir, 'root.ts'), 'export const root = 1;\n');
  });

  afterEach(() => {
    // Restore any 0o000 directory first — `rmSync` cannot descend into one either.
    const locked = path.join(dir, 'locked');
    if (fs.existsSync(locked)) fs.chmodSync(locked, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a symlinked FILE is recorded as not-regular-file, never silently dropped', async () => {
    fs.writeFileSync(path.join(dir, 'target.ts'), 'export const t = 1;\n');
    fs.symlinkSync(path.join(dir, 'target.ts'), path.join(dir, 'link.ts'));

    const graph = await scan();

    // The pre-ADR-028 behaviour: `Dirent.isDirectory()` and `isFile()` are BOTH false for a symlink,
    // so it matched neither branch and fell off the end of the loop with no record at all.
    expect(graph.nodes.map((n) => n.file)).not.toContain('link.ts');
    expect(spotsOf(graph, 'not-regular-file').map((s) => s.path)).toEqual(['link.ts']);
  });

  it('a symlinked DIRECTORY costs exactly ONE record, not one per file in the vanished subtree', async () => {
    const real = path.join(dir, 'real-tree');
    fs.mkdirSync(real);
    for (const name of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(real, name), 'export const x = 1;\n');
    fs.symlinkSync(real, path.join(dir, 'vendored'));

    const graph = await scan();

    expect(graph.nodes.map((n) => n.file)).toEqual(['real-tree/a.ts', 'real-tree/b.ts', 'real-tree/c.ts', 'root.ts']);
    // The whole subtree is absent from the graph under its symlinked name; ONE record stands for it,
    // and at-or-under matching (`core/src/baseline/scan-blind-spots.ts`) is what makes one enough.
    expect(spotsOf(graph, 'not-regular-file').map((s) => s.path)).toEqual(['vendored']);
  });

  it('a BROKEN symlink is recorded too — the walk cannot tell it apart from a live one without following', async () => {
    fs.symlinkSync(path.join(dir, 'does-not-exist.ts'), path.join(dir, 'broken.ts'));

    const graph = await scan();

    expect(spotsOf(graph, 'not-regular-file').map((s) => s.path)).toEqual(['broken.ts']);
  });

  it('an UNREADABLE directory is recorded with its error — the exit that was silent even after unverified-prune', async () => {
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'hidden.ts'), 'export const h = 1;\n');
    fs.chmodSync(locked, 0o000);

    const graph = await scan();

    const unreadable = spotsOf(graph, 'unreadable');
    expect(unreadable.map((s) => s.path)).toEqual(['locked']);
    // The message is carried, not swallowed: it is what tells a human this was permissions rather
    // than a directory racing deletion mid-walk.
    expect(unreadable[0]?.reason).toMatchObject({ kind: 'unreadable' });
    expect((unreadable[0]?.reason as { error: string }).error).toMatch(/EACCES|EPERM/);
  });

  it('an excludes-matched FILE is recorded, naming the pattern responsible', async () => {
    fs.writeFileSync(path.join(dir, 'generated.ts'), 'export const g = 1;\n');

    const graph = await scan({ excludes: ['generated.ts'] });

    expect(graph.nodes.map((n) => n.file)).not.toContain('generated.ts');
    expect(spotsOf(graph, 'excluded')).toEqual([
      { path: 'generated.ts', reason: { kind: 'excluded', pattern: 'generated.ts' } },
    ]);
  });

  it('an excludes-matched DIRECTORY is recorded once, naming the pattern, and never descended into', async () => {
    const gen = path.join(dir, 'generated');
    fs.mkdirSync(gen);
    for (const name of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(gen, name), 'export const x = 1;\n');

    const graph = await scan({ excludes: ['generated/**'] });

    expect(graph.nodes.map((n) => n.file)).toEqual(['root.ts']);
    expect(spotsOf(graph, 'excluded')).toEqual([
      { path: 'generated', reason: { kind: 'excluded', pattern: 'generated/**' } },
    ]);
  });

  // Found by the ADR 028 Stage 1 review, reproduced before fixing: `endsWith('/**')` was tested on
  // the RAW pattern, so a `/**` living inside a brace group never triggered the directory stop and
  // the walk recorded one blind spot per file — 10 against 2 for the equivalent un-braced form, on
  // this exact fixture. Correctness was never affected (`files` matched); the volume bound was.
  it('a brace-embedded subtree exclude (`src/{a/**,b/**}`) is bounded exactly like its un-braced equivalent', async () => {
    for (const sub of ['a', 'b']) {
      fs.mkdirSync(path.join(dir, 'src', sub), { recursive: true });
      for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(dir, 'src', sub, `f${i}.ts`), 'export const x = 1;\n');
    }

    const braced = await scan({ excludes: ['src/{a/**,b/**}'] });
    const expanded = await scan({ excludes: ['src/a/**', 'src/b/**'] });

    expect(braced.nodes.map((n) => n.file)).toEqual(['root.ts']);
    expect(braced.nodes.map((n) => n.file)).toEqual(expanded.nodes.map((n) => n.file));
    expect(spotsOf(braced, 'excluded').map((s) => s.path)).toEqual(['src/a', 'src/b']);
    expect(spotsOf(braced, 'excluded')).toHaveLength(spotsOf(expanded, 'excluded').length);
  });

  // The `<prefix>/**` short-circuit narrows what the walk WALKS, never what it includes. A pattern
  // that is NOT a whole-subtree exclusion must still be applied per file, or the short-circuit would
  // be silently over-excluding — the exact false-green direction this repo cares most about.
  it('a partial-subtree exclude (`generated/*.ts`) still filters per file and leaves siblings scanned', async () => {
    const gen = path.join(dir, 'generated');
    fs.mkdirSync(path.join(gen, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(gen, 'top.ts'), 'export const t = 1;\n');
    fs.writeFileSync(path.join(gen, 'nested', 'deep.ts'), 'export const d = 1;\n');

    const graph = await scan({ excludes: ['generated/*.ts'] });

    expect(graph.nodes.map((n) => n.file)).toEqual(['generated/nested/deep.ts', 'root.ts']);
    expect(spotsOf(graph, 'excluded')).toEqual([
      { path: 'generated/top.ts', reason: { kind: 'excluded', pattern: 'generated/*.ts' } },
    ]);
  });

  it('a DEFAULT_EXCLUDED_DIR_NAMES hit is recorded once, naming the directory name', async () => {
    const nm = path.join(dir, 'node_modules', 'some-pkg');
    fs.mkdirSync(nm, { recursive: true });
    for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(nm, `f${i}.ts`), 'export const x = 1;\n');

    const graph = await scan();

    expect(graph.nodes.map((n) => n.file)).toEqual(['root.ts']);
    // THE VOLUME BOUND, pinned: 21 unscanned paths beneath it, ONE record. The walk never descends,
    // and at-or-under matching covers the rest — without this bound the record would be worse than
    // useless on a real repo.
    expect(spotsOf(graph, 'default-excluded-dir')).toEqual([
      { path: 'node_modules', reason: { kind: 'default-excluded-dir', name: 'node_modules' } },
    ]);
  });

  // The ordering fix. `readdirSync(…, {withFileTypes: true})` does not follow symlinks, so a
  // SYMLINKED `node_modules` answers false to both `isDirectory()` and `isFile()`. Testing the
  // always-excluded NAME before the type branch keeps it filed under the reason a human expects,
  // instead of burying it among the symlink records that actually need attention. Measured on this
  // repo: `node_modules` directories are real here, so this is not the universal case an earlier
  // draft claimed — but it occurs in generated and container layouts, and the fix is free.
  it('a SYMLINKED node_modules classifies as default-excluded-dir, not not-regular-file', async () => {
    const real = path.join(dir, 'real-modules');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'pkg.ts'), 'export const p = 1;\n');
    fs.symlinkSync(real, path.join(dir, 'node_modules'));

    const graph = await scan();

    expect(spotsOf(graph, 'default-excluded-dir').map((s) => s.path)).toEqual(['node_modules']);
    expect(spotsOf(graph, 'not-regular-file')).toEqual([]);
  });

  it('a nested checkout is recorded under its own reason (ADR 027, now one variant among six)', async () => {
    const checkout = path.join(dir, 'vendor', 'some-lib');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'index.ts'), 'export const l = 1;\n');

    const graph = await scan();

    expect(spotsOf(graph, 'nested-checkout')).toEqual([
      { path: 'vendor/some-lib', reason: { kind: 'nested-checkout' } },
    ]);
  });

  it('a non-source extension is deliberately NOT recorded — the one silent exit, per ADR 028 §1', async () => {
    fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
    fs.writeFileSync(path.join(dir, 'data.json'), '{}\n');

    const graph = await scan();

    // Enumerating every non-source file in a repository is expensive and noisy; ADR 028's second
    // mechanism (the injected existence probe, Stage 2) covers the case that matters without it.
    expect(graph.blindSpots.map((s) => s.path)).not.toContain('README.md');
    expect(graph.blindSpots.map((s) => s.path)).not.toContain('data.json');
  });

  it('records nothing on a clean tree with no excludes — no blind spot is invented', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');

    const graph = await scan();

    expect(graph.blindSpots).toEqual([]);
    expect(graph.nodes.map((n) => n.file)).toEqual(['root.ts', 'src/a.ts']);
  });

  it('blind spots are sorted by path, so the record is deterministic across scans', async () => {
    for (const name of ['zzz', 'aaa', 'mmm']) {
      fs.mkdirSync(path.join(dir, name, '.git'), { recursive: true });
    }

    const graph = await scan();

    expect(graph.blindSpots.map((s) => s.path)).toEqual(['aaa', 'mmm', 'zzz']);
  });
});

// Keyed by the reason union so adding a variant to `ScanBlindSpotReason` without giving it a
// producing fixture fails HERE, at the walk, rather than shipping a reason nothing can emit. The
// retention half of the same exhaustiveness lives in `core/test/baseline.test.ts`; together they
// are ADR 028's answer to "the previous enumeration missed three mechanisms."
describe('every ScanBlindSpotReason variant is actually reachable from the walk', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-blind-spot-coverage-')));
    fs.writeFileSync(path.join(dir, 'root.ts'), 'export const root = 1;\n');
    // nested-checkout
    fs.mkdirSync(path.join(dir, 'vendor', '.git'), { recursive: true });
    // excluded (passed as a pattern below)
    fs.mkdirSync(path.join(dir, 'generated'));
    fs.writeFileSync(path.join(dir, 'generated', 'g.ts'), 'export const g = 1;\n');
    // default-excluded-dir
    fs.mkdirSync(path.join(dir, 'dist'));
    // unreadable
    fs.mkdirSync(path.join(dir, 'locked'));
    fs.chmodSync(path.join(dir, 'locked'), 0o000);
    // not-regular-file
    fs.symlinkSync(path.join(dir, 'root.ts'), path.join(dir, 'link.ts'));
  });

  afterEach(() => {
    fs.chmodSync(path.join(dir, 'locked'), 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits at least one blind spot of every reason kind in a single walk', async () => {
    const graph = await new TypeScriptScanner().scan({
      rootDir: dir,
      components: allComponent(),
      excludes: ['generated/**'],
    });

    const kinds: Readonly<Record<ScanBlindSpotReason['kind'], true>> = {
      'nested-checkout': true,
      excluded: true,
      'default-excluded-dir': true,
      unreadable: true,
      'not-regular-file': true,
    };
    const seen = new Set(graph.blindSpots.map((s) => s.reason.kind));
    expect([...Object.keys(kinds)].filter((k) => !seen.has(k as ScanBlindSpotReason['kind']))).toEqual([]);
  });
});
