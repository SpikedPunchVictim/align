import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { runExportIr } from '../src/commands/export-ir.js';
import { readRulesetIr, rulesetIrPath, writeRulesetIr } from '../src/align-dir.js';

// `align check --untrusted` (ADR 014) — closes the arbitrary-code-execution path in `align check`:
// trusted mode dynamically imports align.config.ts (and invokes any hostRules predicate) on every
// run. These tests exist to PROVE, not just assert, that --untrusted's call graph never reaches
// that import — the decisive test below points --untrusted at a fixture whose align.config.ts
// throws/writes a sentinel file on load, and shows trusted mode is affected while untrusted mode
// is not.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-untrusted-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function withCapturedConsole<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  // eslint-disable-next-line no-console
  console.log = ((...args: unknown[]) => logs.push(args.map(String).join(' '))) as typeof console.log;
  // eslint-disable-next-line no-console
  console.error = ((...args: unknown[]) => errors.push(args.map(String).join(' '))) as typeof console.error;
  try {
    const result = await run();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('align export-ir', () => {
  it('writes .align/ruleset-ir.json with the components + rules from align.config.ts', async () => {
    tmpDir = copyFixture('simple-app');
    const code = await runExportIr(tmpDir);
    expect(code).toBe(0);

    const exported = readRulesetIr(tmpDir);
    expect(exported).toBeDefined();
    expect(exported?.ruleset.components).toEqual({
      app: { name: 'app', selector: { kind: 'glob', patterns: ['src/**'] }, empty: 'fail' },
    });
    expect(exported?.ruleset.rules).toHaveLength(1);
    expect(exported?.ruleset.rules[0]?.kind).toBe('arch.no-cycles');
    expect(fs.existsSync(rulesetIrPath(tmpDir))).toBe(true);
  });

  it('--out writes to a custom path instead of the default', async () => {
    tmpDir = copyFixture('simple-app');
    const code = await runExportIr(tmpDir, { out: 'custom-ir.json' });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'custom-ir.json'))).toBe(true);
    expect(fs.existsSync(rulesetIrPath(tmpDir))).toBe(false);
    const exported = readRulesetIr(tmpDir, 'custom-ir.json');
    expect(exported?.ruleset.rules).toHaveLength(1);
  });

  it('advises when the exported ruleset contains a custom.host rule (still exports it — export-ir has no opinion on trusted-mode content)', async () => {
    tmpDir = copyFixture('simple-app');
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import { defineProject } from '@spikedpunch/align-core/dsl';\n` +
        `import type { HostPredicate } from '@spikedpunch/align-core';\n\n` +
        `export default defineProject({\n` +
        `  components: { app: 'src/**' },\n` +
        `  rules: (c) => [c.custom.host('always-clean')],\n` +
        `});\n\n` +
        `export const hostRules: Record<string, HostPredicate> = { 'always-clean': () => [] };\n`,
      'utf8',
    );
    const { result: code, logs } = await withCapturedConsole(() => runExportIr(tmpDir));
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('custom.host');
    expect(logs.join('\n')).toContain('--untrusted');

    const exported = readRulesetIr(tmpDir);
    expect(exported?.ruleset.rules.some((r) => r.kind === 'custom.host')).toBe(true);
  });
});

describe('align check --untrusted — the proof: never imports align.config.ts', () => {
  const EXPLOIT_MESSAGE = 'EXPLOIT: align.config.ts executed — this must never happen under --untrusted';

  it('sanity check: a throwing align.config.ts really does make trusted mode fail (proves the fixture\'s poison works, on a directory whose config was never imported before — Node\'s ESM module cache is keyed by URL, so re-importing an already-imported path after editing it on disk would misleadingly return the stale, pre-edit module)', async () => {
    const poisoned = copyFixture('simple-app');
    try {
      fs.writeFileSync(path.join(poisoned, 'align.config.ts'), `throw new Error(${JSON.stringify(EXPLOIT_MESSAGE)});\n`, 'utf8');
      await expect(runCheck(poisoned, { json: false })).rejects.toThrow(/EXPLOIT/);
    } finally {
      fs.rmSync(poisoned, { recursive: true, force: true });
    }
  });

  it('the proof: --untrusted succeeds against a poisoned align.config.ts using a previously-exported IR, never importing the poisoned file', async () => {
    tmpDir = copyFixture('simple-app');

    // Export the IR FIRST, while align.config.ts is still well-behaved (this is the trusted step
    // `align export-ir` is meant to run once, ahead of time).
    expect(await runExportIr(tmpDir)).toBe(0);

    // NOW poison the config — this simulates an untrusted repo whose align.config.ts is an
    // attacker-controlled arbitrary-code-execution vector. (This file is never imported again in
    // this test — --untrusted's whole guarantee is that it doesn't need to be.)
    fs.writeFileSync(path.join(tmpDir, 'align.config.ts'), `throw new Error(${JSON.stringify(EXPLOIT_MESSAGE)});\n`, 'utf8');

    // --untrusted reads the already-exported .align/ruleset-ir.json instead of importing
    // align.config.ts — the run succeeds green exactly like it would have before poisoning.
    const code = await runCheck(tmpDir, { json: false, untrusted: true });
    expect(code).toBe(0);
  });

  it('also proves it via a side effect, not just absence-of-throw: a config that writes a sentinel file on import leaves no sentinel after --untrusted', async () => {
    tmpDir = copyFixture('simple-app');
    expect(await runExportIr(tmpDir)).toBe(0);

    const sentinel = path.join(tmpDir, 'pwned.txt');
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import * as fs from 'node:fs';\n` +
        `fs.writeFileSync(${JSON.stringify(sentinel)}, 'align.config.ts executed');\n` +
        `import { defineProject } from '@spikedpunch/align-core/dsl';\n` +
        `export default defineProject({ components: { app: 'src/**' }, rules: (c) => [c.arch.noCycles()] });\n`,
      'utf8',
    );

    const code = await runCheck(tmpDir, { json: false, untrusted: true });
    expect(code).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('scans real repo source (the graph is real, not a stub) even though the config never executes', async () => {
    tmpDir = copyFixture('simple-app-violation');
    expect(await runExportIr(tmpDir)).toBe(0);
    fs.writeFileSync(path.join(tmpDir, 'align.config.ts'), `throw new Error('EXPLOIT');\n`, 'utf8');

    const { result: code } = await withCapturedConsole(() => runCheck(tmpDir, { json: false, untrusted: true }));
    // simple-app-violation's exported ruleset still contains its violation-producing rule; the
    // scanner still finds the real violation in the real source tree — --untrusted removes the
    // config-execution vector, it does not stub out the scan.
    expect(code).toBe(1);
  });
});

