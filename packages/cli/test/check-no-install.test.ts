import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { runDoctor } from '../src/commands/doctor.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRepoWithExternalImport(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-no-install-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src/index.ts'),
    `import { cloneDeep } from 'lodash';
import { something } from '@scope/some-external-pkg/subpath';
import helper from './helper';
export const x = cloneDeep(something) + helper;
`,
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'src/helper.ts'), `export default 1;\n`, 'utf8');
  // Raw RulesetIR avoids needing a node_modules just to load align.config.ts — the scenario under
  // test is "align is installed but the target repo's other npm dependencies are not."
  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `const ruleset = {
  irVersion: '1',
  components: { app: { name: 'app', selector: { kind: 'glob', patterns: ['src/**'] }, empty: 'fail' } },
  rules: [],
};
export default ruleset;
`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    'utf8',
  );
  return dir;
}

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

async function readJson(run: () => Promise<number>): Promise<{ code: number; payload: { verdict: string; complete: boolean; advisories: { kind: string; message: string }[]; baselineDebt: { previous: number; current: number; delta: number } } }> {
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
  return { code, payload: JSON.parse(logs.join('')) as { verdict: string; complete: boolean; advisories: { kind: string; message: string }[]; baselineDebt: { previous: number; current: number; delta: number } } };
}

describe('align check — deps-not-installed false-green fix (docs/proposals/reconciled-build-order.md #1)', () => {
  it('emits a single missing-dependencies advisory instead of many unresolvable-specifier lines', async () => {
    tmpDir = makeRepoWithExternalImport();
    const { code, text } = await readHuman(() => runCheck(tmpDir, { json: false }));
    expect(code).toBe(0);
    expect(text).toContain('missing-dependencies');
    expect(text).toContain('dependencies appear uninstalled or incomplete');
    expect(text).toContain('2 external specifier(s)');
    expect(text).not.toContain('unresolvable-specifier');
    // The verdict line is annotated provisional so a human isn't misled by the green.
    expect(text).toMatch(/verdict: green \(provisional/);
  });

  it('includes the missing-dependencies advisory in the --json payload', async () => {
    tmpDir = makeRepoWithExternalImport();
    const { code, payload } = await readJson(() => runCheck(tmpDir, { json: true }));
    expect(code).toBe(0);
    const advisory = payload.advisories.find((a) => a.kind === 'missing-dependencies');
    expect(advisory).toBeDefined();
    expect(advisory?.message).toContain('dependencies appear uninstalled or incomplete');
    expect(payload.advisories.some((a) => a.kind === 'uncertainty' && a.message.includes('unresolvable-specifier'))).toBe(false);
    // The verdict is green but the graph is incomplete — `complete: false` says so structurally, so a
    // consumer reading `verdict` alone isn't misled (reconciled-build-order #1 follow-up).
    expect(payload.verdict).toBe('green');
    expect(payload.complete).toBe(false);
  });

  it('fires even when node_modules exists but holds only align (partial install) — the false-green case the fix targets', async () => {
    // Regression: before the scan-based fix, a node_modules/@spikedpunch entry made the old
    // heuristic report "installed", so the collapse never fired on a repo with align present but its
    // own deps absent — exactly the false-green scenario. The signal is now the scan marker itself.
    tmpDir = makeRepoWithExternalImport();
    fs.mkdirSync(path.join(tmpDir, 'node_modules/@spikedpunch'), { recursive: true });
    const { code, payload } = await readJson(() => runCheck(tmpDir, { json: true }));
    expect(code).toBe(0);
    expect(payload.advisories.some((a) => a.kind === 'missing-dependencies')).toBe(true);
  });

  it('keeps relative unresolvable specifiers visible when dependencies are missing', async () => {
    tmpDir = makeRepoWithExternalImport();
    fs.writeFileSync(
      path.join(tmpDir, 'src/index.ts'),
      `import { cloneDeep } from 'lodash';
import { something } from './missing-relative';
export const x = cloneDeep(something);
`,
      'utf8',
    );
    const { code, payload } = await readJson(() => runCheck(tmpDir, { json: true }));
    expect(code).toBe(0);
    expect(payload.advisories.some((a) => a.kind === 'missing-dependencies')).toBe(true);
    expect(payload.advisories.some((a) => a.kind === 'uncertainty' && a.message.includes('reason: unresolvable-specifier'))).toBe(true);
  });
});

describe('align doctor — deps-not-installed collapse', () => {
  it('collapses external unresolvable specifiers into one missing-dependencies advisory', async () => {
    tmpDir = makeRepoWithExternalImport();
    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await runDoctor(tmpDir, { json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(code).toBe(0);
    const payload = JSON.parse(logs.join('')) as { advisories: { kind: string; message: string }[] };
    expect(payload.advisories.some((a) => a.kind === 'missing-dependencies')).toBe(true);
    expect(payload.advisories.some((a) => a.kind === 'uncertainty' && a.message.includes('unresolvable-specifier'))).toBe(false);
  });
});
