import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runBuild } from '../src/commands/build.js';
import { generatedRulesPath, readBaseline } from '../src/align-dir.js';

// `BuildOptions.confirm` (`commands/build.ts`) is a test-only seam mirroring `InitOptions.confirm`/
// `UpgradeOptions.confirm` exactly: supplying it forces `isInteractive` true, independent of
// `nonInteractive`/stdin, so the interactive "seed new violations into the baseline?" branch can be
// driven deterministically without faking a TTY. Before this seam existed, `build.test.ts` could
// only reach the non-interactive path (`nonInteractive: true` + an explicit
// `acceptNewIntoBaseline`) — the interactive prompt itself, previously an inline `readline` block
// duplicated from `init`/`upgrade`, was untested. Split into its own file rather than growing
// `build.test.ts` (already 456 of the `cli` component's 500-line cap, tests included) — this test
// directory's own convention is per-file local helper copies, not a shared helpers module, so this
// follows `build.test.ts`'s `copyFixture` verbatim rather than importing it.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-build-interactive-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

const DOC = 'docs/ARCHITECTURE-RULES.md';

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** `build-app`'s stock ruleset already forbids `api` importing `ui`, with one violation
 * (`src/api/service.ts`) already priced into the fixture. Adding a SECOND, independent import of
 * `ui` from `api` is what makes `dryRunBuild`'s `impact.addedNew` non-empty — the precondition
 * `runBuild` checks (`result.impact.addedNew.length > 0`) before it will even consider prompting.
 * Identical to the precondition `build.test.ts`'s own "requires --accept-new-into-baseline" test
 * uses. */
function addSecondViolation(dest: string): void {
  fs.writeFileSync(
    path.join(dest, 'src/api/other.ts'),
    `import { render } from '../ui/component.js';\n\nexport function handleOther(): string {\n  return render();\n}\n`,
    'utf8',
  );
}

/** A scripted `confirm` that records every question it was asked, so a test can assert BOTH the
 * answer it returns and whether/how many times it was actually invoked. */
function trackingConfirm(answer: boolean): { readonly fn: (question: string) => Promise<boolean>; readonly calls: string[] } {
  const calls: string[] = [];
  const fn = async (question: string): Promise<boolean> => {
    calls.push(question);
    return answer;
  };
  return { fn, calls };
}

describe('`align build --apply` interactive new-violation consent, via `BuildOptions.confirm`', () => {
  it('interactive yes seeds the new violation(s) into the baseline and applies', async () => {
    tmpDir = copyFixture('build-app');
    addSecondViolation(tmpDir);
    const confirm = trackingConfirm(true);

    const code = await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false, confirm: confirm.fn });

    expect(code).toBe(0);
    expect(fs.existsSync(generatedRulesPath(tmpDir))).toBe(true);
    expect(readBaseline(tmpDir).length).toBeGreaterThan(0);
  });

  it('interactive no does not seed anything into the baseline and does not apply', async () => {
    tmpDir = copyFixture('build-app');
    addSecondViolation(tmpDir);
    const confirm = trackingConfirm(false);

    const code = await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false, confirm: confirm.fn });

    expect(code).toBe(1);
    expect(fs.existsSync(generatedRulesPath(tmpDir))).toBe(false);
    expect(readBaseline(tmpDir)).toEqual([]);
  });

  it('confirm is called exactly once, with the un-suffixed question text', async () => {
    tmpDir = copyFixture('build-app');
    addSecondViolation(tmpDir);
    const confirm = trackingConfirm(true);

    await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false, confirm: confirm.fn });

    expect(confirm.calls).toEqual(['Seed these into the baseline as tolerated debt and apply?']);
  });

  it('confirm is never called when acceptNewIntoBaseline was already passed explicitly — the prompt exists only to obtain consent not already given', async () => {
    tmpDir = copyFixture('build-app');
    addSecondViolation(tmpDir);
    const confirm = trackingConfirm(true);

    const code = await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: true, confirm: confirm.fn });

    expect(code).toBe(0);
    expect(confirm.calls).toHaveLength(0);
    expect(fs.existsSync(generatedRulesPath(tmpDir))).toBe(true);
  });
});
