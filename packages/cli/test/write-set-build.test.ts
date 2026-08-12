import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runBuild } from '../src/commands/build.js';
import { expectMarkerRegionUnchanged, expectOnlyWrote, snapshotTree } from './write-set.js';

// ADR 026 fast-path coverage for `align build --apply` — one of the two commands BUG #10 fired
// from. Additive: `test/build.test.ts` keeps its own assertions untouched. Reuses that file's own
// `build-app` fixture and `copyFixture` convention.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');
const DOC = 'docs/ARCHITECTURE-RULES.md';

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-write-set-build-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BUILD_APPLY_WRITE_SET = ['align.config.ts', '.align', '.align/generated-rules.json', '.align/rules.lock.json', '.align/last-build-report.md', '.align/version.json'];

describe('`align build --apply` write-set (ADR 026 fast path)', () => {
  it('a first apply touches only its declared write-set', async () => {
    tmpDir = copyFixture('build-app');
    const before = snapshotTree(tmpDir);

    const code = await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(code).toBe(0);

    expectOnlyWrote(before, tmpDir, BUILD_APPLY_WRITE_SET);
  });

  // The content-aware clause (ADR 026, BUG #10 as a property): re-applying after the doc changed
  // must touch align.config.ts's note block ONLY — the hand-authored `defineProject` ruleset
  // above it must be byte-identical, not merely "the file still contains the substring."
  it('a second apply (doc changed) only touches the marked region of align.config.ts', async () => {
    tmpDir = copyFixture('build-app');
    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });

    const configBefore = fs.readFileSync(path.join(tmpDir, 'align.config.ts'), 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, DOC),
      fs.readFileSync(path.join(tmpDir, DOC), 'utf8').replace('## No Cycles', '## No Cycles (edited)'),
      'utf8',
    );
    const before = snapshotTree(tmpDir);

    const code = await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(code).toBe(0);

    expectOnlyWrote(before, tmpDir, ['align.config.ts', '.align/generated-rules.json', '.align/rules.lock.json', '.align/last-build-report.md', '.align/version.json']);

    const configAfter = fs.readFileSync(path.join(tmpDir, 'align.config.ts'), 'utf8');
    expectMarkerRegionUnchanged(configBefore, configAfter, 'align.config.ts', '// align:generated-rules-note:start', '// align:generated-rules-note:end');
  });
});
