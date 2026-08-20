import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeScriptPlugin } from '../src/plugin.js';
import { toComponentName } from '@spikedpunch/align-core';
import type { ComponentDefinitionIR } from '@spikedpunch/align-core';

/**
 * LEDGER **D052** — a cross-package edge must not vanish because the package it points at is BUILT.
 *
 * Reported from a real monorepo on 2026-08-20, with the cleanest evidence this project has received:
 * 40 component allowlists emptied to `canOnlyDependOn()` produced only 9 violations from 2
 * components. Hiding `libs/core/dist` made 62 edges to core appear; restoring it dropped them to 0.
 * The two components that worked were exactly the two packages with no `node_modules` installed.
 *
 * The chain, verified in align's source:
 *   1. `ts.resolveModuleName` succeeds — the package is built, so `main: dist/index.js` has a
 *      sibling `dist/index.d.ts` that exists.
 *   2. `tsconfig-resolver.ts`'s workspace fallback is gated on `resolved === undefined`, so it never
 *      runs. Its own comment names the sibling case: "whose declared entry is a NOT-YET-BUILT
 *      `dist/`". Unbuilt handled, built missed [S-09].
 *   3. Realpath lands inside the repo and outside `node_modules`, so the target is correctly
 *      classified INTERNAL — at `libs/core/dist/index.d.ts`.
 *   4. `scanner.ts`'s non-source guard does not fire: `path.extname('index.d.ts')` is `.ts`, which
 *      IS a source extension. (The comment there claims it filters `.d.ts`. It does not.)
 *   5. The `build-output-excluded` uncertainty — a reason that exists for exactly this — does not
 *      fire either, because it tests the USER's `excludes`, never `DEFAULT_EXCLUDED_DIR_NAMES`,
 *      which is where `dist` lives.
 *   6. The walk skipped `dist/`, so the target is not a graph node, and `evaluators.ts` skips any
 *      edge whose endpoints are not both nodes: `if (fromNode === undefined || toNode === undefined) continue`.
 *
 * Green, exit 0, no advisory. ARCHITECTURE.md's severity-zero false-green invariant, in the one
 * repository shape align exists to serve.
 *
 * **This fixture is built in a tmpdir rather than committed, and that is part of the finding.** The
 * repo's own `.gitignore` ignores `dist/` and `node_modules/` globally, so a fixture reproducing the
 * real shape CANNOT be checked in — which is why, measured on 2026-08-20, zero fixtures in this
 * repository contain either. The whole suite exercised the resolution-FAILS path; the
 * resolution-SUCCEEDS path had no coverage at all.
 */

let tmpDir: string;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A pnpm-shaped workspace whose `libs/core` is BUILT and INSTALLED: `main` points into `dist/`, the
 * built files exist, and `apps/web/node_modules/@fix/core` is a symlink to the package root, which
 * is how `ts.resolveModuleName` reaches it.
 *
 * `built: false` produces the same tree with no `dist/` — the shape every existing fixture has, and
 * the one that always worked.
 */
function workspace({ built }: { built: boolean }): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-built-ws-')));
  const w = (rel: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
  };

  w('pnpm-workspace.yaml', "packages:\n  - 'libs/*'\n  - 'apps/*'\n");
  w('package.json', JSON.stringify({ name: 'root', private: true }));
  w('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }));

  w('libs/core/package.json', JSON.stringify({ name: '@fix/core', version: '1.0.0', main: 'dist/index.js', types: 'dist/index.d.ts' }));
  w('libs/core/src/index.ts', 'export const core = 1;\n');
  if (built) {
    w('libs/core/dist/index.js', 'export const core = 1;\n');
    w('libs/core/dist/index.d.ts', 'export declare const core: number;\n');
  }

  w('apps/web/package.json', JSON.stringify({ name: '@fix/web', version: '1.0.0', dependencies: { '@fix/core': 'workspace:*' } }));
  w('apps/web/src/app.ts', "import { core } from '@fix/core';\nexport const used = core;\n");

  // The pnpm/npm-workspaces install shape: a symlink from the consumer's node_modules to the
  // package root. This is what makes `ts.resolveModuleName` succeed, and it is the single thing
  // that separates a repository where align works from one where it silently reports nothing.
  const scope = path.join(dir, 'apps/web/node_modules/@fix');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(path.join(dir, 'libs/core'), path.join(scope, 'core'), 'dir');

  return dir;
}

const COMPONENTS: Readonly<Record<string, ComponentDefinitionIR>> = {
  [toComponentName('web')]: { name: 'web', selector: { kind: 'glob', patterns: ['apps/web/**'] }, empty: 'fail' },
  [toComponentName('core')]: { name: 'core', selector: { kind: 'glob', patterns: ['libs/core/**'] }, empty: 'fail' },
};

async function scan(rootDir: string): Promise<Awaited<ReturnType<TypeScriptPlugin['scanner']['scan']>>> {
  return new TypeScriptPlugin().scanner.scan({ rootDir, components: COMPONENTS, excludes: [] });
}

describe('a built, installed workspace package is still reachable [D052]', () => {
  it('the edge into the sibling package exists and points at its SOURCE', async () => {
    const graph = await scan(workspace({ built: true }));

    const fromApp = graph.edges.filter((e) => e.from === 'apps/web/src/app.ts');
    // Before the fix: zero. The edge either pointed into `libs/core/dist/` (not a node, so every
    // rule skipped it) or never materialized.
    expect(fromApp).toHaveLength(1);
    expect(fromApp[0]?.to).toBe('libs/core/src/index.ts');

    // And the target must be a real node, or `evaluators.ts` drops the edge regardless of its `to`.
    expect(graph.nodes.map((n) => n.file)).toContain('libs/core/src/index.ts');
  });

  it('the UNBUILT shape still resolves, exactly as it always did [S-04]', async () => {
    // Calibration, and the arm that already worked: with no `dist/`, `ts.resolveModuleName` fails
    // and the workspace-inventory fallback answers correctly. A fix that broke this would trade one
    // silent-green shape for another.
    const graph = await scan(workspace({ built: false }));

    const fromApp = graph.edges.filter((e) => e.from === 'apps/web/src/app.ts');
    expect(fromApp).toHaveLength(1);
    expect(fromApp[0]?.to).toBe('libs/core/src/index.ts');
  });

  it('align’s answer does not depend on whether the repo has been built', async () => {
    // The property that actually matters, stated directly: `pnpm build` must not change align's
    // verdict. This is the assertion a reader should look at first.
    const builtEdges = (await scan(workspace({ built: true }))).edges.map((e) => `${e.from} -> ${e.to}`).sort();
    const unbuiltEdges = (await scan(workspace({ built: false }))).edges.map((e) => `${e.from} -> ${e.to}`).sort();

    expect(builtEdges).toEqual(unbuiltEdges);
  });
});
