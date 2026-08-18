import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { baselineAccept, baselinePrune } from '../src/commands/baseline.js';
import { writeBaseline } from '../src/align-dir.js';
import { toRuleId, toRepoRelativePath, toViolationId } from '@spikedpunch/align-core';
import { expectOnlyWrote, snapshotTree } from './write-set.js';

// ADR 026 fast-path coverage for `align baseline accept`/`align baseline prune` — `prune` is one
// of the two commands BUG #18 (ADR 023) fired from, and the ONE command in this codebase that
// deletes previously-accepted consent decisions, so an undeclared write here is the highest-stakes
// case this helper covers. Additive: no existing baseline test file is modified.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-write-set-baseline-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASELINE_WRITE_SET = ['.align', '.align/baseline.json', '.align/version.json'];

describe('`align baseline accept` write-set (ADR 026 fast path)', () => {
  it('accepting the current violations touches only its declared write-set', async () => {
    tmpDir = copyFixture('simple-app-violation');
    const before = snapshotTree(tmpDir);

    const code = await baselineAccept(tmpDir, undefined);
    expect(code).toBe(0);

    expectOnlyWrote(before, tmpDir, BASELINE_WRITE_SET);
  });
});

describe('`align baseline prune` write-set (ADR 026 fast path)', () => {
  it('pruning a fixed violation touches only its declared write-set', async () => {
    // `simple-app` is clean (zero current violations) — a pre-seeded baseline entry for a file
    // that no longer violates anything is exactly the "fixed violation" `prune` exists to drop.
    tmpDir = copyFixture('simple-app');
    writeBaseline(tmpDir, [
      {
        fingerprint: toViolationId('stale-1'),
        ruleId: toRuleId('arch.no-cycles'),
        file: toRepoRelativePath('src/a.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);
    const before = snapshotTree(tmpDir);

    // `simple-app` copied to a bare tmpdir has no real `node_modules`, so the SCANNER (a separate
    // resolution path from `loadConfig`'s dynamic `import()`, which vitest's own module graph
    // resolves fine) reports align.config.ts's own `@spikedpunch/align-core` import as
    // unresolvable — a `missing-dependencies` advisory, `complete: false`. `--allow-incomplete`
    // is the real, documented escape hatch for that (ADR 023 tier 2); it is unrelated to what
    // this test actually checks (the write-set of a successful prune).
    const code = await baselinePrune(tmpDir, { allowIncomplete: true, yes: true });
    expect(code).toBe(0);

    expectOnlyWrote(before, tmpDir, BASELINE_WRITE_SET);
  });
});
