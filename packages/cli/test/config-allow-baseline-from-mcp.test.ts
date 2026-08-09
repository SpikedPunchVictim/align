import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

// ADR 024 (implementing ADR 006:40-43): `allowBaselineFromMcp` is the single config-level gate
// over every MCP-reachable `.align/baseline.json` write. It follows the SAME sibling-export
// pattern as `excludes`/`compositionRoots`/`knownPublicDeepImports`/`telemetry` (see `config.ts`'s
// `LoadedConfig` doc comments) — a named export on `align.config.ts`, read outside the portable
// `RulesetIR`/zod path, fail-fast on a malformed value. Unlike its siblings it resolves straight
// to a concrete `boolean` (never `undefined`) because there is exactly one source for it (no CLI
// flag / env var precedence chain the way `telemetry` has) — an MCP tool cannot set it, only a
// human editing align.config.ts can.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

function scratchRepo(extraConfigExport: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-config-allow-baseline-from-mcp-test-'));
  fs.cpSync(path.join(fixturesDir, 'simple-app'), dir, { recursive: true });
  if (extraConfigExport) fs.appendFileSync(path.join(dir, 'align.config.ts'), extraConfigExport);
  return dir;
}

describe('config.ts — allowBaselineFromMcp (ADR 024)', () => {
  it('defaults to false when align.config.ts has no allowBaselineFromMcp export', async () => {
    tmpDir = scratchRepo('');
    const config = await loadConfig(tmpDir);
    expect(config.allowBaselineFromMcp).toBe(false);
  });

  it('reads true from an explicit `export const allowBaselineFromMcp = true;`', async () => {
    tmpDir = scratchRepo('\nexport const allowBaselineFromMcp = true;\n');
    const config = await loadConfig(tmpDir);
    expect(config.allowBaselineFromMcp).toBe(true);
  });

  it('reads false from an explicit `export const allowBaselineFromMcp = false;` (not just absence)', async () => {
    tmpDir = scratchRepo('\nexport const allowBaselineFromMcp = false;\n');
    const config = await loadConfig(tmpDir);
    expect(config.allowBaselineFromMcp).toBe(false);
  });

  it('fails fast with a descriptive error on a non-boolean value, rather than silently coercing it', async () => {
    tmpDir = scratchRepo("\nexport const allowBaselineFromMcp = 'yes';\n");
    await expect(loadConfig(tmpDir)).rejects.toThrow(/allowBaselineFromMcp.*must be a boolean/);
  });
});
