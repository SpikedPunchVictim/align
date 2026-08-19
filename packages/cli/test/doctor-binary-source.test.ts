import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import type { DoctorJsonPayload } from '../src/commands/doctor.js';

/**
 * `align doctor`'s `binary-source-file` advisory — LEDGER **D033**, shape [S-13].
 *
 * align found three files in its OWN tree containing a raw NUL byte, which makes git and grep treat
 * the whole file as binary: `grep` skips it silently, and every diff renders as
 * `Bin ... bytes, 0 insertions, 0 deletions`. The code was correct in all three; the reviewability
 * was not, and one of them held the function move-transfer matches on. A test now stops it recurring
 * in this repository (`core/test/sources-are-text-not-binary.test.ts`); this advisory is the same
 * service for a user's repository.
 *
 * **Deliberately doctor and not a rule.** A control byte is not an architecture violation, so failing
 * `align check` over one would miscategorise it, and a `custom.host` predicate would not survive
 * `align check --untrusted` (ADR 014/017). Doctor is the read-only, always-exit-0 surface for "why is
 * my result weird" — and a file the reviewer's tools cannot see is exactly that.
 */

let tmpDir: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A minimal repo align will scan: one component, one source file, no violations. */
function repo(sourceBytes: Buffer): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-binary-')));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/index.ts'), sourceBytes);
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
  );
  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n\nexport default defineProject({\n  components: { app: 'src/**' },\n  rules: () => [],\n});\n`,
  );
  return dir;
}

async function advisories(dir: string): Promise<DoctorJsonPayload['advisories']> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  try {
    expect(await runDoctor(dir, { json: true })).toBe(0);
  } finally {
    process.stdout.write = original;
  }
  return (JSON.parse(chunks.join('')) as DoctorJsonPayload).advisories;
}

/** Built rather than typed, so this test file cannot contain the byte it is about — the same
 * trick `core/test/sources-are-text-not-binary.test.ts` uses on its own calibration case. */
const NUL = String.fromCharCode(0);

const CLEAN = Buffer.from(`export const x = 1;\n`, 'utf8');

describe('doctor flags source files that are binary to git and grep', () => {
  it('names the file, the line and the byte', async () => {
    // The NUL goes on line 2 so the reported line number is a real answer rather than a default.
    const withNul = Buffer.concat([Buffer.from('export const a = 1;\n', 'utf8'), Buffer.from(`export const SEP = '${NUL}';\n`, 'utf8')]);

    const found = (await advisories(repo(withNul))).filter((a) => a.kind === 'binary-source-file');

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('src/index.ts:2');
    expect(found[0]?.message).toContain('0x00');
    // The advisory has to say what to DO — a diagnosis nobody can act on is the shape [S-04] warns
    // about, and this one is genuinely fixable in one edit with no runtime consequence.
    expect(found[0]?.message).toContain('escape');
  });

  it('stays silent on a repository whose sources are all text', async () => {
    const found = (await advisories(repo(CLEAN))).filter((a) => a.kind === 'binary-source-file');

    expect(found).toEqual([]);
  });

  it('does not fire on tab, newline or carriage return', async () => {
    // The calibration that keeps the advisory from crying wolf on every CRLF checkout on Windows.
    const whitespace = Buffer.from('export const a = 1;\r\n\texport const b = 2;\n', 'utf8');

    const found = (await advisories(repo(whitespace))).filter((a) => a.kind === 'binary-source-file');

    expect(found).toEqual([]);
  });

  it('still exits 0 — doctor never fails a build, whatever it finds', async () => {
    // Doctor's contract (its own doc comment: "advisory tool — never fails the build"). A hygiene
    // advisory that could break CI would be a rule wearing a diagnosis.
    const dir = repo(Buffer.from(`export const SEP = '${NUL}';\n`, 'utf8'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runDoctor(dir, { json: false })).toBe(0);
  });
});
