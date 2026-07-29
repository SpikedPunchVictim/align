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
});
