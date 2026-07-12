import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { baselineAccept, baselinePrune, baselineShow } from '../src/commands/baseline.js';
import { readBaseline } from '../src/align-dir.js';

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

describe('align check', () => {
  it('exits 0 on a clean fixture', async () => {
    tmpDir = copyFixture('simple-app');
    const code = await runCheck(tmpDir, { json: false });
    expect(code).toBe(0);
  });

  it('exits 1 on a fixture with a seeded violation', async () => {
    tmpDir = copyFixture('simple-app-violation');
    const code = await runCheck(tmpDir, { json: false });
    expect(code).toBe(1);
  });

  it('--json produces the structured McpCheckPayload shape', async () => {
    tmpDir = copyFixture('simple-app-violation');
    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCheck(tmpDir, { json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    const payload = JSON.parse(logs.join('')) as { verdict: string; gates: unknown[]; violations: unknown[] };
    expect(payload.verdict).toBe('red');
    expect(Array.isArray(payload.gates)).toBe(true);
    expect(Array.isArray(payload.violations)).toBe(true);
    expect(payload.violations).toHaveLength(1);
  });

  it('freshness: fixing the violation on disk turns the next check green with no restart', async () => {
    tmpDir = copyFixture('simple-app-violation');
    expect(await runCheck(tmpDir, { json: false })).toBe(1);

    // The "fix": remove the forbidden import.
    fs.writeFileSync(
      path.join(tmpDir, 'src/api/service.ts'),
      `export function handleRequest(): string {\n  return 'ok';\n}\n`,
      'utf8',
    );
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });
});

describe('align check — arch.metric (max-LOC, promoted 2026-07-12 on kluster ruleset evidence)', () => {
  it('a file over the max-LOC threshold fires a violation naming actual vs. max LOC; a file under it stays clean', async () => {
    tmpDir = copyFixture('simple-app-metric-violation');
    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await runCheck(tmpDir, { json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(code).toBe(1);
    const payload = JSON.parse(logs.join('')) as {
      verdict: string;
      violations: { kind: string; file: string; ruleId: string }[];
    };
    expect(payload.verdict).toBe('red');
    expect(payload.violations).toHaveLength(1); // only src/big.ts (8 lines); src/small.ts (4 lines) stays clean
    const v = payload.violations[0];
    expect(v?.kind).toBe('metric');
    expect(v?.file).toBe('src/big.ts');
    expect(v?.ruleId).toBe('arch.metric:loc:app');

    const human = await (async (): Promise<string> => {
      const humanLogs: string[] = [];
      const originalLog = console.log;
      // eslint-disable-next-line no-console
      console.log = ((...args: unknown[]) => {
        humanLogs.push(args.map(String).join(' '));
      }) as typeof console.log;
      try {
        await runCheck(tmpDir, { json: false });
      } finally {
        console.log = originalLog;
      }
      return humanLogs.join('\n');
    })();
    expect(human).toContain('src/big.ts');
    expect(human).toContain('8 lines');
    expect(human).toContain('5 lines');
    expect(human).toContain('arch.metric:loc:app');
  });

  it('fixing the file (shrinking it under the threshold) turns the next check green with no restart', async () => {
    tmpDir = copyFixture('simple-app-metric-violation');
    expect(await runCheck(tmpDir, { json: false })).toBe(1);
    fs.writeFileSync(path.join(tmpDir, 'src/big.ts'), `export function a(): number {\n  return 1;\n}\n`, 'utf8');
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });
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

  async function readJson(run: () => Promise<number>): Promise<{ code: number; payload: { verdict: string; gates: { gate: string; status: string }[] } }> {
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
    return { code, payload: JSON.parse(logs.join('')) as { verdict: string; gates: { gate: string; status: string }[] } };
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
});

describe('align check — empty-component false-green guard (ADR 003 empty-selector-fails-by-default)', () => {
  async function readHuman(run: () => Promise<number>): Promise<{ code: number; text: string }> {
    const logs: string[] = [];
    const originalLog = console.log;
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

  it('a component whose selector matches zero files errors (scanner-level validateComponents), naming it — never green', async () => {
    tmpDir = copyFixture('simple-app');
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import { defineProject } from '@align/core/dsl';\n\n` +
        `export default defineProject({\n` +
        `  components: { app: 'src/**', ghost: 'src/ghost/**' },\n` +
        `  rules: (c) => [c.arch.layer(c.app).cannotDependOn(c.ghost)],\n` +
        `});\n`,
      'utf8',
    );
    const { code, text } = await readHuman(() => runCheck(tmpDir, { json: false }));
    expect(code).not.toBe(0);
    expect(text).toContain('verdict: error');
    expect(text).toContain("'ghost'");
    expect(text).toContain('allowEmpty');
  });

  it('a component fully shadowed by an earlier first-match-wins selector errors (orchestrator-level guard) — was silently green before', async () => {
    tmpDir = copyFixture('simple-app');
    // `shadowed`'s selector DOES match files, so selector-based validateComponents passes — but
    // `app` (declared first) claims every one of them, so zero files classify as `shadowed` and
    // the rule referencing it would evaluate vacuously green.
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import { defineProject } from '@align/core/dsl';\n\n` +
        `export default defineProject({\n` +
        `  components: { app: 'src/**', shadowed: 'src/**' },\n` +
        `  rules: (c) => [c.arch.layer(c.shadowed).cannotDependOn(c.app)],\n` +
        `});\n`,
      'utf8',
    );
    const { code, text } = await readHuman(() => runCheck(tmpDir, { json: false }));
    expect(code).not.toBe(0);
    expect(text).toContain('verdict: error');
    expect(text).toContain("'shadowed'");
    expect(text).toContain('first-match-wins');
    expect(text).toContain('allowEmpty');
  });

  it('the same zero-file component with allowEmpty: true stays green (documented opt-out)', async () => {
    tmpDir = copyFixture('simple-app');
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import { defineProject } from '@align/core/dsl';\n\n` +
        `export default defineProject({\n` +
        `  components: { app: 'src/**', ghost: { pattern: 'src/ghost/**', allowEmpty: true } },\n` +
        `  rules: (c) => [c.arch.layer(c.app).cannotDependOn(c.ghost)],\n` +
        `});\n`,
      'utf8',
    );
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });
});

describe('align baseline', () => {
  it('accept seeds the baseline and turns check green; prune removes it once fixed', async () => {
    tmpDir = copyFixture('simple-app-violation');
    expect(await runCheck(tmpDir, { json: false })).toBe(1);

    await baselineAccept(tmpDir, undefined);
    expect(readBaseline(tmpDir)).toHaveLength(1);
    expect(await runCheck(tmpDir, { json: false })).toBe(0);

    fs.writeFileSync(
      path.join(tmpDir, 'src/api/service.ts'),
      `export function handleRequest(): string {\n  return 'ok';\n}\n`,
      'utf8',
    );
    await baselinePrune(tmpDir);
    expect(readBaseline(tmpDir)).toHaveLength(0);
  });

  it('accept --rule only accepts violations of the named rule', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await baselineAccept(tmpDir, 'nonexistent-rule');
    expect(readBaseline(tmpDir)).toHaveLength(0);
    expect(await runCheck(tmpDir, { json: false })).toBe(1);
  });

  it('show lists baselined entries', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await baselineAccept(tmpDir, undefined);
    const code = await baselineShow(tmpDir, undefined);
    expect(code).toBe(0);
  });
});

describe('align baseline — move detection (ADR 006, carried-over Stage 1 gap)', () => {
  it('renaming a file with a baselined violation stays green on `align check` and reports the transfer', async () => {
    tmpDir = copyFixture('simple-app-violation');
    expect(await runCheck(tmpDir, { json: false })).toBe(1);
    await baselineAccept(tmpDir, undefined);
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
    const before = readBaseline(tmpDir);
    expect(before).toHaveLength(1);
    const originalFingerprint = before[0]?.fingerprint;

    // Rename the offending file — the import content/snippet is unchanged.
    fs.renameSync(path.join(tmpDir, 'src/api/service.ts'), path.join(tmpDir, 'src/api/renamed.ts'));

    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await runCheck(tmpDir, { json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(code).toBe(0); // stays green across the rename — no orphaned baseline entry
    const payload = JSON.parse(logs.join('')) as { verdict: string; advisories: { kind: string; message: string }[] };
    expect(payload.verdict).toBe('green');
    const advisory = payload.advisories.find((a) => a.kind === 'baseline-moved');
    expect(advisory?.message).toBe('1 entry transferred (file moves).');

    // The transfer is persisted: the baseline entry now points at the renamed file under a new
    // fingerprint, and a second check (fresh load from disk) stays green with no further transfer.
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.file).toBe('src/api/renamed.ts');
    expect(after[0]?.fingerprint).not.toBe(originalFingerprint);
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });

  it('a genuinely new identical-snippet violation in a second file is NOT swallowed as a move', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await baselineAccept(tmpDir, undefined);
    expect(await runCheck(tmpDir, { json: false })).toBe(0);

    // Original violation file is untouched; a second, unrelated api file makes the same forbidden
    // import. Both fingerprints must remain live — the new one surfaces as a fresh red violation.
    fs.writeFileSync(
      path.join(tmpDir, 'src/api/service2.ts'),
      `import { render } from '../ui/component.js';\n\nexport function handleOther(): string {\n  return render();\n}\n`,
      'utf8',
    );

    expect(await runCheck(tmpDir, { json: false })).toBe(1);
    const baseline = readBaseline(tmpDir);
    expect(baseline).toHaveLength(1);
    expect(baseline[0]?.file).toBe('src/api/service.ts'); // original entry untouched
  });

  it('`align baseline prune` also transfers moves, in addition to removing fixed entries', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await baselineAccept(tmpDir, undefined);
    fs.renameSync(path.join(tmpDir, 'src/api/service.ts'), path.join(tmpDir, 'src/api/renamed.ts'));

    await baselinePrune(tmpDir);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.file).toBe('src/api/renamed.ts');
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });
});
