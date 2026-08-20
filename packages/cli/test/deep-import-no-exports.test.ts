import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { packageDeclaresExportsMap } from '../src/deep-import-surface.js';
import { runDoctor } from '../src/commands/doctor.js';

/**
 * LEDGER **D055**, the second half — a package with no `exports` map has no surface to reach past.
 *
 * Reported alongside the asset case: `reactflow/dist/style.css` was flagged as reaching past
 * reactflow's public surface. Measured on the reporter's fixture — `reactflow`'s manifest has
 * **no `exports` field at all** (`main: dist/index.js` only). Under Node resolution that makes every
 * subpath in the package public: `reactflow/dist/style.css` is its documented stylesheet path, and
 * there is no encapsulation boundary for the import to violate. The advisory was not merely noisy;
 * its claim was false by construction.
 *
 * **This is deliberately NOT ADR 020's Arm-B.** That arm — full `exports`-map subpath resolution, to
 * decide whether a specific subpath is exported — was measured and rejected as not worth its cost,
 * and that decision stands. This asks one bit: *does the package declare a surface at all?* One
 * manifest read per distinct target package, no subpath resolution, and it removes an entire class
 * of false claim rather than refining a true one. Recorded as an amendment with the measurement
 * rather than a quiet reversal.
 *
 * Lives in the CLI because it reads a `package.json`, and core does no filesystem I/O — an invariant
 * this repository enforces executably ("core imports node:fs nowhere").
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let tmpDir: string;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function repoWithDep(pkg: string, manifest: Record<string, unknown>, { nested = false } = {}): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-deep-surface-')));
  const base = nested ? path.join(dir, 'packages', 'app') : dir;
  const pkgDir = path.join(base, 'node_modules', ...pkg.split('/'));
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(manifest), 'utf8');
  return nested ? base : dir;
}

describe('a package with no exports map declares no surface [D055]', () => {
  it('is false for a package with only main', () => {
    const dir = repoWithDep('reactflow', { name: 'reactflow', main: 'dist/index.js' });

    expect(packageDeclaresExportsMap(dir, 'reactflow')).toBe(false);
  });

  it('is true for a package that declares exports', () => {
    // The case the advisory is FOR: a declared surface exists, so reaching past it is meaningful.
    const dir = repoWithDep('modern', { name: 'modern', exports: { '.': './dist/index.js' } });

    expect(packageDeclaresExportsMap(dir, 'modern')).toBe(true);
  });

  it('handles a scoped package name', () => {
    const dir = repoWithDep('@scope/thing', { name: '@scope/thing', exports: { '.': './index.js' } });

    expect(packageDeclaresExportsMap(dir, '@scope/thing')).toBe(true);
  });

  it('finds a hoisted dependency from a nested package directory', () => {
    // pnpm/npm workspaces hoist to the root, so the importing package's own node_modules often does
    // not hold the dependency. Walking up is what makes this work in the layout it will actually meet.
    const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-deep-surface-')));
    const hoisted = path.join(dir, 'node_modules', 'reactflow');
    fs.mkdirSync(hoisted, { recursive: true });
    fs.writeFileSync(path.join(hoisted, 'package.json'), JSON.stringify({ name: 'reactflow', main: 'x.js' }), 'utf8');
    const nested = path.join(dir, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });

    expect(packageDeclaresExportsMap(nested, 'reactflow')).toBe(false);
  });

  it('reports TRUE when the package cannot be found, so an unlocatable dep keeps reporting [S-04]', () => {
    // The direction matters and is the opposite of what "not found" suggests. This predicate GATES a
    // false-positive filter: answering `false` for a package we could not read would silently
    // suppress every deep-import advisory in a repo with no node_modules installed — turning an
    // FP fix into an FN. Unknown must preserve today's behaviour, which is to report.
    const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-deep-surface-')));

    expect(packageDeclaresExportsMap(dir, 'never-installed')).toBe(true);
  });

  it('reports TRUE for an unreadable or malformed manifest [S-04]', () => {
    const dir = repoWithDep('broken', {});
    fs.writeFileSync(path.join(dir, 'node_modules', 'broken', 'package.json'), '{ not json', 'utf8');

    expect(packageDeclaresExportsMap(dir, 'broken')).toBe(true);
  });
});

/**
 * The wiring, pinned separately from the predicate.
 *
 * The predicate above can be perfectly correct while `doctor` never calls it — which is the exact
 * shape D051 recorded ("the seam existed and was wired to nothing"). Asserted through `runDoctor`
 * on a real installed dependency, both directions.
 */
describe('doctor consults the surface check [D055]', () => {
  function repoImporting(manifest: Record<string, unknown>): string {
    const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-surface-')));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'legacy', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', '@spikedpunch'), { recursive: true });
    fs.symlinkSync(path.join(repoRoot, 'packages', 'core'), path.join(dir, 'node_modules', '@spikedpunch', 'align-core'), 'dir');
    fs.writeFileSync(path.join(dir, 'src/index.ts'), "import { x } from 'legacy/dist/internal';\nexport const y = x;\n", 'utf8');
    fs.writeFileSync(path.join(dir, 'node_modules/legacy/dist/internal.js'), 'export const x = 1;\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'node_modules/legacy/package.json'), JSON.stringify(manifest), 'utf8');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }), 'utf8');
    fs.writeFileSync(
      path.join(dir, 'align.config.ts'),
      "import { defineProject } from '@spikedpunch/align-core/dsl';\nexport default defineProject({ components: { app: 'src/**' } });\n",
      'utf8',
    );
    return dir;
  }

  async function deepImportAdvisoryCount(dir: string): Promise<number> {
    const logs: string[] = [];
    const original = console.log;
    // eslint-disable-next-line no-console
    console.log = ((...a: unknown[]) => logs.push(a.map(String).join(' '))) as typeof console.log;
    try {
      await runDoctor(dir);
    } finally {
      console.log = original;
    }
    return logs.join('\n').split('deep-import').length - 1;
  }

  it('does not report a deep import into a package with no exports map', async () => {
    const dir = repoImporting({ name: 'legacy', version: '1.0.0', main: 'dist/index.js' });

    expect(await deepImportAdvisoryCount(dir)).toBe(0);
  });

  it('still reports one into a package that declares exports [S-04]', async () => {
    // Calibration, and the half that would silently disappear if the filter were too broad — this
    // is the case the advisory exists for.
    const dir = repoImporting({ name: 'legacy', version: '1.0.0', main: 'dist/index.js', exports: { '.': './dist/index.js' } });

    expect(await deepImportAdvisoryCount(dir)).toBeGreaterThan(0);
  });
});
