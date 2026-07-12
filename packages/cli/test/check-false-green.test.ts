import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { baselineAccept } from '../src/commands/baseline.js';

// Split out of check.test.ts (which was pushing past the dogfooded `arch.metric` max-500-line
// rule, docs/ARCHITECTURE-RULES.md) — false-green-guard coverage is already a distinct concern
// from the rest of `align check`'s behavior, so this is a genuine cohesion split, not a
// LOC-limit-driven arbitrary cut.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('align check — stale generated-rules.json false-green guard (RULESET_REPORT.md §0)', () => {
  function writeGeneratedRules(dir: string, rules: unknown[]): void {
    fs.mkdirSync(path.join(dir, '.align'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.align/generated-rules.json'),
      `${JSON.stringify({ irVersion: '1', docPath: 'docs/ARCHITECTURE-RULES.md', generatedAt: Date.now(), rules }, null, 2)}\n`,
      'utf8',
    );
  }

  async function readJson(
    run: () => Promise<number>,
  ): Promise<{ code: number; payload: { verdict: string; gates: { gate: string; status: string; violationCount?: number }[]; violations?: unknown[] } }> {
    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await run();
    } finally {
      process.stdout.write = originalWrite;
    }
    return {
      code,
      payload: JSON.parse(logs.join('')) as {
        verdict: string;
        gates: { gate: string; status: string; violationCount?: number }[];
        violations?: unknown[];
      },
    };
  }

  /** `errorMessage` is deliberately excluded from the `--json` McpCheckPayload (ADR 007: error
   * text never enters an LLM-facing payload — `payload/builder.ts`'s `buildMcpCheckPayload`
   * strips it) but IS printed in the human-readable `--json`-less path (`printHuman`,
   * `commands/check.ts`) — captured here via `console.log` instead of `process.stdout.write`. */
  async function readHumanOutput(run: () => Promise<number>): Promise<{ code: number; text: string }> {
    const logs: string[] = [];
    const originalLog = console.log;
    // eslint-disable-next-line no-console
    console.log = ((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    }) as typeof console.log;
    let code: number;
    try {
      code = await run();
    } finally {
      console.log = originalLog;
    }
    return { code, text: logs.join('\n') };
  }

  it('(a) a generated rule referencing a removed component errors — never green, exit != 0', async () => {
    tmpDir = copyFixture('simple-app'); // components: { app: 'src/**' }, no removed-component rule
    writeGeneratedRules(tmpDir, [
      { kind: 'arch.no-dependency', id: 'stale:app->deleted-component', from: 'app', to: 'deleted-component', provenance: {} },
    ]);

    const { code, payload } = await readJson(() => runCheck(tmpDir, { json: true }));
    expect(code).not.toBe(0);
    expect(payload.verdict).not.toBe('green');
    expect(payload.verdict).toBe('error');
    const archGate = payload.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.status).toBe('error');

    // Human (non-JSON) output must agree with the JSON verdict — no exit-code/verdict divergence
    // (the fa4296c class of bug: `align check --frozen-rules` once flipped exit code without
    // flipping the reported verdict) — and must name the rule id, the missing component, and the
    // likely cause (ADR 008).
    const human = await readHumanOutput(() => runCheck(tmpDir, { json: false }));
    expect(human.code).not.toBe(0);
    expect(human.text).toContain('stale:app->deleted-component');
    expect(human.text).toContain('deleted-component');
    expect(human.text).toContain('align build');
    expect(human.text).toContain('verdict: error');
  });

  it('(b) a generated rule referencing a renamed component errors the same way', async () => {
    tmpDir = copyFixture('simple-app');
    // align.config.ts's only component is `app`; simulate a rename away from an old name
    // (`legacy-app`) that a not-yet-rebuilt generated-rules.json still references.
    writeGeneratedRules(tmpDir, [
      { kind: 'arch.no-cycles', id: 'stale:legacy-app-cycles', scope: 'legacy-app', includeTypeOnly: false, provenance: {} },
    ]);

    const { code, payload } = await readJson(() => runCheck(tmpDir, { json: true }));
    expect(code).not.toBe(0);
    expect(payload.verdict).toBe('error');
    const archGate = payload.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.status).toBe('error');

    const human = await readHumanOutput(() => runCheck(tmpDir, { json: false }));
    expect(human.text).toContain('legacy-app');
  });

  it('(c) generated rules referencing valid, current components still check green', async () => {
    tmpDir = copyFixture('simple-app');
    writeGeneratedRules(tmpDir, [{ kind: 'arch.no-cycles', id: 'generated:app-cycles', scope: 'app', includeTypeOnly: false, provenance: {} }]);

    const { code, payload } = await readJson(() => runCheck(tmpDir, { json: true }));
    expect(code).toBe(0);
    expect(payload.verdict).toBe('green');
  });

  it('(d) a hand-written rule (align.config.ts) referencing an unknown component errors the same way', async () => {
    tmpDir = copyFixture('simple-app');
    // Bypasses the DSL's compile-time component-token safety the way a hand-edited/merged
    // RulesetIR could — the same runtime gap `mergeGeneratedRules` output shares.
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import type { RulesetIR } from '@align/core';\n\n` +
        `const ruleset: RulesetIR = {\n` +
        `  irVersion: '1',\n` +
        `  components: { app: { name: 'app', selector: { kind: 'glob', patterns: ['src/**'] }, allowEmpty: false } },\n` +
        `  rules: [{ kind: 'arch.no-dependency', id: 'hand:app->ghost', from: 'app', to: 'ghost', provenance: {} }],\n` +
        `};\n\nexport default ruleset;\n`,
      'utf8',
    );

    const { code, payload } = await readJson(() => runCheck(tmpDir, { json: true }));
    expect(code).not.toBe(0);
    expect(payload.verdict).toBe('error');
    const archGate = payload.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.status).toBe('error');

    const human = await readHumanOutput(() => runCheck(tmpDir, { json: false }));
    expect(human.text).toContain('hand:app->ghost');
    expect(human.text).toContain('ghost');
  });

  it('(e) a generated custom.host rule naming an unregistered predicate errors — never a vacuous pass', async () => {
    tmpDir = copyFixture('simple-app');
    // The shape the live align_propose_rules session produced before grounding flagged it:
    // a custom.host rule written to generated-rules.json whose predicate exists nowhere
    // (v1 has no host predicate mechanism at all) — `evaluateRule` returns [] for the kind,
    // so pre-fix this counted as a passing rule.
    writeGeneratedRules(tmpDir, [
      { kind: 'custom.host', id: 'custom.host:route-thinness', hostRuleName: 'route-thinness', portable: false, provenance: {} },
    ]);

    const { code, payload } = await readJson(() => runCheck(tmpDir, { json: true }));
    expect(code).not.toBe(0);
    expect(payload.verdict).toBe('error');
    const archGate = payload.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.status).toBe('error');

    const human = await readHumanOutput(() => runCheck(tmpDir, { json: false }));
    expect(human.text).toContain('custom.host:route-thinness');
    expect(human.text).toContain("'route-thinness'");
    expect(human.text).toContain('verdict: error');
  });

  it('(f) a hand-written custom.host rule (raw RulesetIR in align.config.ts) errors the same way', async () => {
    tmpDir = copyFixture('simple-app');
    // The DSL has no custom.host verb, so a raw RulesetIR export is the only hand-written route.
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import type { RulesetIR } from '@align/core';\n\n` +
        `const ruleset: RulesetIR = {\n` +
        `  irVersion: '1',\n` +
        `  components: { app: { name: 'app', selector: { kind: 'glob', patterns: ['src/**'] }, allowEmpty: false } },\n` +
        `  rules: [{ kind: 'custom.host', id: 'custom.host:hand-rolled', hostRuleName: 'hand-rolled', portable: false, provenance: {} }],\n` +
        `};\n\nexport default ruleset;\n`,
      'utf8',
    );

    const { code, payload } = await readJson(() => runCheck(tmpDir, { json: true }));
    expect(code).not.toBe(0);
    expect(payload.verdict).toBe('error');
    const archGate = payload.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.status).toBe('error');

    const human = await readHumanOutput(() => runCheck(tmpDir, { json: false }));
    expect(human.text).toContain('custom.host:hand-rolled');
    expect(human.text).toContain("'hand-rolled'");
  });

  it('(g) a registered custom.host predicate fires end-to-end through the real CLI composition root (registration surface, §B.0)', async () => {
    tmpDir = copyFixture('simple-app');
    // Overwrites the copied fixture's config with one that registers a predicate flagging
    // `src/a.ts` — exercises the real path (config.ts's `hostRules` extraction ->
    // composition-root.ts's injection -> GateOrchestrator -> evaluateCustomHost), not a
    // synthetic in-memory orchestrator like the core-level e2e test.
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import { defineProject } from '@align/core/dsl';\n` +
        `import type { HostPredicate } from '@align/core';\n\n` +
        `export const hostRules: Record<string, HostPredicate> = {\n` +
        `  'flag-a': (ctx) => ctx.files.filter((f) => f.endsWith('a.ts')).map((f) => ({ file: f, message: 'a.ts is flagged by the registered predicate' })),\n` +
        `};\n\n` +
        `export default defineProject({\n` +
        `  components: { app: 'src/**' },\n` +
        `  rules: (c) => [c.custom.host('flag-a').because('dogfood: registered predicate fires')],\n` +
        `});\n`,
      'utf8',
    );

    const { code, payload } = await readJson(() => runCheck(tmpDir, { json: true }));
    expect(code).toBe(1);
    expect(payload.verdict).toBe('red');
    const archGate = payload.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.status).toBe('red');
    expect(archGate?.violationCount).toBe(1);
    expect(payload.violations).toHaveLength(1);
    expect(payload.violations[0]).toMatchObject({
      kind: 'custom',
      ruleId: 'custom.host:flag-a',
      hostRuleName: 'flag-a',
      detail: 'a.ts is flagged by the registered predicate',
      because: 'dogfood: registered predicate fires',
    });

    // Baseline-able through the real `align baseline accept` path, same as any other violation.
    expect(await baselineAccept(tmpDir)).toBe(0);
    const greenAfterBaseline = await runCheck(tmpDir, { json: false });
    expect(greenAfterBaseline).toBe(0);
  });
});
