/**
 * LEDGER D067 — the exported IR drifts from `align.config.ts` and NOTHING says so.
 *
 * Reproduced on the reporter's fixture 08: same tree, same moment, `align check` **green** and
 * `align check --untrusted` **RED**, with no staleness warning from either — nor from `doctor`.
 * `--untrusted` (ADR 014) reads `.align/ruleset-ir.json` instead of executing the config, and the
 * documented workflow is "export when trusted, `--untrusted` in CI", which makes drift close to
 * inevitable. It fails in BOTH directions: a stale IR enforces rules the config has dropped, and
 * misses rules it has gained. The second one is a false green in CI.
 *
 * Two guards, because neither side can do the other's job:
 *
 *  - **Trusted** (`check`, `doctor`) can legitimately load both and compare them EXACTLY. That is
 *    the authoritative answer, and it is where a developer sees it before pushing.
 *  - **Untrusted** cannot execute the config — that is the entire point of the flag — so it compares
 *    a fingerprint of the config SOURCE stamped at export time. Weaker on purpose, and it says so:
 *    a config that imports another file can change without the fingerprint moving, so silence here
 *    is not a freshness guarantee. Stating that is the difference between a limit and a lie.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { runExportIr } from '../src/commands/export-ir.js';
import { runDoctor } from '../src/commands/doctor.js';

let tmpDir: string | undefined;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

const CORE_DIST = path.resolve(import.meta.dirname, '../../core/dist');

function repoWithRule(rule: string): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-stale-ir-')));
  const w = (rel: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
  };
  w('package.json', JSON.stringify({ name: 'f8', private: true, version: '0.0.0' }));
  w(
    'align.config.ts',
    `import { defineProject } from '${CORE_DIST}/dsl/index.js';\n` +
      `export default defineProject({\n` +
      `  components: { a: 'src/a/**', b: 'src/b/**' },\n` +
      `  rules: (c) => [ ${rule} ],\n` +
      `});\n`,
  );
  w('src/a/index.ts', "import { b } from '../b/index.js';\nexport const a = b;\n");
  w('src/b/index.ts', 'export const b = 1;\n');
  return dir;
}

/** Swap the rule in place, leaving everything else byte-identical — the reporter's exact move. */
function rewriteRule(dir: string, rule: string): void {
  const file = path.join(dir, 'align.config.ts');
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, before.replace(/rules: \(c\) => \[ .* \],/, `rules: (c) => [ ${rule} ],`), 'utf8');
}

async function captured(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  const said: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...args: unknown[]) => void said.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => void said.push(args.map(String).join(' '));
  try {
    const code = await fn();
    return { code, output: said.join('\n') };
  } finally {
    console.log = log;
    console.error = err;
  }
}

const FORBID = 'c.arch.layer(c.a).cannotDependOn(c.b)';
const ALLOW = 'c.arch.layer(c.a).canOnlyDependOn(c.b)';

describe('a stale .align/ruleset-ir.json is reported, not silently obeyed (LEDGER D067)', () => {
  it('trusted `align check` says the exported IR no longer matches the config', async () => {
    const dir = repoWithRule(FORBID);
    expect((await captured(() => runExportIr(dir))).code).toBe(0);
    rewriteRule(dir, ALLOW);

    const { output } = await captured(() => runCheck(dir, { json: false }));

    expect(output).toMatch(/ruleset-ir\.json/);
    expect(output).toMatch(/export-ir/);
    expect(output).toMatch(/untrusted/i);
  });

  it('says nothing when the IR matches the config', async () => {
    const dir = repoWithRule(FORBID);
    await captured(() => runExportIr(dir));

    const { output } = await captured(() => runCheck(dir, { json: false }));

    expect(output).not.toMatch(/ruleset-ir\.json/);
  });

  it('says nothing when no IR has ever been exported', async () => {
    // Not exporting is a choice, not drift. Warning here would fire for every repository that has
    // never used --untrusted, which is most of them.
    const dir = repoWithRule(FORBID);

    const { output } = await captured(() => runCheck(dir, { json: false }));

    expect(output).not.toMatch(/ruleset-ir\.json/);
  });

  it('`align doctor` reports the same drift', async () => {
    const dir = repoWithRule(FORBID);
    await captured(() => runExportIr(dir));
    rewriteRule(dir, ALLOW);

    const { code, output } = await captured(() => runDoctor(dir, { json: false }));

    expect(code).toBe(0); // doctor is advisory and always exits 0
    expect(output).toMatch(/ruleset-ir\.json/);
  });

  it('`align check --untrusted` warns when align.config.ts changed after the export', async () => {
    const dir = repoWithRule(FORBID);
    await captured(() => runExportIr(dir));
    rewriteRule(dir, ALLOW);

    const { output } = await captured(() => runCheck(dir, { json: false, untrusted: true }));

    // It cannot know WHAT changed without executing the config, and must not pretend otherwise.
    expect(output).toMatch(/align\.config\.ts/);
    expect(output).toMatch(/export-ir/);
  });

  it('`align check --untrusted` is quiet when the config is unchanged since the export', async () => {
    const dir = repoWithRule(FORBID);
    await captured(() => runExportIr(dir));

    const { output } = await captured(() => runCheck(dir, { json: false, untrusted: true }));

    expect(output).not.toMatch(/changed since/i);
  });

  it('an IR exported by an older align says it CANNOT tell, rather than implying freshness', async () => {
    // S-10: absence of a fingerprint is absence of evidence. Every 0.2.0-and-earlier IR is in this
    // state, and reporting nothing would read as "verified fresh".
    const dir = repoWithRule(FORBID);
    await captured(() => runExportIr(dir));
    const irFile = path.join(dir, '.align', 'ruleset-ir.json');
    const ir = JSON.parse(fs.readFileSync(irFile, 'utf8')) as Record<string, unknown>;
    delete ir['sourceFingerprint'];
    fs.writeFileSync(irFile, `${JSON.stringify(ir, null, 2)}\n`);

    const { output } = await captured(() => runCheck(dir, { json: false, untrusted: true }));

    expect(output).toMatch(/cannot/i);
    expect(output).toMatch(/export-ir/);
  });
});
