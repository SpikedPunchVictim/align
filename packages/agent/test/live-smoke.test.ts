/**
 * Optional live smoke test — the ONLY test in this package that makes a real network call.
 * Skips gracefully (never fails the suite) unless BOTH `ALIGN_LIVE_SMOKE=1` and `ANTHROPIC_API_KEY`
 * are set. Per the task brief: this environment is expected to lack API credits, so nothing here
 * may ever be depended on by CI or by any other test's pass/fail status.
 */
import { describe, expect, it } from 'vitest';
import { toRepoRelativePath, toRuleId, toViolationId } from '@spikedpunch/align-core';
import { AnthropicFixProvider } from '../src/anthropicFixProvider.js';

const shouldRun = process.env['ALIGN_LIVE_SMOKE'] === '1' && Boolean(process.env['ANTHROPIC_API_KEY']);

describe.skipIf(!shouldRun)('AnthropicFixProvider — live smoke (ALIGN_LIVE_SMOKE=1)', () => {
  it('proposes a schema-valid fix for a trivially seeded violation', async () => {
    const provider = new AnthropicFixProvider();
    const file = toRepoRelativePath('src/example.ts');
    const proposal = await provider.proposeFix({
      violations: [
        {
          id: toViolationId('live-smoke-v1'),
          ruleId: toRuleId('arch.no-dependency'),
          category: 'architecture',
          severity: 'error',
          file,
          range: { startLine: 1, endLine: 1 },
          snippet: `import { forbidden } from '../other/module.js';`,
          fixHint: { code: 'remove-import', file, line: 1 },
          kind: 'no-dependency',
          fromFile: file,
          toFile: toRepoRelativePath('src/other/module.ts'),
          fromComponent: 'a' as never,
          toComponent: 'b' as never,
          specifier: '../other/module.js',
          line: 1,
        },
      ],
      fileContents: new Map([
        [file, `import { forbidden } from '../other/module.js';\n\nexport function run(): void {}\n`],
      ]),
      condensedSymbolTable: [],
      ruleExplanations: [{ ruleId: toRuleId('arch.no-dependency'), kind: 'arch.no-dependency', because: 'a must not depend on b' }],
    });

    expect(proposal.files.length).toBeGreaterThan(0);
    expect(typeof proposal.rationale).toBe('string');

    // Telemetry's `agent.usage` field (IMPLEMENTATION_PLAN.md's telemetry spec): a real call must
    // have populated real, non-fabricated token counts — the one place this can be verified
    // against an actual `@anthropic-ai/sdk` response rather than a fake.
    const usage = provider.getUsageTotals();
    expect(usage).toBeDefined();
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
  }, 60_000);
});
