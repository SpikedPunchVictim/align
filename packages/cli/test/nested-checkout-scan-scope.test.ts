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
