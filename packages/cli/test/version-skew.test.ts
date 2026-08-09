import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectVersionSkewAdvisory } from '../src/version-skew.js';
import { ALIGN_VERSION } from '../src/telemetry/index.js';

let tmpDir: string;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function repoWithLocalCore(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-skew-'));
  tmpDir = dir;
  const coreDir = path.join(dir, 'node_modules', '@spikedpunch', 'align-core');
  fs.mkdirSync(coreDir, { recursive: true });
  fs.writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({ name: '@spikedpunch/align-core', version }));
  return dir;
}

describe('detectVersionSkewAdvisory (global-vs-local align version skew)', () => {
  it('flags a skew when the running CLI differs from the repo-installed align-core (the stale-global-shadow case)', () => {
    const advisory = detectVersionSkewAdvisory(repoWithLocalCore('0.1.0'));
    expect(advisory?.kind).toBe('version-skew');
    expect(advisory?.message).toContain(ALIGN_VERSION);
    expect(advisory?.message).toContain('0.1.0');
    expect(advisory?.message).toMatch(/npx align|node_modules\/\.bin\/align/);
  });

  it('does NOT flag when the local align-core matches the running CLI (lockstep — the normal case)', () => {
    expect(detectVersionSkewAdvisory(repoWithLocalCore(ALIGN_VERSION))).toBeUndefined();
  });

  it('does NOT flag when there is no local align-core (a missing install is a config-load error, not a skew)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-skew-none-'));
    expect(detectVersionSkewAdvisory(tmpDir)).toBeUndefined();
  });

  it('the advisory message names the resolved package.json path so a user can see which install was compared against', () => {
    const dir = repoWithLocalCore('0.1.0');
    const expectedPath = path.join(dir, 'node_modules', '@spikedpunch', 'align-core', 'package.json');
    const advisory = detectVersionSkewAdvisory(dir);
    expect(advisory?.message).toContain(expectedPath);
  });

  // ADR 021 gap 1: Node resolves `node_modules` by walking UP the directory tree, so a hoisted
  // monorepo (align-core installed at the workspace root, not inside the checked package) was a
  // false negative before this fix — the lookup only ever checked `rootDir` itself.
  describe('hoisted monorepo — align-core resolved from a PARENT directory', () => {
    it('flags a skew when align-core is found only by walking up to a parent (previously a false negative)', () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'align-skew-parent-'));
      tmpDir = parent;
      const coreDir = path.join(parent, 'node_modules', '@spikedpunch', 'align-core');
      fs.mkdirSync(coreDir, { recursive: true });
      fs.writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({ name: '@spikedpunch/align-core', version: '0.1.0' }));
      const childRoot = path.join(parent, 'packages', 'app');
      fs.mkdirSync(childRoot, { recursive: true });

      const advisory = detectVersionSkewAdvisory(childRoot);
      expect(advisory?.kind).toBe('version-skew');
      expect(advisory?.message).toContain('0.1.0');
      expect(advisory?.message).toContain(path.join(coreDir, 'package.json'));
    });

    it('does NOT flag when the parent-resolved align-core matches the running CLI (still lockstep, just hoisted)', () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'align-skew-parent-match-'));
      tmpDir = parent;
      const coreDir = path.join(parent, 'node_modules', '@spikedpunch', 'align-core');
      fs.mkdirSync(coreDir, { recursive: true });
      fs.writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({ name: '@spikedpunch/align-core', version: ALIGN_VERSION }));
      const childRoot = path.join(parent, 'packages', 'app');
      fs.mkdirSync(childRoot, { recursive: true });

      expect(detectVersionSkewAdvisory(childRoot)).toBeUndefined();
    });

    it('prefers the CLOSEST node_modules over a parent one when both exist (mirrors Node resolution order)', () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'align-skew-both-'));
      tmpDir = parent;
      const parentCoreDir = path.join(parent, 'node_modules', '@spikedpunch', 'align-core');
      fs.mkdirSync(parentCoreDir, { recursive: true });
      fs.writeFileSync(path.join(parentCoreDir, 'package.json'), JSON.stringify({ name: '@spikedpunch/align-core', version: '0.1.0' }));

      const childRoot = path.join(parent, 'packages', 'app');
      const childCoreDir = path.join(childRoot, 'node_modules', '@spikedpunch', 'align-core');
      fs.mkdirSync(childCoreDir, { recursive: true });
      fs.writeFileSync(path.join(childCoreDir, 'package.json'), JSON.stringify({ name: '@spikedpunch/align-core', version: '0.2.0' }));

      const advisory = detectVersionSkewAdvisory(childRoot);
      expect(advisory?.message).toContain('0.2.0');
      expect(advisory?.message).not.toContain('0.1.0');
      expect(advisory?.message).toContain(path.join(childCoreDir, 'package.json'));
    });

    it('does NOT flag when nothing is found anywhere up the tree (still a config-load error, not a skew)', () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'align-skew-parent-none-'));
      tmpDir = parent;
      const childRoot = path.join(parent, 'packages', 'app');
      fs.mkdirSync(childRoot, { recursive: true });

      expect(detectVersionSkewAdvisory(childRoot)).toBeUndefined();
    });
  });
});
