import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { runExplain } from '../src/commands/explain.js';
import { runExportIr } from '../src/commands/export-ir.js';
import { baselineAccept, baselinePrune } from '../src/commands/baseline.js';
import { runInit } from '../src/commands/init.js';
import { runAgentCommand, type AgentRunCliOptions } from '../src/commands/agent.js';
import { runDoctor } from '../src/commands/doctor.js';

// Bug hunt 2026-08-03, BUG #14: `loadConfig` can fail six ways (a syntax error in
// align.config.ts, a missing @spikedpunch/align-core devDependency, a missing default export, a
// malformed excludes/compositionRoots/knownPublicDeepImports export, a corrupt
// `.align/generated-rules.json` JSON, or that same file failing zod validation). Seven CLI
// command entries called it unguarded and crashed with a raw Node stack trace. These tests use
// the cheapest reproduction — a corrupt `.align/generated-rules.json` — to drive every command
// through the failure and assert a clean, non-zero exit with no raw stack trace, plus (for
// `doctor`, which is deliberately NOT part of the fix) that its always-exit-0 contract survives.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-config-load-error-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCorruptGeneratedRules(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, '.align'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.align', 'generated-rules.json'), '{ this is not valid json', 'utf8');
}

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

/** A raw Node stack trace looks like `    at functionName (/path/to/file.js:12:34)` — none of
 * these clean-catch messages should ever contain one. */
function looksLikeRawStackTrace(message: string): boolean {
  return /^\s*at\s+\S+\s+\(.*:\d+:\d+\)/m.test(message);
}

describe('BUG #14 — a corrupt .align/generated-rules.json is a clean non-zero exit, not a raw stack trace', () => {
  it('align check', async () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptGeneratedRules(tmpDir);
    const { result: code, errors } = await withCapturedConsole(() => runCheck(tmpDir, { json: false }));
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/generated-rules\.json/);
    expect(looksLikeRawStackTrace(errors.join('\n'))).toBe(false);
  });

  it('align explain', async () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptGeneratedRules(tmpDir);
    const { result: code, errors } = await withCapturedConsole(() => runExplain(tmpDir, 'arch.no-cycles'));
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/generated-rules\.json/);
    expect(looksLikeRawStackTrace(errors.join('\n'))).toBe(false);
  });

  it('align export-ir', async () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptGeneratedRules(tmpDir);
    const { result: code, errors } = await withCapturedConsole(() => runExportIr(tmpDir));
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/generated-rules\.json/);
    expect(looksLikeRawStackTrace(errors.join('\n'))).toBe(false);
  });

  it('align baseline accept', async () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptGeneratedRules(tmpDir);
    const { result: code, errors } = await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/generated-rules\.json/);
    expect(looksLikeRawStackTrace(errors.join('\n'))).toBe(false);
  });

  it('align baseline prune', async () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptGeneratedRules(tmpDir);
    const { result: code, errors } = await withCapturedConsole(() => baselinePrune(tmpDir));
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/generated-rules\.json/);
    expect(looksLikeRawStackTrace(errors.join('\n'))).toBe(false);
  });

  it('align init (config already exists, so the failure surfaces at the post-prelude loadConfig call)', async () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptGeneratedRules(tmpDir);
    const { result: code, errors } = await withCapturedConsole(() => runInit(tmpDir, { acceptExisting: false, nonInteractive: true }));
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/generated-rules\.json/);
    expect(looksLikeRawStackTrace(errors.join('\n'))).toBe(false);
  });

  it('align agent run (fails before ever constructing an AnthropicFixProvider, so no API key is needed)', async () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptGeneratedRules(tmpDir);
    const options: AgentRunCliOptions = {
      maxAttempts: 3,
      pr: true,
      autoMerge: false,
      allowUntested: false,
      allowSymbolRemovals: false,
      allowIncomplete: false,
      dryRun: true,
    };
    const { result: code, errors } = await withCapturedConsole(() => runAgentCommand(tmpDir, options));
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/generated-rules\.json/);
    expect(looksLikeRawStackTrace(errors.join('\n'))).toBe(false);
  });

  it('align doctor is untouched by this fix: still exits 0 with a clean config-error advisory', async () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptGeneratedRules(tmpDir);
    const code = await runDoctor(tmpDir, { json: false });
    expect(code).toBe(0);
  });
});
