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
      `import { defineProject } from '@spikedpunch/align-core/dsl';\n\n` +
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
      `import { defineProject } from '@spikedpunch/align-core/dsl';\n\n` +
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
      `import { defineProject } from '@spikedpunch/align-core/dsl';\n\n` +
        `export default defineProject({\n` +
        `  components: { app: 'src/**', ghost: { pattern: 'src/ghost/**', allowEmpty: true } },\n` +
        `  rules: (c) => [c.arch.layer(c.app).cannotDependOn(c.ghost)],\n` +
        `});\n`,
      'utf8',
    );
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });
});

describe('align check — R1 ungrounded-component surfacing (greenfield mode)', () => {
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

  function writeUntilPopulatedConfig(dir: string): void {
    // `api` declared BEFORE the `src/**` catch-all `app` — classification is first-match-wins
    // (ADR 003), so the more specific selector must come first or `app` would shadow every file
    // that would otherwise classify as `api`, same convention align's own align.config.ts uses.
    fs.writeFileSync(
      path.join(dir, 'align.config.ts'),
      `import { defineProject } from '@spikedpunch/align-core/dsl';\n\n` +
        `export default defineProject({\n` +
        `  components: { api: { pattern: 'src/api/**', empty: 'until-populated' }, app: 'src/**' },\n` +
        `  rules: (c) => [c.arch.layer(c.app).cannotDependOn(c.api)],\n` +
        `});\n`,
      'utf8',
    );
  }

  it("green-but-ungrounded is visible as a distinct line near the verdict — not indistinguishable from clean green", async () => {
    tmpDir = copyFixture('simple-app');
    writeUntilPopulatedConfig(tmpDir);
    const { code, text } = await readHuman(() => runCheck(tmpDir, { json: false }));
    expect(code).toBe(0);
    expect(text).toContain('verdict: green');
    expect(text).toMatch(/matched no files \(ungrounded, provisionally green\).*api/);
  });

  it('a clean, fully-grounded green run has no ungrounded line at all', async () => {
    tmpDir = copyFixture('simple-app');
    const { code, text } = await readHuman(() => runCheck(tmpDir, { json: false }));
    expect(code).toBe(0);
    expect(text).not.toContain('ungrounded');
  });

  it('--json exposes ungroundedComponents as a structured {name, selector, policy} array', async () => {
    tmpDir = copyFixture('simple-app');
    writeUntilPopulatedConfig(tmpDir);
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
    const payload = JSON.parse(logs.join('')) as {
      verdict: string;
      ungroundedComponents: { name: string; selector: string; policy: string }[];
    };
    expect(payload.verdict).toBe('green');
    expect(payload.ungroundedComponents).toEqual([{ name: 'api', selector: 'src/api/**', policy: 'until-populated' }]);
  });

  it('the ungrounded surfacing disappears once the component is populated (auto-arm, R2)', async () => {
    tmpDir = copyFixture('simple-app');
    writeUntilPopulatedConfig(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'src/api'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/api/index.ts'), `export function handler(): string {\n  return 'ok';\n}\n`, 'utf8');

    const { code, text } = await readHuman(() => runCheck(tmpDir, { json: false }));
    expect(code).toBe(0);
    expect(text).not.toContain('ungrounded');
    expect(text).toContain('verdict: green');
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
