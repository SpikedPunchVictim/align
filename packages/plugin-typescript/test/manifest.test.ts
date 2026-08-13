import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeManifestScanner, scanManifests } from '../src/manifest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

describe('scanManifests (ADR 013 manifest scan domain)', () => {
  it('scans the root manifest plus every workspace member, without requiring node_modules', () => {
    const inventory = scanManifests(path.join(fixturesDir, 'manifest-security'));
    expect(inventory.lockfilePresent).toBe(true);
    const files = inventory.manifests.map((m) => m.file).sort();
    expect(files).toEqual(['package.json', 'packages/foo/package.json']);
  });

  it('resolves specifiers through pnpm-lock.yaml importers (lockfile-backed, catalog-aware)', () => {
    const inventory = scanManifests(path.join(fixturesDir, 'manifest-security'));
    const root = inventory.manifests.find((m) => m.file === 'package.json');
    expect(root?.dependencies).toEqual([
      { name: 'zod', specifier: '^3.23.8', field: 'dependencies', line: 6 },
      { name: 'vitest', specifier: '^2.1.4', field: 'devDependencies', line: 9 },
    ]);
  });

  it('probe-verified n8n case: xlsx CDN tarball and wa-sqlite git pin are both captured with their real specifiers', () => {
    const inventory = scanManifests(path.join(fixturesDir, 'manifest-security'));
    const foo = inventory.manifests.find((m) => m.file === 'packages/foo/package.json');
    const byName = new Map(foo?.dependencies.map((d) => [d.name, d]));
    expect(byName.get('xlsx')?.specifier).toBe('https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz');
    expect(byName.get('wa-sqlite')?.specifier).toBe('github:rhashimoto/wa-sqlite#779219540f66cecaa159da32b3b8936697ba10a7');
    expect(byName.get('left-pad')?.specifier).toBe('^1.3.0');
    expect(byName.get('xlsx')?.line).toBeGreaterThan(0);
  });

  it('falls back to the raw package.json specifier when no pnpm-lock.yaml is present', () => {
    const inventory = scanManifests(path.join(fixturesDir, 'manifest-no-lockfile'));
    expect(inventory.lockfilePresent).toBe(false);
    expect(inventory.manifests).toHaveLength(1);
    const byName = new Map(inventory.manifests[0]?.dependencies.map((d) => [d.name, d.specifier]));
    expect(byName.get('xlsx')).toBe('https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz');
    expect(byName.get('left-pad')).toBe('^1.3.0');
  });

  it('returns just the root manifest for a repo with no pnpm-workspace.yaml', () => {
    const inventory = scanManifests(path.join(fixturesDir, 'clean'));
    expect(inventory.manifests).toEqual([]); // `clean` fixture has no package.json at all
  });
});

describe('NodeManifestScanner (ManifestScanner injection seam, ADR 013)', () => {
  it('implements @spikedpunch/align-core\'s ManifestScanner interface', async () => {
    const scanner = new NodeManifestScanner();
    const inventory = await scanner.scan({ rootDir: path.join(fixturesDir, 'manifest-security'), excludes: [] });
    expect(inventory.manifests.length).toBeGreaterThan(0);
  });
});

/**
 * Pins the exemption `GateOrchestrator.runSecurityGate` (`core/src/orchestrator.ts`) relies on when
 * it passes `[]` for `BaselineStore.reconcileMoves`'s now-REQUIRED `skippedNestedCheckouts`
 * (review 2026-08-13). That `[]` is only correct if the manifest domain performs no nested-checkout
 * auto-exclusion of its own — i.e. a manifest can never go missing from `knownFiles` the way task
 * #25's `TypeScriptScanner` drops a source file (`plugin-typescript/test/nested-checkout.test.ts`
 * asserts that scanner DOES skip these). CLAUDE.md rule 4's discipline: an exemption is pinned by an
 * executable test, never asserted in a comment. So this is deliberately the exact inverse of the
 * scanner test's `expect(...).not.toContain(...)`.
 */
describe('the manifest scan domain does NOT auto-exclude nested checkouts (pins runSecurityGate\'s `[]`)', () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a workspace member whose directory carries its own `.git` is still scanned into the inventory', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-manifest-nested-checkout-test-'));
    // The scan root has its own `.git`, as every real repo does — same reasoning as
    // `nested-checkout.test.ts`'s setup, so "the root is never skipped" is a real assertion.
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'root', dependencies: { zod: '^3.23.8' } }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'vendor/*'\n", 'utf8');

    const memberDir = path.join(dir, 'vendor', 'submodule');
    fs.mkdirSync(memberDir, { recursive: true });
    // A linked worktree's `.git` is a FILE, not a directory — the shape `hasOwnGit` catches in the
    // source-scanning domain, used here so this fixture is not weaker than the scanner's.
    fs.writeFileSync(path.join(memberDir, '.git'), 'gitdir: /elsewhere/.git/worktrees/submodule\n', 'utf8');
    fs.writeFileSync(path.join(memberDir, 'package.json'), `${JSON.stringify({ name: 'submodule', dependencies: { 'left-pad': '^1.3.0' } }, null, 2)}\n`, 'utf8');

    const inventory = scanManifests(dir);

    expect(inventory.manifests.map((m) => m.file).sort()).toEqual(['package.json', 'vendor/submodule/package.json']);
  });
});
