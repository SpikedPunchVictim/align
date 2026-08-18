import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toRepoRelativePath, toRuleId, toViolationId } from '@spikedpunch/align-core';
import { runUpgrade } from '../src/commands/upgrade.js';
import { ensureAlignDir, readBaseline } from '../src/align-dir.js';
import { seedBaseline } from './seed-baseline.js';

/**
 * `align upgrade`'s prune PREVIEW (`reconcilePrune`, `commands/upgrade.ts`) must count exactly what
 * the authoritative `baselinePrune` (`commands/baseline.ts`) will actually forfeit. Two observable
 * things are derived from that one number, and both are wrong if it drifts: the consent prompt's
 * "Prune N orphaned baseline entr(y|ies)?" text, and the ADR 023 tier-2 `refuseIfRunIncomplete`
 * decision made just above it.
 *
 * Review 2026-08-13 found it had drifted. The preview used `store.prune(...).removed.length`, while
 * `baselinePrune` recovers the removed entries from its pre-prune snapshot, runs
 * `partitionBlindSpotCandidates` over them, and uses `forfeited.length` for both its report
 * and its own tier-2 guard. The preview therefore over-counted by exactly the RETAINED entries —
 * the ones whose file lives inside a nested checkout the scan auto-excluded (task #25), which
 * retention writes straight back and never deletes.
 *
 * These tests live in their own file rather than in `nested-checkout-scan-scope.test.ts` (whose
 * fixtures they mirror) only because that file is already near the `cli` component's 500-line
 * max-loc rule; the fixture shapes below are deliberately the same ones used there.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Same discipline as `check.test.ts`'s / `nested-checkout-scan-scope.test.ts`'s copies: a fixture
 * built in a bare tmpdir has no `node_modules`, so `align.config.ts`'s own
 * `@spikedpunch/align-core/dsl` import would otherwise show up as an unresolvable specifier and
 * make every scan of the fixture `complete: false` by accident. */
function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

/** Captures `console.log` and `console.error` (the latter is where `reportCliError` — and therefore
 * `refuseIfRunIncomplete`'s refusal text — writes), restoring both even if `run()` throws. */
async function withCapturedConsole<T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly logs: string; readonly errors: string }> {
  const logLines: string[] = [];
  const errorLines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map(String).join(' '));
  });
  try {
    const result = await run();
    return { result, logs: logLines.join('\n'), errors: errorLines.join('\n') };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

/** One ordinary source file plus a nested git checkout that is never opted back in — every scan
 * auto-excludes `vendor/submodule` (task #25's default). Same shape as
 * `nested-checkout-scan-scope.test.ts`'s `buildRepoWithSkippedCheckoutAndCleanFile`, including the
 * `.git`-as-a-FILE (linked worktree) form. Nothing inside the checkout needs to exist or parse: the
 * retention decision is keyed purely on a baseline entry's `file` falling under a skipped path. */
function buildRepoWithSkippedCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-upgrade-preview-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');

  fs.mkdirSync(path.join(dir, 'vendor', 'submodule'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vendor', 'submodule', '.git'), 'gitdir: /elsewhere/.git/worktrees/submodule\n', 'utf8');

  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n` +
      `export default defineProject({\n` +
      `  components: { app: 'src/**' },\n` +
      `  rules: (c) => [c.arch.noCycles()],\n` +
      `});\n`,
    'utf8',
  );
  linkAlignCore(dir);
  return dir;
}

/** The same repo, plus one unresolvable import in its single observable source file. That specifier
 * is what makes every scan `complete: false` (an `unresolvable-specifier` marker collapsed into a
 * `missing-dependencies` advisory — ADR 023's tier-2 axis), exactly how
 * `fixtures/simple-app-violation-incomplete` does it. `arch.noCycles` still evaluates normally and
 * still finds nothing, so the prune preview is the only thing under test. */
function buildIncompleteRepoWithSkippedCheckout(): string {
  const dir = buildRepoWithSkippedCheckout();
  fs.writeFileSync(
    path.join(dir, 'src', 'a.ts'),
    `import { missing } from 'this-package-is-never-installed';\nexport const a = missing;\n`,
    'utf8',
  );
  return dir;
}

/** An older `alignVersion` stamp with no `baselineReconciledBy` — `runUpgrade` short-circuits with
 * "Already at the current version" otherwise. Must be written AFTER `writeBaseline`, which always
 * stamps the currently-running version as a side effect (ADR 022's write-discipline choke point). */
function writeOldVersionStamp(rootDir: string): void {
  ensureAlignDir(rootDir);
  fs.writeFileSync(path.join(rootDir, '.align', 'version.json'), `${JSON.stringify({ alignVersion: '0.1.0' }, null, 2)}\n`, 'utf8');
}

/** A baseline entry whose file lives inside the permanently-skipped `vendor/submodule` checkout, so
 * it looks orphaned to every scan while being unobservable rather than fixed. `acceptedAt` is a
 * distinguishable sentinel — the irreplaceable consent record that must survive intact. */
function checkoutResidentEntry() {
  return {
    fingerprint: toViolationId('stale-in-checkout'),
    ruleId: toRuleId('arch.no-cycles'),
    file: toRepoRelativePath('vendor/submodule/service.ts'),
    acceptedAt: 4242,
    acceptedBy: 'manual' as const,
  };
}

describe("align upgrade's prune preview counts exactly what `baselinePrune` will forfeit (review 2026-08-13)", () => {
  it(
    'a checkout-resident orphan is never offered for pruning: no "Prune N orphaned baseline entr(y|ies)?" ' +
      'prompt is asked at all, because `baselinePrune` would forfeit 0 of them and retain 1',
    async () => {
      tmpDir = buildRepoWithSkippedCheckout();
      seedBaseline(tmpDir, [checkoutResidentEntry()]);
      writeOldVersionStamp(tmpDir);

      const questions: string[] = [];
      const { result: code } = await withCapturedConsole(() =>
        runUpgrade(tmpDir, {
          nonInteractive: false,
          confirm: async (question: string) => {
            questions.push(question);
            return true;
          },
        }),
      );

      expect(code).toBe(0);
      // Pre-fix this recorded "\nPrune 1 orphaned baseline entry?" — consent solicited for a deletion
      // `baselinePrune`'s own retention partition makes impossible.
      expect(questions.filter((q) => q.includes('Prune'))).toEqual([]);

      const after = readBaseline(tmpDir);
      expect(after).toHaveLength(1);
      expect(after[0]?.acceptedAt).toBe(4242); // consent record intact
    },
  );

  it(
    'an INCOMPLETE scan is not refused over a checkout-resident entry either: `baselinePrune` evaluates ' +
      'ADR 023 tier 2 against the FORFEITED count (0 here), so the preview must not refuse on 1',
    async () => {
      tmpDir = buildIncompleteRepoWithSkippedCheckout();
      seedBaseline(tmpDir, [checkoutResidentEntry()]);
      writeOldVersionStamp(tmpDir);

      const { result: code, errors } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: true, yes: true }));

      // Pre-fix this printed "refusing to delete 1 entry" and returned 1 — a refusal over an entry
      // that was never at risk, on a run `baselinePrune` itself would have let proceed.
      expect(errors).not.toMatch(/refusing to delete/);
      expect(code).toBe(0);

      const after = readBaseline(tmpDir);
      expect(after).toHaveLength(1);
      expect(after[0]?.acceptedAt).toBe(4242);
    },
  );
});
