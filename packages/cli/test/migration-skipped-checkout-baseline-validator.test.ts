import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { toRepoRelativePath, toRuleId, toViolationId } from '@spikedpunch/align-core';
import { baselineEntriesInSkippedCheckoutsValidator } from '../src/migrations/validators/baseline-entries-in-skipped-checkouts.js';
import { MIGRATION_REGISTRY, hasEntryForVersion, hasNotesForVersion } from '../src/migrations/registry.js';
import { COMPILED_NOTES } from '../src/migrations/notes.generated.js';
import { selectRange } from '../src/migrations/range.js';
import { writeBaseline } from '../src/align-dir.js';
import { expectOnlyWrote, snapshotTree } from './write-set.js';

// ADR 022 tier 2 for 0.2.0: task #25 stopped scanning nested git checkouts by default, so a repo
// upgrading from 0.1.x can hold baseline entries whose violations are now UNOBSERVABLE, not fixed.
// Fixtures are built in a tmpdir rather than checked in, matching
// `nested-checkout-scan-scope.test.ts` — a `.git` marker inside `test/fixtures/` would confuse both
// this repo's own git and its dogfooded `align check`.

const here = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Same discipline as `nested-checkout-scan-scope.test.ts`'s helper: a bare tmpdir has no
 * `node_modules`, so `align.config.ts`'s own `@spikedpunch/align-core/dsl` import would not
 * resolve for the scanner. */
function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

interface RepoOptions {
  /** Directories to mark as nested git checkouts (a `.git` FILE, the linked-worktree shape this
   * repo's own `.claude/worktrees/*` use — the same shape the other nested-checkout tests use). */
  readonly checkouts?: readonly string[];
  /** Value for `align.config.ts`'s `includeNestedCheckouts` export; omitted entirely when absent,
   * which is task #25's default (every checkout auto-excluded). */
  readonly includeNestedCheckouts?: readonly string[];
}

