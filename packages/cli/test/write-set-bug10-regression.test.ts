import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { expectOnlyWrote, snapshotTree } from './write-set.js';

// The direct BUG #10 regression test ADR 026 calls out by name
// (docs/adr/026-declared-write-sets.md: "This is BUG #10 expressed as a property rather than as a
// remembered anecdote"). Verbatim reproduction that motivated the ADR
// (.agents/research/2026-08-03-bug-hunt-full-codebase.md:546):
//
//   initial config has rules?   true
//   after run 1  rules present? true
//   after run 2  rules present? false   defineProject present? false
//
// A fixture whose align.config.ts note block has lost its END marker AND which has real,
// hand-authored content (a `defineProject` call with real rules) — the exact shape the original
// bug destroyed. `writeGeneratedRulesNote` (`init/config-comment.ts`, via `marker-block.ts`'s
// `locateBlock`) now throws on this malformed marker state instead of splicing from the lone
// START to the lone END and deleting everything in between, so `runInit` must REFUSE both runs —
// this test pins that refusal, not a repair, and asserts the write-set invariant holds through it:
// a command that refuses to write must leave the ENTIRE tree — not just the one file it was about
// to corrupt — byte-for-byte untouched.

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRepoWithMalformedNoteBlock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-write-set-bug10-test-'));
  fs.mkdirSync(path.join(dir, 'src', 'api'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/api/service.ts'), `export function handle(): string {\n  return 'ok';\n}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'src/ui/component.ts'), `export function render(): string {\n  return 'ui';\n}\n`, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    'utf8',
  );
  // Real, human-authored content: a `defineProject` call with a real ruleset — this is the exact
  // content the original bug spliced away. The note block below has a START marker but the write
  // that should have closed it with END was interrupted (a crash, a bad merge) — the malformed
  // state the whole ADR is about.
  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n\n` +
      `export default defineProject({\n` +
      `  components: { api: 'src/api/**', ui: 'src/ui/**' },\n` +
      `  rules: [\n` +
      `    { kind: 'arch.no-cycles', components: ['api', 'ui'] },\n` +
      `    { kind: 'arch.no-dependency', from: 'ui', to: 'api' },\n` +
      `  ],\n` +
      `});\n\n` +
      `// align:generated-rules-note:start\n` +
      `// stale note, interrupted write, no closing marker\n`,
    'utf8',
  );
  return dir;
}

function configHasRules(dir: string): { hasDefineProject: boolean; hasRules: boolean } {
  const content = fs.readFileSync(path.join(dir, 'align.config.ts'), 'utf8');
  return { hasDefineProject: content.includes('defineProject'), hasRules: content.includes("kind: 'arch.no-cycles'") };
}

describe('BUG #10 regression: a malformed align.config.ts note block must refuse, never destroy the ruleset', () => {
  it('run 1 and run 2 both refuse, and the ruleset survives byte-identical through both', async () => {
    tmpDir = makeRepoWithMalformedNoteBlock();
    const original = fs.readFileSync(path.join(tmpDir, 'align.config.ts'), 'utf8');

    const initial = configHasRules(tmpDir);
    expect(initial.hasDefineProject).toBe(true);
    expect(initial.hasRules).toBe(true);

    // `ensureAlignDir` no longer runs unconditionally up front (`commands/init.ts` — the call was
    // moved out entirely once its only real callers, `writeBaseline`/`recordBaselineReconciled`
    // in `align-dir.ts`, were confirmed to already self-ensure the directory at the point they
    // write). A run that refuses at the marker-block pre-flight, as this test does, now reaches
    // neither of those writers, so it writes NOTHING — not even an empty `.align/`. The write-set
    // is therefore empty: this asserts the stronger property directly, not a weaker one kept only
    // because the code happened to do more.
    const REFUSAL_WRITE_SET: readonly string[] = [];

    const before1 = snapshotTree(tmpDir);
    const code1 = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true });
    // Refused, not guessed: BUG #10's actual reproduction had run 1 still succeed (rules present:
    // true) and only run 2 destroy them. The fix moves the refusal earlier — this run must ALSO
    // report failure, not silently "succeed" while leaving a malformed file for the next run to
    // find.
    expect(code1).not.toBe(0);
    const afterRun1 = configHasRules(tmpDir);
    expect(afterRun1.hasDefineProject).toBe(true);
    expect(afterRun1.hasRules).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'align.config.ts'), 'utf8')).toBe(original);
    // The write-set invariant: a refusal must leave the ENTIRE tree untouched — no `.align/`
    // created, no CLAUDE.md written, no baseline, no partial side effect of any other kind
    // survives a refused run.
    expectOnlyWrote(before1, tmpDir, REFUSAL_WRITE_SET);

    const before2 = snapshotTree(tmpDir);
    const code2 = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true });
    // This is BUG #10's actual reproduction point: "after run 2, rules present? false,
    // defineProject present? false." The fix means run 2 refuses exactly the same way run 1 did —
    // it does NOT get a second, different (destructive) code path to fall into.
    expect(code2).not.toBe(0);
    const afterRun2 = configHasRules(tmpDir);
    expect(afterRun2.hasDefineProject).toBe(true);
    expect(afterRun2.hasRules).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'align.config.ts'), 'utf8')).toBe(original);
    expectOnlyWrote(before2, tmpDir, REFUSAL_WRITE_SET);
  });
});
