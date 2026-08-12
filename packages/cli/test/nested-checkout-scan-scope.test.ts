import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { baselineAccept, baselinePrune } from '../src/commands/baseline.js';
import { readBaseline } from '../src/align-dir.js';
import { connectedClient, textOf } from './mcp-test-helpers.js';

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
