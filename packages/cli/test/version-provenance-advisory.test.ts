import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { ALIGN_VERSION } from '../src/telemetry/index.js';

// ADR 021/022: `align check` reads `.align/version.json` and advises when the running binary
// differs from the stamp — a DIFFERENT signal from the pre-existing global-vs-local `version-skew`
// advisory (`version-skew.test.ts`), which compares the running binary against this repo's
// INSTALLED `@spikedpunch/align-core` package.json rather than a record of who last wrote
// `.align/`. Wired through `withVersionSkew` (`version-skew.ts`) so `align check` (trusted and
// `--untrusted`) and the MCP surface all pick it up from one place.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-version-advisory-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  linkAlignCore(dest);
  return dest;
}

// See `check.test.ts`'s identical helper — keeps the fixture's scan `complete: true` and its
// installed `@spikedpunch/align-core` in lockstep with `ALIGN_VERSION`, so the pre-existing
// global-vs-local `version-skew` advisory never fires and doesn't interfere with these assertions.
function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

function writeStamp(rootDir: string, alignVersion: string): void {
  fs.mkdirSync(path.join(rootDir, '.align'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.align', 'version.json'), JSON.stringify({ alignVersion }), 'utf8');
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function readAdvisories(dir: string): Promise<{ kind: string; message: string }[]> {
  const logs: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    logs.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCheck(dir, { json: true });
  } finally {
    process.stdout.write = originalWrite;
  }
  const payload = JSON.parse(logs.join('')) as { advisories: { kind: string; message: string }[] };
  return payload.advisories;
}

describe('align check — .align/version.json provenance advisory', () => {
  it('absent stamp: a distinct "unknown provenance" advisory, never an error, never blocks the verdict', async () => {
    tmpDir = copyFixture('simple-app');
    const code = await runCheck(tmpDir, { json: false });
    expect(code).toBe(0); // verdict green — an advisory must never flip this
    const advisories = await readAdvisories(tmpDir);
    const advisory = advisories.find((a) => a.kind === 'artifact-version-unknown');
    expect(advisory).toBeDefined();
    expect(advisory?.message).not.toContain('ZodError');
  });

  it('stamp matches the running binary: no provenance advisory at all', async () => {
    tmpDir = copyFixture('simple-app');
    writeStamp(tmpDir, ALIGN_VERSION);
    const advisories = await readAdvisories(tmpDir);
    expect(advisories.some((a) => a.kind === 'artifact-version-unknown')).toBe(false);
    expect(advisories.some((a) => a.kind === 'artifact-version-skew')).toBe(false);
  });

  it('stamp OLDER than the running binary: artifact-version-skew, explicitly UPGRADE direction', async () => {
    tmpDir = copyFixture('simple-app');
    writeStamp(tmpDir, '0.0.1');
    const advisories = await readAdvisories(tmpDir);
    const advisory = advisories.find((a) => a.kind === 'artifact-version-skew');
    expect(advisory).toBeDefined();
    expect(advisory?.message).toContain('UPGRADE');
    expect(advisory?.message).not.toContain('DOWNGRADE');
    expect(advisory?.message).toContain('0.0.1');
    expect(advisory?.message).toContain(ALIGN_VERSION);
  });

  it('stamp NEWER than the running binary: artifact-version-skew, explicitly DOWNGRADE direction (the more dangerous case)', async () => {
    tmpDir = copyFixture('simple-app');
    writeStamp(tmpDir, '999.0.0');
    const advisories = await readAdvisories(tmpDir);
    const advisory = advisories.find((a) => a.kind === 'artifact-version-skew');
    expect(advisory).toBeDefined();
    expect(advisory?.message).toContain('DOWNGRADE');
    expect(advisory?.message).not.toContain('UPGRADE');
    expect(advisory?.message).toContain('999.0.0');
    expect(advisory?.message).toContain('cannot reproduce');
  });

  it('a corrupt .align/version.json is a clean non-zero exit, not a crash or a silently-ignored skew', async () => {
    tmpDir = copyFixture('simple-app');
    fs.mkdirSync(path.join(tmpDir, '.align'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.align', 'version.json'), '{ not valid json', 'utf8');
    const errors: string[] = [];
    const originalError = console.error;
    console.error = ((...args: unknown[]) => errors.push(args.map(String).join(' '))) as typeof console.error;
    let code: number;
    try {
      code = await runCheck(tmpDir, { json: false });
    } finally {
      console.error = originalError;
    }
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('version.json');
    expect(errors.join('\n')).not.toContain('    at '); // no raw Node stack trace leaking through
  });
});
