import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { globDoubleStarSelectorDriftValidator } from '../src/migrations/validators/glob-double-star-drift.js';

// ADR 022's headline 0.2.0 validator candidate: a component selector's match set can differ
// between the pre-0.2.0 (cross-segment) and current (whole-segment) `**` semantics (commit
// 6d6c9c1). "Fires on a config that trips it, stays silent on one that does not" — the task's own
// framing — using two real fixtures rather than mocking the matcher.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-migration-validator-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  linkAlignCore(dest);
  return dest;
}

// See check.test.ts's identical helper: fixtures have no real node_modules, so the scanner needs
// align-core symlinked in for align.config.ts's own import to resolve.
function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('globDoubleStarSelectorDriftValidator', () => {
  it('fires on a selector with an interior `**` whose match set actually differs (app/**/model.ts vs app/datamodel.ts)', async () => {
    tmpDir = copyFixture('glob-double-star-drift');
    const findings = await globDoubleStarSelectorDriftValidator.run(tmpDir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.summary).toContain("Component 'app'");
    expect(findings[0]?.summary).toContain('app/**/model.ts');
    expect(findings[0]?.summary).toContain('1 file(s) no longer match');
    expect(findings[0]?.affectedFiles).toContain('app/datamodel.ts');
    // The real target (app/sub/model.ts) still matches under both semantics — it must not be
    // reported as drift.
    expect(findings[0]?.affectedFiles).not.toContain('app/sub/model.ts');
  });

  it('stays silent on a selector with no interior `**` (trailing `**` is unaffected by the fix)', async () => {
    tmpDir = copyFixture('simple-app'); // components: { app: 'src/**' } — trailing, not interior
    const findings = await globDoubleStarSelectorDriftValidator.run(tmpDir);
    expect(findings).toEqual([]);
  });

  it('returns no findings (not a throw) when the config fails to load', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-migration-validator-test-'));
    // No align.config.ts at all.
    const findings = await globDoubleStarSelectorDriftValidator.run(tmpDir);
    expect(findings).toEqual([]);
  });
});