describe('align check --untrusted — refuse-don\'t-fallback', () => {
  it('refuses with a clear message when .align/ruleset-ir.json does not exist — never falls back to executing align.config.ts', async () => {
    tmpDir = copyFixture('simple-app');
    fs.writeFileSync(path.join(tmpDir, 'align.config.ts'), `throw new Error('EXPLOIT');\n`, 'utf8');

    const { result: code, errors } = await withCapturedConsole(() => runCheck(tmpDir, { json: false, untrusted: true }));
    expect(code).toBe(1);
    const message = errors.join('\n');
    expect(message).toContain('no committed IR ruleset found');
    expect(message).toContain('align export-ir');
    expect(message).toContain('--untrusted');
  });

  it('refuses on a corrupted JSON artifact instead of silently treating it as absent', async () => {
    tmpDir = copyFixture('simple-app');
    fs.mkdirSync(path.join(tmpDir, '.align'), { recursive: true });
    fs.writeFileSync(rulesetIrPath(tmpDir), '{ not valid json', 'utf8');

    const { result: code, errors } = await withCapturedConsole(() => runCheck(tmpDir, { json: false, untrusted: true }));
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('not valid JSON');
  });

  it('refuses on an artifact that fails schema validation', async () => {
    tmpDir = copyFixture('simple-app');
    fs.mkdirSync(path.join(tmpDir, '.align'), { recursive: true });
    fs.writeFileSync(rulesetIrPath(tmpDir), JSON.stringify({ irVersion: '1', ruleset: {} }), 'utf8');

    const { result: code } = await withCapturedConsole(() => runCheck(tmpDir, { json: false, untrusted: true }));
    expect(code).toBe(1);
  });

  it('--ir overrides the default artifact path', async () => {
    tmpDir = copyFixture('simple-app');
    expect(await runExportIr(tmpDir, { out: 'somewhere/custom-ir.json' })).toBe(0);

    const code = await runCheck(tmpDir, { json: false, untrusted: true, ir: 'somewhere/custom-ir.json' });
    expect(code).toBe(0);
  });
});

describe('align check --untrusted — custom.host is unavailable', () => {
  it('refuses (does not silently skip) when the exported ruleset contains a custom.host rule, naming it', async () => {
    tmpDir = copyFixture('simple-app');
    const exported = {
      irVersion: '1' as const,
      exportedAt: Date.now(),
      excludes: [],
      ruleset: {
        irVersion: '1' as const,
        components: { app: { name: 'app', selector: { kind: 'glob' as const, patterns: ['src/**'] }, empty: 'fail' } },
        rules: [{ kind: 'custom.host' as const, id: 'custom.host:route-thinness', hostRuleName: 'route-thinness', portable: false as const, provenance: {} }],
      },
    };
    writeRulesetIr(tmpDir, exported);

    const { result: code, errors } = await withCapturedConsole(() => runCheck(tmpDir, { json: false, untrusted: true }));
    expect(code).toBe(1);
    const message = errors.join('\n');
    expect(message).toContain('custom.host:route-thinness');
    expect(message).toContain('--untrusted');
  });
});

describe('align check --untrusted + --frozen-rules is a guarded, explicit error', () => {
  it('refuses the combination instead of running either mode inconsistently', async () => {
    tmpDir = copyFixture('simple-app');
    expect(await runExportIr(tmpDir)).toBe(0);

    const { result: code, errors } = await withCapturedConsole(() =>
      runCheck(tmpDir, { json: false, untrusted: true, frozenRules: true }),
    );
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('--frozen-rules');
  });
});
