import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toRepoRelativePath, toRuleId, toViolationId } from '@spikedpunch/align-core';
import { runCheck } from '../src/commands/check.js';
import { baselineAccept, baselinePrune } from '../src/commands/baseline.js';
import { runInit } from '../src/commands/init.js';
import { readBaseline, writeBaseline } from '../src/align-dir.js';
import { connectedClient, textOf } from './mcp-test-helpers.js';

/** Captures every `console.log` call made during `run()` as plain strings, restoring the real
 * `console.log` afterward even if `run()` throws — used below to assert on `baselinePrune`'s/
 * `runInit`'s retention report line without polluting the test runner's own output. */
async function withCapturedLogs<T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly logs: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    const result = await run();
    return { result, logs: lines.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Same discipline as check.test.ts's `linkAlignCore` / nested-checkout.test.ts's copy: a fixture
// built in a bare tmpdir has no `node_modules`, so `align.config.ts`'s own
// `@spikedpunch/align-core/dsl` import would otherwise show up as an unresolvable specifier.
function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

/**
 * A real `arch.no-dependency` violation whose OFFENDING FILE lives entirely inside a nested
 * checkout the human explicitly opted back into the scan (`includeNestedCheckouts`) — the exact
 * shape task #25's review found broken: every `CheckRun`-producing surface must resolve this
 * checkout the same way `align check` does, or they disagree about whether the violation (and,
 * once accepted, the baseline entry protecting it) exists at all.
 */
function buildRepoWithViolationInsideOptedInCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-scan-scope-test-'));
  fs.mkdirSync(path.join(dir, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'ui', 'component.ts'), 'export const x = 1;\n', 'utf8');

  const checkoutApiDir = path.join(dir, 'vendor', 'submodule', 'api');
  fs.mkdirSync(checkoutApiDir, { recursive: true });
  // A linked worktree's `.git` is a file — exercised here so this fixture matches the real shape
  // (this repo's own `.claude/worktrees/*`), not just the directory case.
  fs.writeFileSync(path.join(dir, 'vendor', 'submodule', '.git'), 'gitdir: /elsewhere/.git/worktrees/submodule\n', 'utf8');
  fs.writeFileSync(
    path.join(checkoutApiDir, 'service.ts'),
    `import { x } from '../../../src/ui/component.js';\nexport const y = x;\n`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n` +
      `export default defineProject({\n` +
      `  components: { api: 'vendor/submodule/api/**', ui: 'src/ui/**' },\n` +
      `  rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],\n` +
      `});\n` +
      `export const includeNestedCheckouts = ['vendor/submodule'];\n`,
    'utf8',
  );
  linkAlignCore(dir);
  return dir;
}

describe("scan-scope consistency across every CheckRun-producing surface (task #25 review fix — 'hunt the class')", () => {
  it(
    'align check, the MCP align_check tool, baseline accept, and baseline prune all resolve an ' +
      'opted-in nested checkout the same way — a regression in any one of them either hides a real ' +
      "violation or silently deletes the baseline entry protecting it (BUG #18's exact shape)",
    async () => {
      tmpDir = buildRepoWithViolationInsideOptedInCheckout();

      // 1. `align check` (`commands/check.ts`) sees the violation.
      expect(await runCheck(tmpDir, { json: false })).toBe(1);

      // 2. The MCP `align_check` tool is a SEPARATE scan path (`mcp/server.ts`'s `freshCheck` —
      // the function whose own doc comment warns it is the one that keeps getting missed by
      // cross-cutting changes) and must agree.
      const client = await connectedClient(tmpDir);
      const mcpResult = await client.callTool({ name: 'align_check', arguments: {} });
      const mcpPayload = JSON.parse(textOf(mcpResult)) as { verdict: string; violations: readonly unknown[] };
      expect(mcpPayload.verdict).toBe('red');
      expect(mcpPayload.violations).toHaveLength(1);

      // 3. `align baseline accept` runs its OWN scan (`currentViolations`, `commands/baseline.ts`)
      // to decide what to accept. If that scan didn't resolve the checkout, it would see zero
      // violations and accept nothing — the check above would stay red forever, un-acceptable.
      expect(await baselineAccept(tmpDir)).toBe(0);
      expect(await runCheck(tmpDir, { json: false })).toBe(0); // accepted -> green

      // 4. `align baseline prune` computes `knownFiles` from a THIRD scan (`orchestrator.knownFiles`,
      // `commands/baseline.ts`). If that scan didn't resolve the checkout, the just-accepted entry's
      // file would look absent — an "orphan" — and `store.prune` would delete it unconditionally
      // while reporting success and exiting 0. Assert the entry survives.
      const beforePrune = readBaseline(tmpDir);
      expect(beforePrune).toHaveLength(1);
      expect(await baselinePrune(tmpDir)).toBe(0);
      const afterPrune = readBaseline(tmpDir);
      expect(afterPrune).toHaveLength(1);
    },
  );
});

/**
 * A real `arch.no-dependency` violation whose offending file lives inside a nested checkout, EXACTLY
 * like `buildRepoWithViolationInsideOptedInCheckout` above — except the violating component's
 * selector (`'**\/api/**'`) also matches a second, innocent file OUTSIDE the checkout
 * (`src/api/other.ts`, which never imports `ui` and so never violates anything on its own).
 *
 * Why this straddling shape is the whole point: `validateComponents` throws when a component
 * resolves to zero files, and `baselinePrune` returns 1 with a loud diagnostic on that throw. If
 * the violating component matched files ONLY inside the checkout (as in the fixture above), then a
 * scan-scope regression that drops the checkout would make the component resolve to zero files,
 * the throw would fire, and the test would "pass" for the wrong reason — the assertion never
 * reaches the actual deletion, because the process never gets past the throw. That is a real gap:
 * `nested-checkout-scan-scope.test.ts`'s first test proves the wiring is present, but it has never
 * exercised the silent-data-loss path a regression could still take.
 *
 * With a straddling selector, dropping the checkout from the scan leaves the component non-empty
 * (`src/api/other.ts` still resolves), so `validateComponents` has nothing to throw about. The scan
 * completes, finds zero violations (the only violating file, inside the checkout, is invisible to
 * it), and the previously-accepted baseline entry looks orphaned by every measure `store.prune`
 * consults — this is the shape that reproduces BUG #18: `baselinePrune` reports success, exits 0,
 * and silently deletes the entry that was protecting a still-real violation.
 */
function buildRepoWithViolationStraddlingOptedInCheckout(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-scan-scope-straddle-test-'));
  fs.mkdirSync(path.join(dir, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'ui', 'component.ts'), 'export const x = 1;\n', 'utf8');

  // Innocent file OUTSIDE the nested checkout, matched by the same `'**/api/**'` selector as the
  // violating file below. It never imports `ui`, so it never violates anything by itself — its only
  // job is to keep the `api` component non-empty even if the checkout is dropped from the scan, so
  // the zero-files throw can never mask the assertion this test makes.
  fs.mkdirSync(path.join(dir, 'src', 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'api', 'other.ts'), 'export const outside = 1;\n', 'utf8');

  const checkoutApiDir = path.join(dir, 'vendor', 'submodule', 'api');
  fs.mkdirSync(checkoutApiDir, { recursive: true });
  // A linked worktree's `.git` is a file — exercised here so this fixture matches the real shape
  // (this repo's own `.claude/worktrees/*`), not just the directory case.
  fs.writeFileSync(path.join(dir, 'vendor', 'submodule', '.git'), 'gitdir: /elsewhere/.git/worktrees/submodule\n', 'utf8');
  fs.writeFileSync(
    path.join(checkoutApiDir, 'service.ts'),
    `import { x } from '../../../src/ui/component.js';\nexport const y = x;\n`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n` +
      `export default defineProject({\n` +
      // A single glob straddling the checkout boundary: matches both `src/api/other.ts` and
      // `vendor/submodule/api/service.ts`, so the component is never empty regardless of whether
      // the checkout is included in the scan.
      `  components: { api: '**/api/**', ui: 'src/ui/**' },\n` +
      `  rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],\n` +
      `});\n` +
      `export const includeNestedCheckouts = ['vendor/submodule'];\n`,
    'utf8',
  );
  linkAlignCore(dir);
  return dir;
}

describe(
  "baseline prune data loss on a straddling component (task #25 review gap — the zero-files throw " +
    "must not be able to mask this)",
  () => {
    it(
      "baseline prune's own scan resolving the nested checkout is what keeps an accepted violation's " +
        'baseline entry alive — asserted as the pair `prune exits 0 AND the entry still exists`, because a ' +
        "command that destroys data while reporting success is this project's severity-zero class",
      async () => {
        tmpDir = buildRepoWithViolationStraddlingOptedInCheckout();

        // Sanity: the violation is real and visible when the checkout is resolved.
        expect(await runCheck(tmpDir, { json: false })).toBe(1);

        // Accept it, then confirm the tree goes green.
        expect(await baselineAccept(tmpDir)).toBe(0);
        expect(await runCheck(tmpDir, { json: false })).toBe(0);

        const beforePrune = readBaseline(tmpDir);
        expect(beforePrune).toHaveLength(1);

        // The assertion that matters: prune must exit 0 AND the entry must still be there. If
        // `baselinePrune`'s own `orchestrator.check(...)` scan ever drops `includeNestedCheckouts`,
        // the violating file becomes invisible to that scan, the entry looks orphaned, and
        // `store.prune` deletes it — while this call still returns 0, because nothing about that
        // path is an error. Checking only the exit code would pass right through that regression;
        // asserting the pair is what catches it.
        expect(await baselinePrune(tmpDir)).toBe(0);
        const afterPrune = readBaseline(tmpDir);
        expect(afterPrune).toHaveLength(1);
      },
    );
  },
);

/**
 * A plain repo with ONE ordinary source file plus a nested git checkout that is NEVER opted back
 * in (`includeNestedCheckouts` is simply absent) — permanently auto-excluded, every scan, task #25's
 * default behaviour. Nothing inside the checkout needs to be a real violation, or even parse: the
 * retention decision (`nested-checkout-retention.ts`) is keyed purely on a baseline entry's `file`
 * falling under one of `run.skippedNestedCheckouts`, never on the fingerprint being "real" — the
 * same reason `write-set-baseline.test.ts`/`errored-run-mutations.test.ts` seed opaque fingerprints
 * like `'stale-1'` directly rather than deriving them from an actual scan.
 */
function buildRepoWithSkippedCheckoutAndCleanFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-checkout-retention-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');

  // A linked worktree's `.git` is a file (this repo's own `.claude/worktrees/*` shape) — matches
  // the other fixtures in this file rather than a plain directory `.git`.
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

describe(
  "align baseline prune retains an entry inside a skipped nested checkout while still pruning an " +
    'observable orphan in the same run (task #25 review fix — the "skip-and-report, not refuse" decision)',
  () => {
    it('exits 0, drops the genuinely-fixed entry, keeps the checkout entry, and reports the retention', async () => {
      tmpDir = buildRepoWithSkippedCheckoutAndCleanFile();
      writeBaseline(tmpDir, [
        // Genuinely fixed: `src/a.ts` is present in every scan and never violates `arch.noCycles`
        // — an ordinary orphan `store.prune` has always been correct to delete.
        {
          fingerprint: toViolationId('stale-observable'),
          ruleId: toRuleId('arch.no-cycles'),
          file: toRepoRelativePath('src/a.ts'),
          acceptedAt: 1,
          acceptedBy: 'manual',
        },
        // Unobservable, not fixed: this file lives inside `vendor/submodule`, which every scan
        // auto-excludes. Nothing about it changed — it just can't be seen — so it must survive.
        {
          fingerprint: toViolationId('stale-in-checkout'),
          ruleId: toRuleId('arch.no-cycles'),
          file: toRepoRelativePath('vendor/submodule/service.ts'),
          acceptedAt: 2,
          acceptedBy: 'manual',
        },
      ]);

      const { result: code, logs } = await withCapturedLogs(() => baselinePrune(tmpDir));

      expect(code).toBe(0);
      expect(logs).toMatch(/Pruned 1 fixed violation\(s\)/);
      expect(logs).toMatch(/Retained 1 entry/);
      expect(logs).toContain('vendor/submodule');

      const after = readBaseline(tmpDir);
      expect(after).toHaveLength(1);
      expect(after[0]?.fingerprint).toBe('stale-in-checkout');
    });
  },
);

describe(
  "align init has the same skipped-checkout exposure as baseline prune, and the same fix (task #25 " +
    'review "hunt the class" audit, CLAUDE.md rule 6)',
  () => {
    it(
      "the zero-violations reset path (`writeBaseline(rootDir, [])`) retains an existing entry whose file " +
        "is inside a skipped nested checkout instead of silently dropping it — BUG #18's exact shape, a " +
        'second instance found by auditing the other destructive baseline-write consumer',
      async () => {
        tmpDir = buildRepoWithSkippedCheckoutAndCleanFile();
        // Simulates a re-run of `init` on a repo that already has an accepted entry for a file the
        // scan can no longer see (the checkout was opted in when it was accepted, or accepted by an
        // older align, or seeded directly for the test — any of those are the real-world shape).
        writeBaseline(tmpDir, [
          {
            fingerprint: toViolationId('stale-in-checkout'),
            ruleId: toRuleId('arch.no-cycles'),
            file: toRepoRelativePath('vendor/submodule/service.ts'),
            acceptedAt: 1,
            acceptedBy: 'manual',
          },
        ]);

        const { result: code, logs } = await withCapturedLogs(() =>
          runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true }),
        );

        expect(code).toBe(0);
        expect(logs).toMatch(/Initial check is green/);
        expect(logs).toMatch(/Retained 1 entry/);
        expect(logs).toContain('vendor/submodule');

        const after = readBaseline(tmpDir);
        expect(after).toHaveLength(1);
        expect(after[0]?.fingerprint).toBe('stale-in-checkout');
      },
    );
  },
);
