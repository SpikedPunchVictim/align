import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeScriptPlugin } from '../src/plugin.js';
import { toComponentName } from '@spikedpunch/align-core';
import type { ComponentDefinitionIR } from '@spikedpunch/align-core';

/**
 * LEDGER **D053** — a SOURCE directory named `build`, `dist`, `out` or `coverage` was skipped, at any
 * depth, so its files were governed by no rule at all.
 *
 * Found by the D052 safety net on its first run: of 820 edges still pointing at non-nodes after the
 * resolver fix, two targeted `packages/core/src/build/`. Measured in align's OWN repository —
 * **14 TypeScript source files there, zero scanned** — so align's architecture rules had never
 * evaluated any of them and its self-dogfood green did not cover them.
 *
 * `DEFAULT_EXCLUDED_DIR_NAMES` is matched against every directory ENTRY NAME during the walk. The
 * exclusion targets a ROLE — build output — and was implemented as a NAME, so any directory sharing
 * the name inherits it [S-06].
 *
 * **The fix keeps the names and adds the missing question: is this directory where build output
 * actually lives?** Build output sits at a package root — beside the `package.json` that declares it
 * — or at the repository root. A directory named `build` under `src/` is not build output, it is a
 * module called build. The walk already holds the answer: `readdirSync(…, {withFileTypes: true})`
 * gives it the current directory's entries, so "does this directory contain a package.json" costs no
 * extra I/O.
 *
 * `node_modules` and `.git` stay excluded at ANY depth, and that asymmetry is the point: nested
 * `node_modules` are real and a nested `.git` is a checkout boundary, so neither is a
 * package-root-only concern.
 */

let tmpDir: string;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function repo(): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-build-name-')));
  const w = (rel: string, content = 'export const x = 1;\n'): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
  };
  w('package.json', JSON.stringify({ name: 'root', private: true }));
  w('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }));

  w('packages/core/package.json', JSON.stringify({ name: 'core', main: 'dist/index.js' }));
  w('packages/core/src/index.ts');
  // A real source module that happens to be called `build` — align's own repo has exactly this.
  w('packages/core/src/build/compile.ts');
  w('packages/core/src/build/index.ts');
  // Genuine build output, at the package root beside its package.json.
  w('packages/core/dist/index.js');
  w('packages/core/dist/index.d.ts', 'export declare const x: number;\n');
  // Genuine build output at the repository root.
  w('out/bundle.js');
  // Vendored deps, which must stay excluded wherever they appear.
  w('packages/core/src/node_modules/sneaky/index.ts');
  return dir;
}

const COMPONENTS: Readonly<Record<string, ComponentDefinitionIR>> = {
  [toComponentName('core')]: { name: 'core', selector: { kind: 'glob', patterns: ['packages/core/**'] }, empty: 'allow' },
};

async function scannedFiles(dir: string): Promise<string[]> {
  const g = await new TypeScriptPlugin().scanner.scan({ rootDir: dir, components: COMPONENTS, excludes: [] });
  return g.nodes.map((n) => String(n.file)).sort();
}

describe('a source directory named build/dist/out is scanned [D053]', () => {
  it('scans src/build/, which is a module and not build output', async () => {
    const files = await scannedFiles(repo());

    // Before the fix: absent. Fourteen files in align's own repo were in exactly this position.
    expect(files).toContain('packages/core/src/build/compile.ts');
    expect(files).toContain('packages/core/src/build/index.ts');
  });

  it('still skips real build output at a package root [S-04]', async () => {
    // The calibration that matters most. Scanning `dist/` would classify generated files into
    // components and manufacture edges from them — the exclusion exists for a reason and the fix
    // must not trade one silent wrong answer for a noisy one.
    const files = await scannedFiles(repo());

    expect(files.some((f) => f.startsWith('packages/core/dist/'))).toBe(false);
  });

  it('still skips build output at the repository root [S-04]', async () => {
    const files = await scannedFiles(repo());

    expect(files.some((f) => f.startsWith('out/'))).toBe(false);
  });

  it('still skips node_modules at ANY depth, including under src/ [S-04]', async () => {
    // The asymmetry is deliberate: nested node_modules are real, so this name cannot become
    // package-root-only along with the build-output names.
    const files = await scannedFiles(repo());

    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('records a blind spot for the output it skips, and none for the source it now scans', async () => {
    const g = await new TypeScriptPlugin().scanner.scan({ rootDir: repo(), components: COMPONENTS, excludes: [] });
    const excluded = g.blindSpots.filter((b) => b.reason.kind === 'default-excluded-dir').map((b) => String(b.path));

    expect(excluded).toContain('packages/core/dist');
    expect(excluded).toContain('out');
    // The whole defect: this used to be recorded as an excluded directory, silently.
    expect(excluded).not.toContain('packages/core/src/build');
  });
});