function buildRepo(options: RepoOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-checkout-validator-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');

  for (const checkout of options.checkouts ?? []) {
    const abs = path.join(dir, ...checkout.split('/'));
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n', 'utf8');
    fs.writeFileSync(path.join(abs, 'service.ts'), 'export const s = 1;\n', 'utf8');
  }

  const optIn =
    options.includeNestedCheckouts === undefined
      ? ''
      : `export const includeNestedCheckouts = ${JSON.stringify(options.includeNestedCheckouts)};\n`;
  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n` +
      `export default defineProject({\n` +
      `  components: { app: 'src/**' },\n` +
      `  rules: (c) => [c.arch.noCycles()],\n` +
      `});\n` +
      optIn,
    'utf8',
  );
  linkAlignCore(dir);
  return dir;
}

/** Seeds baseline entries with opaque fingerprints — the retention/containment decision is keyed
 * purely on `file`, never on the fingerprint being "real" (same rationale as
 * `write-set-baseline.test.ts` and `nested-checkout-scan-scope.test.ts`). */
function seedBaseline(dir: string, files: readonly string[]): void {
  writeBaseline(
    dir,
    files.map((file, index) => ({
      fingerprint: toViolationId(`seeded-${index}`),
      ruleId: toRuleId('arch.no-cycles'),
      file: toRepoRelativePath(file),
      acceptedAt: index + 1,
      acceptedBy: 'manual' as const,
    })),
  );
}

describe('baselineEntriesInSkippedCheckoutsValidator — entries stranded by 0.2.0 auto-exclusion', () => {
  it('names the checkout directory and every stranded entry under it', async () => {
    tmpDir = buildRepo({ checkouts: ['vendor/submodule'] });
    seedBaseline(tmpDir, ['vendor/submodule/service.ts', 'vendor/submodule/deep/other.ts']);

    const findings = await baselineEntriesInSkippedCheckoutsValidator.run(tmpDir);

    expect(findings).toHaveLength(1);
    // The directory itself, not just a count — the user cannot act on "2 entries are hidden."
    expect(findings[0]?.summary).toContain("nested checkout 'vendor/submodule'");
    expect(findings[0]?.summary).toContain('2 baseline entries');
    expect(findings[0]?.summary).toContain('unobservable, not fixed');
    expect(findings[0]?.summary).toContain('includeNestedCheckouts');
    // And the entries themselves, by path.
    expect(findings[0]?.affectedFiles).toEqual(['vendor/submodule/deep/other.ts', 'vendor/submodule/service.ts']);
  });

  it('reports one finding per affected checkout, so a per-directory opt-in decision is possible', async () => {
    tmpDir = buildRepo({ checkouts: ['vendor/a', 'vendor/b'] });
    seedBaseline(tmpDir, ['vendor/a/service.ts', 'vendor/b/service.ts']);

    const findings = await baselineEntriesInSkippedCheckoutsValidator.run(tmpDir);

    expect(findings).toHaveLength(2);
    const summaries = findings.map((f) => f.summary).join('\n');
    expect(summaries).toContain("nested checkout 'vendor/a'");
    expect(summaries).toContain("nested checkout 'vendor/b'");
    // Singular phrasing when exactly one entry is stranded under a checkout.
    expect(findings[0]?.summary).toContain('1 baseline entry');
  });

  it('a repo with no nested checkouts at all produces zero findings, even with a populated baseline', async () => {
    tmpDir = buildRepo();
    seedBaseline(tmpDir, ['src/a.ts']);

    expect(await baselineEntriesInSkippedCheckoutsValidator.run(tmpDir)).toEqual([]);
  });

  it('entries OUTSIDE a skipped checkout produce zero findings, even though the checkout exists', async () => {
    tmpDir = buildRepo({ checkouts: ['vendor/submodule'] });
    // `src/a.ts` is scanned normally; `vendor/submodule-notes/x.ts` is the prefix-collision case —
    // it shares the checkout path's leading characters but is NOT inside it.
    seedBaseline(tmpDir, ['src/a.ts', 'vendor/submodule-notes/x.ts']);

    expect(await baselineEntriesInSkippedCheckoutsValidator.run(tmpDir)).toEqual([]);
  });

  it('a checkout the human opted back in via includeNestedCheckouts produces zero findings — it is scanned, so nothing is stranded', async () => {
    tmpDir = buildRepo({ checkouts: ['vendor/submodule'], includeNestedCheckouts: ['vendor/submodule'] });
    seedBaseline(tmpDir, ['vendor/submodule/service.ts']);

    expect(await baselineEntriesInSkippedCheckoutsValidator.run(tmpDir)).toEqual([]);
  });

  it('an empty/absent baseline produces zero findings without needing a scan', async () => {
    tmpDir = buildRepo({ checkouts: ['vendor/submodule'] });
    expect(await baselineEntriesInSkippedCheckoutsValidator.run(tmpDir)).toEqual([]);
  });
});

describe('baselineEntriesInSkippedCheckoutsValidator — defensive posture (matches glob-double-star-drift)', () => {
  it('returns no findings (not a throw) when there is no align.config.ts to load', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-checkout-validator-test-'));
    fs.mkdirSync(path.join(tmpDir, '.align'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.align', 'baseline.json'),
      JSON.stringify([{ fingerprint: 'x', ruleId: 'arch.no-cycles', file: 'vendor/sub/a.ts', acceptedAt: 1, acceptedBy: 'manual' }]),
      'utf8',
    );

    await expect(baselineEntriesInSkippedCheckoutsValidator.run(tmpDir)).resolves.toEqual([]);
  });

  it('returns no findings (not a throw) when .align/baseline.json is corrupt — `align upgrade`\'s own read reports that', async () => {
    tmpDir = buildRepo({ checkouts: ['vendor/submodule'] });
    fs.mkdirSync(path.join(tmpDir, '.align'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.align', 'baseline.json'), '{ not json', 'utf8');

    await expect(baselineEntriesInSkippedCheckoutsValidator.run(tmpDir)).resolves.toEqual([]);
  });
});

describe('baselineEntriesInSkippedCheckoutsValidator is strictly read-only (ADR 026: declared write-set is EMPTY)', () => {
  it('leaves the repo byte-identical — including .align/baseline.json — after a run that FINDS something', async () => {
    tmpDir = buildRepo({ checkouts: ['vendor/submodule'] });
    seedBaseline(tmpDir, ['vendor/submodule/service.ts']);
    const before = snapshotTree(tmpDir);

    const findings = await baselineEntriesInSkippedCheckoutsValidator.run(tmpDir);
    // Assert the pair: a validator that silently found nothing would satisfy the write-set check
    // trivially, which is how a read-only assertion passes for the wrong reason.
    expect(findings).toHaveLength(1);

    expectOnlyWrote(before, tmpDir, []);
  });

  it('creates no .align directory on a repo that has none', async () => {
    tmpDir = buildRepo({ checkouts: ['vendor/submodule'] });
    const before = snapshotTree(tmpDir);

    await baselineEntriesInSkippedCheckoutsValidator.run(tmpDir);

    expectOnlyWrote(before, tmpDir, []);
    expect(fs.existsSync(path.join(tmpDir, '.align'))).toBe(false);
  });
});

describe('MIGRATION_REGISTRY — the 0.2.0 entry (ADR 022)', () => {
  it('exposes 0.2.0 with notes sourced from the compiled notes, not a hand-typed literal', () => {
    expect(hasEntryForVersion(MIGRATION_REGISTRY, '0.2.0')).toBe(true);
    expect(hasNotesForVersion(MIGRATION_REGISTRY, '0.2.0')).toBe(true);
    const entry = MIGRATION_REGISTRY.find((e) => e.version === '0.2.0');
    // Identity, not deep equality: the entry must be the SAME array the compiler produced, so a
    // copy hand-maintained alongside it could not pass (ADR 021's one-record invariant).
    expect(entry?.notes).toBe(COMPILED_NOTES['0.2.0']);
  });

  it('carries the stranded-baseline validator and, deliberately, no transform', () => {
    const entry = MIGRATION_REGISTRY.find((e) => e.version === '0.2.0');
    expect(entry?.validators.map((v) => v.id)).toEqual(['baseline-entries-in-skipped-checkouts']);
    // ADR 022 criterion 2: the remediation here is an intent decision (opt the path back in vs let
    // the entries go dormant), so this validator stays validator-only by design.
    expect(entry?.transforms).toEqual([]);
  });

  it('does not disturb the completeness invariant for the CURRENT version, which is still 0.1.4', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe('0.1.4'); // guard: this test's premise, stated rather than assumed
    expect(hasEntryForVersion(MIGRATION_REGISTRY, pkg.version)).toBe(true);
    expect(hasNotesForVersion(MIGRATION_REGISTRY, pkg.version)).toBe(true);
  });

  it("stays inert until the version bump: selectRange excludes an entry newer than the running binary's version", () => {
    // Both branches an `align upgrade` on 0.1.4 can take — an unknown stamp (the common case) and a
    // known one — must exclude 0.2.0, or a 0.1.4 user would be shown notes for a release they are
    // not running.
    expect(selectRange(MIGRATION_REGISTRY, 'unknown', '0.1.4').entries.map((e) => e.version)).toEqual(['0.1.4']);
    expect(selectRange(MIGRATION_REGISTRY, '0.1.3', '0.1.4').entries.map((e) => e.version)).toEqual(['0.1.4']);
    // ...and it DOES appear once the binary is 0.2.0, so the entry is not dead code.
    expect(selectRange(MIGRATION_REGISTRY, '0.1.4', '0.2.0').entries.map((e) => e.version)).toEqual(['0.2.0']);
  });
});
