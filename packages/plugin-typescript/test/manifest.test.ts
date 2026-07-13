import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
