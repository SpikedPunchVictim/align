import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readBaseline, writeBaseline } from '../src/align-dir.js';
import { baselineAccept } from '../src/commands/baseline.js';
import { runInit } from '../src/commands/init.js';
import { toRuleId, toRepoRelativePath, toViolationId } from '@spikedpunch/align-core';

// ADR 023 amendment (2026-08-11), "Resolved (same day): the seed path preserves provenance":
// independent of completeness (covered by `init-incomplete-baseline.test.ts`), the seed path used
// to rewrite EVERY surviving entry's `acceptedAt`/`acceptedBy` to `init-seed`/`accept-existing` at
// now, even on a COMPLETE scan where nothing else was lost — erasing the audit trail of a consent
// decision ADR 006 treats as the human's, on every re-run of `init`. Split into its own file rather
// than growing `init-incomplete-baseline.test.ts` (this repo's own `arch.metric` 500-line-per-file
// rule): every sibling test file in this directory already defines its own local copies of the same
// fixture/console-capture helpers instead of importing shared ones, so this follows the established
// per-file pattern.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-init-provenance-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  linkAlignCore(dest);
  return dest;
}

/** See `init-incomplete-baseline.test.ts`'s identical helper for the fuller reasoning: a fixture
 * copied to a bare tmpdir has no `node_modules`, so without this symlink `align.config.ts`'s own
 * import of `@spikedpunch/align-core/dsl` would itself read as a `missing-dependencies` advisory —
 * a test-harness artifact that would make every fixture here `complete: false` for the wrong
 * reason, defeating the COMPLETE-scan tests below. */
function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

/** `simple-app-violation` (`api` cannotDependOn `ui`, one real violation in `src/api/service.ts`)
 * with a SECOND file added to `api` that also imports from `ui` — a second, independent violation
 * of the same rule with a different `fromFile`, hence a different fingerprint (ADR 006: the
 * fingerprint is a content-snippet hash, and `fromFile` is part of that content). This is the
 * two-violation precondition the mixed-baseline test below needs; every other test in this file
 * only needs `simple-app-violation`'s single stock violation.
 */
