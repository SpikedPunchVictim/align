import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import { writeSkillFile } from '../src/skill/install.js';
import { buildProgram } from '../src/program.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function humanOutput(dir: string, options: Parameters<typeof runDoctor>[1]): Promise<string> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await runDoctor(dir, options);
  } finally {
    console.log = originalLog;
  }
  return logs.join('\n');
}

// ADR 021 gap 3: `doctor.test.ts`'s `stale-skill advisory` describe block already covers the
// version-only comparison (missing marker, behind-version, matching-version). Split out into its
// own file (mirrors `doctor-deep-imports.test.ts`) to stay under the repo's own arch.metric
// 500-line-per-file limit, not because the concern is unrelated — this is the content-hash layer
// `buildStaleSkillAdvisory` applies ON TOP of that version check once the version matches: a
// skill re-rendered at the SAME version (the normal case during development, or any patch that
// touches skill text without bumping ALIGN_VERSION) was previously undetectable.
describe('align doctor — stale-skill content-hash detection (same version, changed content)', () => {
  it('reports no advisory when the installed snapshot matches both version and content', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-skillhash-test-'));
    const program = buildProgram();
    writeSkillFile(tmpDir, program);

    expect(await humanOutput(tmpDir, { json: false, program })).not.toContain('stale-skill');
  });

  it('reports a stale-skill advisory when the version matches but the rendered content has changed (the new capability)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-skillhash-test-'));
    writeSkillFile(tmpDir, buildProgram());

    // Simulate a skill-text change that did NOT bump ALIGN_VERSION: doctor recomputes against a
    // program whose CLI-inventory section renders differently (an extra command) — same running
    // binary version either way, only the rendered body differs.
    const changedProgram = buildProgram();
    changedProgram.command('fixture-only-command').description('simulates a skill content change independent of ALIGN_VERSION');

    const output = await humanOutput(tmpDir, { json: false, program: changedProgram });
    expect(output).toContain('stale-skill');
    expect(output).toContain('content');
  });

  it('reports no advisory when no program is available to recompute against (nothing to compare, stays silent)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-skillhash-test-'));
    writeSkillFile(tmpDir, buildProgram());

    // No `program` passed — `buildStaleSkillAdvisory` can't recompute the current body to compare
    // against, so it must stay silent rather than guess.
    expect(await humanOutput(tmpDir, { json: false })).not.toContain('stale-skill');
  });
});
