import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { runDoctor } from '../src/commands/doctor.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Same discipline as check.test.ts's `linkAlignCore`: a fixture built in a bare tmpdir has no
// `node_modules`, so `align.config.ts`'s own `@spikedpunch/align-core/dsl` import would otherwise
// show up as an unresolvable specifier and add unrelated `missing-dependencies` noise.
function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

function buildRepo(configExtra = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-nested-checkout-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  // A nested git checkout — a linked `git worktree`'s `.git` is a FILE, exercised here so the
  // fixture matches the real shape task #25 is about (this repo's own `.claude/worktrees/*`).
  fs.mkdirSync(path.join(dir, 'vendor', 'submodule'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vendor', 'submodule', '.git'), 'gitdir: /elsewhere/.git/worktrees/submodule\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'vendor', 'submodule', 'index.ts'), 'export const y = 1;\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n` +
      `export default defineProject({ components: { app: 'src/**' } });\n${configExtra}`,
    'utf8',
  );
  linkAlignCore(dir);
  return dir;
}

async function readJson(run: () => Promise<number>): Promise<{ readonly advisories: readonly { kind: string; message: string }[] }> {
  const logs: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    logs.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(logs.join('')) as { advisories: readonly { kind: string; message: string }[] };
}

describe('align check — nested-checkout-skipped advisory reaches check (task #25)', () => {
  it('stays green (a skip is advisory, not a violation) and names the skipped path', async () => {
    tmpDir = buildRepo();
    expect(await runCheck(tmpDir, { json: false })).toBe(0);

    const payload = await readJson(() => runCheck(tmpDir, { json: true }));
    const advisory = payload.advisories.find((a) => a.kind === 'nested-checkout-skipped');
    expect(advisory).toBeDefined();
    expect(advisory?.message).toContain('vendor/submodule');
  });

  it('the includeNestedCheckouts opt-out re-includes the checkout — no advisory fires', async () => {
    tmpDir = buildRepo("export const includeNestedCheckouts = ['vendor/submodule'];\n");
    const payload = await readJson(() => runCheck(tmpDir, { json: true }));
    expect(payload.advisories.find((a) => a.kind === 'nested-checkout-skipped')).toBeUndefined();
  });
});

describe("align check — empty-component interaction (task #25's subtle part)", () => {
  it(
    "a component whose selector only reaches a skipped checkout, with empty: 'allow', stays green " +
      'but the ungrounded-component and nested-checkout-skipped advisories co-occur — enough to ' +
      'diagnose the real cause without extending CheckRun.ungroundedComponents itself',
    async () => {
      tmpDir = buildRepo();
      // Overwrite the config to add a second component whose ONLY files live inside the skipped
      // checkout — with the default `empty: 'fail'`, this would abort the whole check before any
      // advisory could attach (that path is covered by the registry unit test); `empty: 'allow'`
      // instead reaches a full green run where both advisories can co-occur.
      fs.writeFileSync(
        path.join(tmpDir, 'align.config.ts'),
        `import { defineProject } from '@spikedpunch/align-core/dsl';\n` +
          `export default defineProject({ components: { app: 'src/**', vendor: { pattern: 'vendor/submodule/**', empty: 'allow' } } });\n`,
        'utf8',
      );

      const payload = await readJson(() => runCheck(tmpDir, { json: true }));
      expect((payload as unknown as { verdict: string }).verdict).toBe('green');

      const nestedCheckoutAdvisory = payload.advisories.find((a) => a.kind === 'nested-checkout-skipped');
      expect(nestedCheckoutAdvisory?.message).toContain('vendor/submodule');

      const ungrounded = (payload as unknown as { ungroundedComponents?: readonly { name: string }[] }).ungroundedComponents;
      expect(ungrounded?.some((c) => c.name === 'vendor')).toBe(true);
    },
  );
});

describe('align doctor — nested-checkout-skipped advisory reaches doctor (task #25)', () => {
  it('names the skipped path and always exits 0', async () => {
    tmpDir = buildRepo();
    const payload = await readJson(() => runDoctor(tmpDir, { json: true }));
    const advisory = payload.advisories.find((a) => a.kind === 'nested-checkout-skipped');
    expect(advisory).toBeDefined();
    expect(advisory?.message).toContain('vendor/submodule');
    expect(await runDoctor(tmpDir, { json: false })).toBe(0);
  });
});