function copyTwoViolationFixture(): string {
  const dest = copyFixture('simple-app-violation');
  fs.writeFileSync(
    path.join(dest, 'src', 'api', 'other.ts'),
    `import { render } from '../ui/component.js';\n\nexport function handleOther(): string {\n  return render();\n}\n`,
    'utf8',
  );
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function withCapturedConsole<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = ((...args: unknown[]) => logs.push(args.map(String).join(' '))) as typeof console.log;
  console.error = ((...args: unknown[]) => errors.push(args.map(String).join(' '))) as typeof console.error;
  try {
    return { result: await run(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('`align init` seed path preserves baseline provenance — ADR 023 amendment (2026-08-11, "Resolved (same day)")', () => {
  it('preserves acceptedAt AND acceptedBy verbatim for a still-observed violation, re-run with --accept-existing (the regression this change exists to prevent)', async () => {
    tmpDir = copyFixture('simple-app-violation');
    // Seed a REAL baseline entry first (real fingerprint from an actual scan), then overwrite its
    // provenance to a sentinel value distinguishable from "just stamped by this test run" — mirrors
    // the ADR amendment's own reproduction (`manual@1700000000000` → wrongly became
    // `accept-existing@<now>`).
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const seeded = readBaseline(tmpDir);
    expect(seeded).toHaveLength(1);
    const real = seeded[0]!;
    writeBaseline(tmpDir, [{ ...real, acceptedAt: 1_700_000_000_000, acceptedBy: 'manual' }]);

    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: true, nonInteractive: true, noScripts: true }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Seeded baseline with 1 pre-existing violation/);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.fingerprint).toBe(real.fingerprint);
    expect(after[0]?.acceptedAt).toBe(1_700_000_000_000);
    expect(after[0]?.acceptedBy).toBe('manual');
  });

  it('stamps a genuinely new violation (no prior entry with that fingerprint) with a fresh acceptedAt and `accept-existing`', async () => {
    tmpDir = copyFixture('simple-app-violation');
    expect(readBaseline(tmpDir)).toHaveLength(0);

    const before = Date.now();
    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: true, nonInteractive: true, noScripts: true }),
    );
    const after = Date.now();

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Seeded baseline with 1 pre-existing violation/);
    const entries = readBaseline(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.acceptedBy).toBe('accept-existing');
    expect(entries[0]?.acceptedAt).toBeGreaterThanOrEqual(before);
    expect(entries[0]?.acceptedAt).toBeLessThanOrEqual(after);

    // `init-seed` is the interactive-consent-equivalent stamp (used only when `!acceptExisting &&
    // isInteractive`, via the seed prompt). This test uses `nonInteractive: true`, which forces
    // `isInteractive` false, so it exercises `accept-existing`, not `init-seed` — the merge logic
    // itself is identical for both stamp values (see `commands/init.ts`'s
    // `acceptedBy: prior?.acceptedBy ?? (options.acceptExisting ? 'accept-existing' : 'init-seed')`).
    // `init-seed` itself, and the interactive accept/decline branches generally, are covered in
    // `init-interactive-consent.test.ts`, via `InitOptions.confirm` — the test seam added alongside
    // `UpgradeOptions.confirm` (`commands/upgrade.ts`) specifically to make this reachable.
  });

  it('a mixed baseline (one entry still observed, one new violation) produces exactly one preserved entry and one freshly-stamped entry in a single run', async () => {
    tmpDir = copyTwoViolationFixture();
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const seeded = readBaseline(tmpDir);
    expect(seeded).toHaveLength(2);

    const serviceEntry = seeded.find((e) => e.file === toRepoRelativePath('src/api/service.ts'));
    expect(serviceEntry).toBeDefined();
    // Persist ONLY the `service.ts` entry, with sentinel provenance — the `other.ts` violation's
    // entry is dropped entirely, simulating "no prior entry with that fingerprint" for it, exactly
    // as if this were the first time `init` had ever seen it.
    writeBaseline(tmpDir, [{ ...serviceEntry!, acceptedAt: 1_700_000_000_000, acceptedBy: 'manual' }]);

    const before = Date.now();
    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: true, nonInteractive: true, noScripts: true }),
    );
    const after = Date.now();

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Seeded baseline with 2 pre-existing violation/);
    const entries = readBaseline(tmpDir);
    expect(entries).toHaveLength(2);

    const preserved = entries.find((e) => e.fingerprint === serviceEntry!.fingerprint);
    expect(preserved?.acceptedAt).toBe(1_700_000_000_000);
    expect(preserved?.acceptedBy).toBe('manual');

    const fresh = entries.find((e) => e.fingerprint !== serviceEntry!.fingerprint);
    expect(fresh).toBeDefined();
    expect(fresh?.acceptedBy).toBe('accept-existing');
    expect(fresh?.acceptedAt).toBeGreaterThanOrEqual(before);
    expect(fresh?.acceptedAt).toBeLessThanOrEqual(after);
  });

  it('ruleId/file track the CURRENT violation, never the prior entry — pins the move-drift clause (fingerprints are content hashes, not paths)', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const seeded = readBaseline(tmpDir);
    expect(seeded).toHaveLength(1);
    const real = seeded[0]!;

    // Same fingerprint as the real, currently-observed violation, but a deliberately stale
    // `ruleId`/`file` — the shape a moved file's SURVIVING entry would have if the merge wrongly
    // carried the prior entry over verbatim instead of re-reading `ruleId`/`file` off the current
    // violation.
    writeBaseline(tmpDir, [
      {
        ...real,
        ruleId: toRuleId('arch.no-dependency:ui->api'),
        file: toRepoRelativePath('src/api/stale/moved-from-here.ts'),
        acceptedAt: 1_700_000_000_000,
        acceptedBy: 'manual',
      },
    ]);

    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: true, nonInteractive: true, noScripts: true }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Seeded baseline with 1 pre-existing violation/);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    // ruleId/file: current violation's values, NOT the stale ones the prior entry carried.
    expect(after[0]?.ruleId).toBe(real.ruleId);
    expect(after[0]?.file).toBe(real.file);
    expect(after[0]?.ruleId).not.toBe(toRuleId('arch.no-dependency:ui->api'));
    expect(after[0]?.file).not.toBe(toRepoRelativePath('src/api/stale/moved-from-here.ts'));
    // provenance: still inherited from the prior entry, unaffected by the stale ruleId/file.
    expect(after[0]?.acceptedAt).toBe(1_700_000_000_000);
    expect(after[0]?.acceptedBy).toBe('manual');
  });

  it('an entry the scan did not observe is still dropped on a COMPLETE scan — a provenance merge, not an entry union', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const seeded = readBaseline(tmpDir);
    expect(seeded).toHaveLength(1);
    const real = seeded[0]!;

    writeBaseline(tmpDir, [
      { ...real, acceptedAt: 1_700_000_000_000, acceptedBy: 'manual' },
      {
        fingerprint: toViolationId('stale-never-observed'),
        ruleId: toRuleId('arch.no-cycles'),
        file: toRepoRelativePath('src/nowhere.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: true, nonInteractive: true, noScripts: true }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Seeded baseline with 1 pre-existing violation/);
    const after = readBaseline(tmpDir);
    // The unobserved entry is gone (dropped, matching prune semantics on a complete scan); the
    // observed one survives with its provenance intact — merge of provenance, not union of entries.
    expect(after).toHaveLength(1);
    expect(after[0]?.fingerprint).toBe(real.fingerprint);
    expect(after[0]?.acceptedAt).toBe(1_700_000_000_000);
    expect(after[0]?.acceptedBy).toBe('manual');
  });
});
