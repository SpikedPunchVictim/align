import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { dryRunBuild, verifyFrozenRules, writeBuildArtifacts } from '../src/commands/build.js';
import { ensureAlignDir, generatedRulesPath, rulesLockPath } from '../src/align-dir.js';

/**
 * LEDGER **D042** (bug hunt B8) — `align build --apply` must not leave doc-built rules in force with
 * no lockfile, and if it ever does, `--verify` must say so instead of reporting success.
 *
 * `writeBuildArtifacts` writes `.align/generated-rules.json`, then `align.config.ts`'s note, then
 * (optionally) the baseline, then `.align/rules.lock.json`. `loadConfig` merges generated-rules.json
 * into the effective ruleset on every load regardless of whether the later writes happened, so a
 * throw in the middle leaves the rules ENFORCED with no record of the build that produced them.
 *
 * The function's own comment says a previous fix attempt closed this ("validated HERE, before any of
 * the three writes"), and that is true of the one cause it names — a malformed `align.config.ts`
 * marker. It is not true of `readBaselineSnapshot`, which throws on a corrupt baseline and runs
 * AFTER the first write. Measured, on `build-app` with an api->ui violation introduced so
 * `addedNew > 0`:
 *
 *     writeBuildArtifacts -> THREW ".align/baseline.json is not valid JSON..."
 *       generated-rules.json : true      <- in force
 *       rules.lock.json      : false     <- no record of the build
 *       config note written  : true      <- a human-owned file already mutated
 *       build --verify says  : {"ok":true,"advisories":[]}
 *
 * **That last line is the defect that outranks the partial write.** `verifyFrozenRules` returns
 * `ok: true` the moment the lockfile is absent, with a doc comment calling it "a deliberate no-op".
 * That is right for a repo that never ran `build --apply`, and wrong when generated-rules.json is
 * sitting there: absent is being read as "no build" when a sibling artifact proves it means "a build
 * whose record is missing". Same corrupt-≠-absent discipline as BUG #1 and ADR 028, in a third place
 * — and here it is the VERIFIER, so a command whose entire job is to detect this reports success.
 * CLAUDE.md rule 6.
 *
 * Both halves are fixed, and the order matters: the write sequence is made atomic so the state is
 * hard to reach, and the verifier is taught to recognise it anyway, because no preflight can cover a
 * full disk, an `EACCES`, or a `SIGKILL` between two writes.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');
const repoRoot = path.resolve(here, '..', '..', '..');

let tmpDir: string;
afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** `build-app`, plus the api->ui import its doc-built rule forbids — without a real violation
 * `impact.addedNew` is 0, the baseline branch never runs, and the defect is unreachable. */
function buildRepo(): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-build-atomic-')));
  fs.cpSync(path.join(fixturesDir, 'build-app'), dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', '@spikedpunch'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'packages', 'core'), path.join(dir, 'node_modules', '@spikedpunch', 'align-core'));
  fs.writeFileSync(
    path.join(dir, 'src/api/service.ts'),
    "import { render } from '../ui/component.js';\nexport function handleRequest(): string {\n  return render();\n}\n",
    'utf8',
  );
  return dir;
}

const DOC = 'docs/ARCHITECTURE-RULES.md';

describe('build --apply is all-or-nothing [D042]', () => {
  it('writes nothing at all when the baseline it needs cannot be read', async () => {
    const dir = buildRepo();
    const result = await dryRunBuild(dir, DOC);
    // PREMISE [S-05]: the baseline branch only runs when the build adds new violations. With 0 this
    // test would pass against the defect, which is exactly how the first probe of it failed.
    expect(result.impact.addedNew.length).toBeGreaterThan(0);

    const configBefore = fs.readFileSync(path.join(dir, 'align.config.ts'), 'utf8');
    ensureAlignDir(dir);
    fs.writeFileSync(path.join(dir, '.align/baseline.json'), '{ not json', 'utf8');

    expect(() => writeBuildArtifacts(dir, result, { acceptNewIntoBaseline: true })).toThrow(/not valid JSON/);

    // THE ASSERTIONS THAT MATTER: the rules are not in force, and the human's file is untouched.
    expect(fs.existsSync(generatedRulesPath(dir))).toBe(false);
    expect(fs.existsSync(rulesLockPath(dir))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'align.config.ts'), 'utf8')).toBe(configBefore);
  });

  it('still writes everything on a healthy repo', async () => {
    // Calibration [S-04]: a preflight that refused every apply would satisfy the test above.
    const dir = buildRepo();
    const result = await dryRunBuild(dir, DOC);

    const applied = writeBuildArtifacts(dir, result, { acceptNewIntoBaseline: true });

    expect(applied.ok).toBe(true);
    expect(fs.existsSync(generatedRulesPath(dir))).toBe(true);
    expect(fs.existsSync(rulesLockPath(dir))).toBe(true);
    expect(verifyFrozenRules(dir)).toEqual({ ok: true, advisories: [] });
  });
});

describe('verifyFrozenRules does not read a missing lockfile as "no build" [D042]', () => {
  it('reports generated rules that are in force with no lockfile', async () => {
    const dir = buildRepo();
    const result = await dryRunBuild(dir, DOC);
    writeBuildArtifacts(dir, result, { acceptNewIntoBaseline: true });
    // The state a killed or partly-failed apply leaves behind, reached here by deleting the lockfile
    // rather than by staging a throw — the verifier's job is to recognise the STATE, whatever caused
    // it, including a `git clean` or a hand-deleted file.
    fs.rmSync(rulesLockPath(dir));

    const verdict = verifyFrozenRules(dir);

    // Before the fix: `{ ok: true, advisories: [] }`.
    expect(verdict.ok).toBe(false);
    expect(verdict.advisories.map((a) => a.kind)).toContain('generated-rules-without-lockfile');
    // The message has to say what to DO — the remedy is one command [S-04].
    expect(verdict.advisories[0]?.message).toContain('align build --apply');
  });

  it('is still a no-op for a repo that has simply never built', () => {
    // Calibration, and the whole reason the original early return existed. A repo with no doc-built
    // rules at all must stay silent — turning this into a failure would make `check --frozen-rules`
    // red on every project that does not use `align build`.
    const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-build-never-')));
    ensureAlignDir(dir);

    expect(verifyFrozenRules(dir)).toEqual({ ok: true, advisories: [] });
  });
});
