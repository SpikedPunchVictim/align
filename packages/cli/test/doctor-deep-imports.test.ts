import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTsconfig(dir: string, content: unknown): void {
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(content), 'utf8');
}

// ADR 020 (ACCEPTED, RESCOPED to a doctor advisory) -- the deep-import convention check: a
// cross-package import that reaches past a package's declared public surface into its internals
// (a specifier subpath containing a src/dist/lib/internal segment). Split into its own file
// (rather than folded into doctor.test.ts) because doctor.test.ts is already at `arch.metric`'s
// 500-line-per-file ceiling for the `cli` component. The uninstalled 'some-lib' import is the
// false-quiet regression in integration-test form: it can only resolve via the scanner's
// `graph.uncertain` path (no real 'some-lib' package on disk), so this also proves the advisory
// fires from that source, not just from edges/externalEdges.
describe('align doctor — deep-import advisory (ADR 020)', () => {
  function makeRepo(opts: { knownPublicDeepImports?: string[] } = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-deepimport-test-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src/index.ts'),
      // 'some-lib' is not installed -- unresolvable, routed to graph.uncertain (the false-quiet
      // path). 'typescript' IS installed (real node_modules symlink below) with a genuine
      // lib/typescript.js file -- resolves as an externalEdge, matched against the built-in
      // allowlist seed (typescript/lib/*).
      `import { thing } from 'some-lib/dist/internal/thing';\n` +
        `import * as ts from 'typescript/lib/typescript.js';\n` +
        `export const x = thing ?? ts;\n`,
      'utf8',
    );
    writeTsconfig(dir, { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } });
    const allowlistExport =
      opts.knownPublicDeepImports !== undefined
        ? `export const knownPublicDeepImports = ${JSON.stringify(opts.knownPublicDeepImports)};\n`
        : '';
    fs.writeFileSync(
      path.join(dir, 'align.config.ts'),
      `import { defineProject } from '@spikedpunch/align-core/dsl';\n${allowlistExport}export default defineProject({ components: { app: 'src/**' } });\n`,
      'utf8',
    );
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    return dir;
  }

  async function jsonReport(dir: string): Promise<{ advisories: { kind: string; message: string }[] }> {
    const jsonLogs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      jsonLogs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runDoctor(dir, { json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    return JSON.parse(jsonLogs.join('')) as { advisories: { kind: string; message: string }[] };
  }

  it('produces a deep-import advisory for an uninstalled deep import resolved only via graph.uncertain', async () => {
    tmpDir = makeRepo();
    const payload = await jsonReport(tmpDir);
    const hits = payload.advisories.filter((a) => a.kind === 'deep-import');
    expect(hits.some((a) => a.message.includes('some-lib') && a.message.includes('dist'))).toBe(true);
  });

  it('does not report the built-in allowlisted typescript/lib/* convention', async () => {
    tmpDir = makeRepo();
    const payload = await jsonReport(tmpDir);
    const hits = payload.advisories.filter((a) => a.kind === 'deep-import');
    expect(hits.some((a) => a.message.includes('typescript'))).toBe(false);
  });

  it('a user-declared knownPublicDeepImports entry EXTENDS the built-in seed, suppressing an additional convention', async () => {
    tmpDir = makeRepo({ knownPublicDeepImports: ['some-lib/dist/**'] });
    const payload = await jsonReport(tmpDir);
    const hits = payload.advisories.filter((a) => a.kind === 'deep-import');
    expect(hits).toHaveLength(0);
  });
});
