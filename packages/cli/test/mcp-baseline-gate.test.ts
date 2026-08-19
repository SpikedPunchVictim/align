import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBaseline } from '../src/align-dir.js';
import { connectedClient, fixturesDir, textOf } from './mcp-test-helpers.js';

/**
 * ADR 024: `allowBaselineFromMcp` is the single gate over every MCP-reachable write to
 * `.align/baseline.json`, default `false` — implementing the ADR 006 clause that was documented
 * but never wired to a check. `align_propose_rules`'s `accept_new_into_baseline` is the only
 * caller today (`result.impact.addedNew` only — violations newly introduced by the rules proposed
 * in THIS call, not arbitrary pre-existing debt).
 *
 * The base `build-app-mcp` fixture has no real `api -> ui` import (see its component sources), so
 * proposing the `api-isolation` rule there never adds a new violation and the gate never has
 * anything to refuse. Each test below copies the fixture to a scratch dir and rewrites
 * `src/api/service.ts` to actually import from `ui`, so applying the proposed
 * `arch.no-dependency:api->ui` rule adds exactly one new violation and exercises the gate for
 * real.
 *
 * Split into its own file (rather than living in `mcp.test.ts`) because adding it there pushed
 * that file over align's own 500-line `arch.metric` limit for the `cli` component
 * (`docs/ARCHITECTURE-RULES.md:36`) — `align check` on this repo enforces that on itself.
 */
describe('align mcp — align_propose_rules baseline-write MCP gate (ADR 024)', () => {
  const apiIsolationProposal = {
    section: 'api-isolation',
    fragment: { kind: 'arch.no-dependency', from: 'api', to: 'ui' },
    sourceLineRange: { startLine: 5, endLine: 5 },
    sourceQuote: '`api` must not depend on `ui`.',
  };

  function scratchRepoWithNewViolation(allowBaselineFromMcpExport = ''): string {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-mcp-baseline-gate-test-'));
    fs.cpSync(path.join(fixturesDir, 'build-app-mcp'), rootDir, { recursive: true });
    // Introduce a real api -> ui dependency so proposing/applying `api-isolation` adds exactly one
    // new violation for the gate to act on.
    fs.writeFileSync(
      path.join(rootDir, 'src/api/service.ts'),
      `import { render } from '../ui/component.js';\nexport function handleRequest(): string {\n  return render();\n}\n`,
      'utf8',
    );
    if (allowBaselineFromMcpExport) {
      fs.appendFileSync(path.join(rootDir, 'align.config.ts'), allowBaselineFromMcpExport);
    }
    return rootDir;
  }

  it('default (no allowBaselineFromMcp in config): accept_new_into_baseline:true is refused, names the CLI equivalent, and writes nothing', async () => {
    const rootDir = scratchRepoWithNewViolation();
    try {
      const client = await connectedClient(rootDir);
      const result = await client.callTool({
        name: 'align_propose_rules',
        arguments: {
          doc_path: 'docs/ARCHITECTURE-RULES.md',
          proposals: [apiIsolationProposal],
          apply: true,
          accept_new_into_baseline: true,
        },
      });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain('align baseline accept --rule');
      expect(text).toContain('allowBaselineFromMcp');
      // Refused before any artifact write — not just the baseline entry.
      expect(fs.existsSync(path.join(rootDir, '.align/baseline.json'))).toBe(false);
      expect(fs.existsSync(path.join(rootDir, '.align/generated-rules.json'))).toBe(false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('config enables allowBaselineFromMcp: acceptance proceeds and the new violation is written to the on-disk baseline', async () => {
    const rootDir = scratchRepoWithNewViolation('\nexport const allowBaselineFromMcp = true;\n');
    try {
      const client = await connectedClient(rootDir);
      const result = await client.callTool({
        name: 'align_propose_rules',
        arguments: {
          doc_path: 'docs/ARCHITECTURE-RULES.md',
          proposals: [apiIsolationProposal],
          apply: true,
          accept_new_into_baseline: true,
        },
      });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(textOf(result)) as { applied: boolean };
      expect(payload.applied).toBe(true);
      expect(fs.existsSync(path.join(rootDir, '.align/baseline.json'))).toBe(true);
      // Through `readBaseline`, not `JSON.parse`. This test hand-parsed the file as a bare array and
      // was the only place in the suite that did — so it was also the only unit test the 0.2.0
      // envelope broke (ADR 006's 2026-08-19 amendment). Reading through the real accessor is what
      // this assertion always wanted: it is about what align accepted, not about the container.
      expect(readBaseline(rootDir).some((e) => e.ruleId === 'arch.no-dependency:api->ui')).toBe(true);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('apply:true without accept_new_into_baseline is unaffected by the gate when it is off (pre-existing ADR 006 consent refusal, unrelated to MCP)', async () => {
    const rootDir = scratchRepoWithNewViolation();
    try {
      const client = await connectedClient(rootDir);
      const result = await client.callTool({
        name: 'align_propose_rules',
        arguments: { doc_path: 'docs/ARCHITECTURE-RULES.md', proposals: [apiIsolationProposal], apply: true },
      });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      // The ordinary build-time consent message (`writeBuildArtifacts`), not the MCP-gate message —
      // the MCP gate never triggers because `accept_new_into_baseline` was never asserted true.
      expect(text).toContain('--accept-new-into-baseline');
      expect(text).not.toContain('allowBaselineFromMcp');
      expect(fs.existsSync(path.join(rootDir, '.align/baseline.json'))).toBe(false);
      expect(fs.existsSync(path.join(rootDir, '.align/generated-rules.json'))).toBe(false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('apply:true without accept_new_into_baseline is unaffected by the gate when it is on (same pre-existing refusal)', async () => {
    const rootDir = scratchRepoWithNewViolation('\nexport const allowBaselineFromMcp = true;\n');
    try {
      const client = await connectedClient(rootDir);
      const result = await client.callTool({
        name: 'align_propose_rules',
        arguments: { doc_path: 'docs/ARCHITECTURE-RULES.md', proposals: [apiIsolationProposal], apply: true },
      });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain('--accept-new-into-baseline');
      expect(fs.existsSync(path.join(rootDir, '.align/baseline.json'))).toBe(false);
      expect(fs.existsSync(path.join(rootDir, '.align/generated-rules.json'))).toBe(false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
