import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALIGN_VERSION } from '../src/telemetry/index.js';
import { connectedClient, fixturesDir, textOf } from './mcp-test-helpers.js';

/**
 * Builds `dir/node_modules` the same way the whole-directory `fs.symlinkSync(realNodeModules, ...)`
 * used elsewhere in this file does (individual real-package resolution, so TypeScript/align-core/
 * everything else still works) EXCEPT for `@spikedpunch/align-core`: that one package gets its own
 * shadow directory — every file symlinked through as-is except `package.json`, which is rewritten
 * with `fakeVersion`. This lets `detectVersionSkewAdvisory` (which reads only
 * `node_modules/@spikedpunch/align-core/package.json`'s `version` field, `version-skew.ts`) see a
 * mismatch while the real align-core code (dsl, scanner, orchestrator) still resolves and runs
 * normally underneath — needed because BUG #17's regression can only be exercised through a real
 * `align_check` MCP call, not a unit test of the detector alone (see `version-skew.test.ts` for
 * that).
 */
function nodeModulesWithShadowedCoreVersion(dir: string, fakeVersion: string): void {
  const realNodeModules = path.join(process.cwd(), 'node_modules');
  const tmpNodeModules = path.join(dir, 'node_modules');
  fs.mkdirSync(tmpNodeModules);
  for (const entry of fs.readdirSync(realNodeModules)) {
    if (entry === '@spikedpunch') continue;
    fs.symlinkSync(path.join(realNodeModules, entry), path.join(tmpNodeModules, entry));
  }
  const realScope = path.join(realNodeModules, '@spikedpunch');
  const tmpScope = path.join(tmpNodeModules, '@spikedpunch');
  fs.mkdirSync(tmpScope);
  for (const entry of fs.readdirSync(realScope)) {
    if (entry === 'align-core') continue;
    fs.symlinkSync(path.join(realScope, entry), path.join(tmpScope, entry));
  }
  const realCore = path.join(realScope, 'align-core');
  const tmpCore = path.join(tmpScope, 'align-core');
  fs.mkdirSync(tmpCore);
  for (const entry of fs.readdirSync(realCore)) {
    if (entry === 'package.json') continue;
    fs.symlinkSync(path.join(realCore, entry), path.join(tmpCore, entry));
  }
  const corePkg = JSON.parse(fs.readFileSync(path.join(realCore, 'package.json'), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(path.join(tmpCore, 'package.json'), JSON.stringify({ ...corePkg, version: fakeVersion }));
}

function writeMinimalAlignRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/index.ts'), `export const x = 1;\n`, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\nexport default defineProject({ components: { app: 'src/**' } });\n`,
    'utf8',
  );
}

describe('align mcp — align_check', () => {
  it('returns a structured-only payload with the expected shape on a red fixture', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({ name: 'align_check', arguments: {} });
    const payload = JSON.parse(textOf(result)) as {
      verdict: string;
      gates: { gate: string; violationCount: number }[];
      violations: unknown[];
      advisories: unknown[];
    };
    expect(payload.verdict).toBe('red');
    expect(payload.gates.map((g) => g.gate)).toEqual(['parse', 'architecture', 'security']);
    expect(payload.violations).toHaveLength(1);
    // Structured-fields-only (ADR 007): no `message` prose field on the machine payload.
    expect(payload.violations[0]).not.toHaveProperty('message');
  });

  it('never includes a mermaid field — diagrams are explain-only (ADR 007 pull-on-demand)', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({ name: 'align_check', arguments: {} });
    const text = textOf(result);
    expect(text).not.toContain('mermaid');
  });

  it('green fixture reports zero violations and passCount, not per-item text', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app'));
    const result = await client.callTool({ name: 'align_check', arguments: {} });
    const payload = JSON.parse(textOf(result)) as { verdict: string; violations: unknown[] };
    expect(payload.verdict).toBe('green');
    expect(payload.violations).toHaveLength(0);
  });

  it('a red response for a small violation set stays well under ~1K tokens (ADR 007 budget, ~4 chars/token heuristic)', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({ name: 'align_check', arguments: {} });
    const text = textOf(result);
    const approxTokens = text.length / 4;
    expect(approxTokens).toBeLessThan(1000);
  });

  // R1 (greenfield mode, IMPLEMENTATION_PLAN.md Design Reserve): the MCP payload is built by the
  // same `buildMcpCheckPayload` the CLI's `--json` uses, so `ungroundedComponents` must show up
  // here too — an agent driving align exclusively through MCP (no CLI) must see the same
  // green-but-ungrounded signal a human running `align check` in a terminal would.
  it('exposes ungroundedComponents on an otherwise-green run with an until-populated component', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-mcp-greenfield-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'src', 'app'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/app/index.ts'), `export const x = 1;\n`, 'utf8');
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(dir, 'align.config.ts'),
        `import { defineProject } from '@spikedpunch/align-core/dsl';\n` +
          `export default defineProject({ components: { api: { pattern: 'src/api/**', empty: 'until-populated' }, app: 'src/app/**' } });\n`,
        'utf8',
      );
      fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(dir, 'node_modules'), 'dir');

      const client = await connectedClient(dir);
      const result = await client.callTool({ name: 'align_check', arguments: {} });
      const payload = JSON.parse(textOf(result)) as {
        verdict: string;
        ungroundedComponents: { name: string; selector: string; policy: string }[];
      };
      expect(payload.verdict).toBe('green');
      expect(payload.ungroundedComponents).toEqual([{ name: 'api', selector: 'src/api/**', policy: 'until-populated' }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('align mcp — version-skew advisory carried into the payload (BUG #17)', () => {
  // `freshCheck` (`mcp/server.ts`) is the shared plumbing behind both `align_check` and
  // `align_violations` — `withVersionSkew` (`version-skew.ts`, lifted out of `commands/check.ts`)
  // is applied there so this fires for both. `align_violations`'s response only ever forwards
  // `{ violations, pagination }` (see its handler), never an `advisories` field at all — that's a
  // pre-existing, deliberate scope decision (it's a violations list, not a check summary), not
  // something this fix changes, so only `align_check` is asserted on here.
  it('align_check carries a version-skew advisory when the repo-installed align-core differs from the running binary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-mcp-skew-test-'));
    try {
      writeMinimalAlignRepo(dir);
      nodeModulesWithShadowedCoreVersion(dir, '0.0.1-mismatched');

      const client = await connectedClient(dir);
      const result = await client.callTool({ name: 'align_check', arguments: {} });
      const payload = JSON.parse(textOf(result)) as { advisories: { kind: string; message: string }[] };
      const skew = payload.advisories.find((a) => a.kind === 'version-skew');
      expect(skew).toBeDefined();
      expect(skew?.message).toContain(ALIGN_VERSION);
      expect(skew?.message).toContain('0.0.1-mismatched');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('align_check carries no version-skew advisory when the repo-installed align-core matches the running binary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-mcp-skew-test-'));
    try {
      writeMinimalAlignRepo(dir);
      nodeModulesWithShadowedCoreVersion(dir, ALIGN_VERSION);

      const client = await connectedClient(dir);
      const result = await client.callTool({ name: 'align_check', arguments: {} });
      const payload = JSON.parse(textOf(result)) as { advisories: { kind: string }[] };
      expect(payload.advisories.some((a) => a.kind === 'version-skew')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('align mcp — align_violations', () => {
  it('returns violations and pagination fields only', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({ name: 'align_violations', arguments: {} });
    const payload = JSON.parse(textOf(result)) as { violations: unknown[] };
    expect(payload.violations).toHaveLength(1);
  });
});

describe('align mcp — align_explain_rule', () => {
  it('explains a known rule with its components and because text', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({
      name: 'align_explain_rule',
      arguments: { ruleId: 'arch.no-dependency:api->ui' },
    });
    const payload = JSON.parse(textOf(result)) as { ruleId: string; because?: string; components: { name: string }[] };
    expect(payload.ruleId).toBe('arch.no-dependency:api->ui');
    expect(payload.because).toBe('The API must remain headless.');
    expect(payload.components.map((c) => c.name).sort()).toEqual(['api', 'ui']);
  });

  it('reports an error for an unknown rule id rather than throwing', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({ name: 'align_explain_rule', arguments: { ruleId: 'no-such-rule' } });
    expect(result.isError).toBe(true);
  });

  it('includes a fenced Mermaid diagram for a rule with a live violation', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({
      name: 'align_explain_rule',
      arguments: { ruleId: 'arch.no-dependency:api->ui' },
    });
    const payload = JSON.parse(textOf(result)) as { mermaid?: string };
    expect(payload.mermaid).toBeDefined();
    expect(payload.mermaid).toContain('```mermaid');
    expect(payload.mermaid).toContain('graph LR');
  });

  it('omits mermaid for a rule with no current violation to diagram', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app'));
    const result = await client.callTool({ name: 'align_explain_rule', arguments: { ruleId: 'arch.no-cycles:repo' } });
    const payload = JSON.parse(textOf(result)) as { mermaid?: string };
    expect(payload.mermaid).toBeUndefined();
  });
});

describe('align mcp — align_propose_rules (ADR 011 two-pass clarification)', () => {
  it('pass 1 (doc_path only) classifies sections and never invents concerns for prose', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'build-app-mcp'));
    const result = await client.callTool({
      name: 'align_propose_rules',
      arguments: { doc_path: 'docs/ARCHITECTURE-RULES.md' },
    });
    const payload = JSON.parse(textOf(result)) as {
      sections: { anchor: string; tier: string }[];
      deterministicRules: { id: string }[];
      proseSections: { anchor: string; concerns: string[] }[];
    };
    const byAnchor = new Map(payload.sections.map((s) => [s.anchor, s.tier]));
    expect(byAnchor.get('api-isolation')).toBe('bullet');
    expect(byAnchor.get('no-cycles')).toBe('verbatim');
    expect(byAnchor.get('module-size')).toBe('prose');
    expect(payload.deterministicRules.map((r) => r.id).sort()).toEqual(['arch.no-cycles:repo', 'arch.no-dependency:api->ui']);
    expect(payload.proseSections).toHaveLength(1);
    expect(payload.proseSections[0]?.concerns).toEqual([]); // align never invents concerns
  });

  it('pass 2 (proposals, no apply) validates, grounds, and dry-runs without writing', async () => {
    const rootDir = path.join(fixturesDir, 'build-app-mcp');
    const client = await connectedClient(rootDir);
    const result = await client.callTool({
      name: 'align_propose_rules',
      arguments: {
        doc_path: 'docs/ARCHITECTURE-RULES.md',
        proposals: [
          {
            section: 'api-isolation',
            fragment: { kind: 'arch.no-dependency', from: 'api', to: 'ui' },
            sourceLineRange: { startLine: 5, endLine: 5 },
            sourceQuote: '`api` must not depend on `ui`.',
          },
        ],
      },
    });
    const payload = JSON.parse(textOf(result)) as { accepted: { id: string }[]; diff: { added: string[] } };
    expect(payload.accepted.map((r) => r.id)).toContain('arch.no-dependency:api->ui');
    expect(fs.existsSync(path.join(rootDir, '.align/generated-rules.json'))).toBe(false);
  });

  it('flags an ungroundable proposal instead of accepting it', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'build-app-mcp'));
    const result = await client.callTool({
      name: 'align_propose_rules',
      arguments: {
        doc_path: 'docs/ARCHITECTURE-RULES.md',
        proposals: [
          {
            section: 'module-size',
            fragment: { kind: 'arch.no-dependency', from: 'api', to: 'nonexistent' },
            sourceLineRange: { startLine: 13, endLine: 13 },
            sourceQuote: 'modules should stay small',
          },
        ],
      },
    });
    const payload = JSON.parse(textOf(result)) as { flaggedUngroundable: { reason: string }[] };
    expect(payload.flaggedUngroundable.some((f) => f.reason === 'ungroundable-selector')).toBe(true);
  });

  it('flags a custom.host proposal as unregistered-host-rule instead of accepting it vacuously', async () => {
    // Regression for the live align_propose_rules session that accepted a custom.host proposal
    // whose hostRuleName matched no predicate anywhere — grounding validated components but not
    // host predicates, so the dry-run reported "adds 0 new violations" vacuously and, once
    // written, check would have counted the rule as passing forever. This fixture's
    // align.config.ts DOES register 'route-thinness' (see the sibling test below) — this test
    // uses a genuinely different, never-registered name to prove "unregistered still errors"
    // survived adding the registration surface.
    const client = await connectedClient(path.join(fixturesDir, 'build-app-mcp'));
    const result = await client.callTool({
      name: 'align_propose_rules',
      arguments: {
        doc_path: 'docs/ARCHITECTURE-RULES.md',
        proposals: [
          {
            section: 'module-size',
            fragment: { kind: 'custom.host', hostRuleName: 'totally-unregistered-predicate' },
            sourceLineRange: { startLine: 13, endLine: 13 },
            sourceQuote: 'route handlers stay thin',
          },
        ],
      },
    });
    const payload = JSON.parse(textOf(result)) as { accepted: { id: string }[]; flaggedUngroundable: { reason: string; detail: string }[] };
    expect(payload.accepted.some((r) => r.id.includes('totally-unregistered-predicate'))).toBe(false);
    const flagged = payload.flaggedUngroundable.find((f) => f.reason === 'unregistered-host-rule');
    expect(flagged).toBeDefined();
    expect(flagged?.detail).toContain("'totally-unregistered-predicate'");
  });

  it('grounds a custom.host proposal into a real rule when align.config.ts registers the predicate (registration surface, §B.0)', async () => {
    // This fixture's align.config.ts exports `hostRules: { 'route-thinness': ... }` — proposing
    // the SAME shape as the test above, but with the name it actually registers, must now ground
    // successfully instead of being flagged.
    const client = await connectedClient(path.join(fixturesDir, 'build-app-mcp'));
    const result = await client.callTool({
      name: 'align_propose_rules',
      arguments: {
        doc_path: 'docs/ARCHITECTURE-RULES.md',
        proposals: [
          {
            section: 'module-size',
            fragment: { kind: 'custom.host', hostRuleName: 'route-thinness' },
            sourceLineRange: { startLine: 13, endLine: 13 },
            sourceQuote: 'route handlers stay thin',
          },
        ],
      },
    });
    const payload = JSON.parse(textOf(result)) as { accepted: { id: string; kind: string }[]; flaggedUngroundable: { reason: string }[] };
    expect(payload.flaggedUngroundable.some((f) => f.reason === 'unregistered-host-rule')).toBe(false);
    const accepted = payload.accepted.find((r) => r.id.includes('route-thinness'));
    expect(accepted).toBeDefined();
    expect(accepted?.kind).toBe('custom.host');
  });

  it('{ apply: true } writes generated-rules.json, rules.lock.json, and the audit report', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-mcp-build-test-'));
    fs.cpSync(path.join(fixturesDir, 'build-app-mcp'), rootDir, { recursive: true });
    try {
      const client = await connectedClient(rootDir);
      const result = await client.callTool({
        name: 'align_propose_rules',
        arguments: { doc_path: 'docs/ARCHITECTURE-RULES.md', proposals: [], apply: true },
      });
      const payload = JSON.parse(textOf(result)) as { applied: boolean };
      expect(payload.applied).toBe(true);
      expect(fs.existsSync(path.join(rootDir, '.align/generated-rules.json'))).toBe(true);
      expect(fs.existsSync(path.join(rootDir, '.align/rules.lock.json'))).toBe(true);
      expect(fs.existsSync(path.join(rootDir, '.align/last-build-report.md'))).toBe(true);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('align mcp — server instructions (Stage 5, condensed fixing skill)', () => {
  it('declares non-empty instructions within the ~30-line MCP budget, mentioning the fix-loop protocol', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app'));
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).not.toHaveLength(0);
    const lineCount = (instructions ?? '').split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(30);
    expect(instructions).toContain('align_check');
    expect(instructions).toMatch(/red/i);
  });
});
