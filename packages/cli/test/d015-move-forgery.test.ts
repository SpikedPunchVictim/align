import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBaselineSnapshot } from '../src/align-dir.js';
import { baselineAccept, baselinePrune } from '../src/commands/baseline.js';
import { seedBaseline } from './seed-baseline.js';
import { runCheck } from '../src/commands/check.js';
import { readLastScanRecord } from '../src/last-scan-file.js';

/**
 * **LEDGER D015, end to end through the real command.** The last open severity zero, closed by
 * ADR 029 §6's `wasViolationObservedAt` consumer in `InMemoryBaselineStore.applyMoves`.
 *
 * The core suite (`core/test/scan-history-move-refusal.test.ts`) pins the store's decision against a
 * hand-built record. This suite pins the thing a user actually experiences, and it is deliberately
 * the whole loop: align must WRITE a record on the earlier checks and READ it on the later one for
 * any of this to work, so a wiring mistake anywhere between `openScanHistory`, `createOrchestrator`
 * and `persistScanObservation` fails here even though every unit below it passes.
 *
 * The two tests are the same code path with one difference — whether the previous scan ever saw the
 * candidate — and they must both hold. A refusal that also fired on the second one would not be a
 * fix; it would be ADR 006's rename guarantee traded away silently.
 */

let tmpDir: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const VIOLATING_SOURCE = `import { render } from '../ui/component.js';\n\nexport function handleRequest(): string {\n  return render();\n}\n`;

function makeRepo(): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-d015-')));
  fs.mkdirSync(path.join(dir, 'src/api'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/ui'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n\nexport default defineProject({\n  components: { api: 'src/api/**', ui: 'src/ui/**' },\n  rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui).because('The API must remain headless.')],\n});\n`,
  );
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2022' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'src/ui/component.ts'), `export function render(): string {\n  return 'ui';\n}\n`);
  fs.writeFileSync(path.join(dir, 'src/api/old.ts'), VIOLATING_SOURCE);
  return dir;
}

async function quietCheck(dir: string): Promise<number> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await runCheck(dir, { json: false });
  } finally {
    process.stdout.write = original;
  }
}

/** `src/api/old.ts` violating and accepted by a human; the repository green; one record written. */
async function acceptedAndGreen(): Promise<string> {
  const dir = makeRepo();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await baselineAccept(dir)).toBe(0);
  log.mockRestore();
  expect(await quietCheck(dir)).toBe(0);
  expect(readLastScanRecord(dir)?.violations.map((v) => v.file)).toEqual(['src/api/old.ts']);
  return dir;
}

describe('a violation that was already red last scan cannot receive a transferred acceptance', () => {
  it('D015: deleting the accepted file no longer forges consent onto the identical one beside it', async () => {
    const dir = await acceptedAndGreen();

    // The never-reviewed violation appears. The repository is red, and the record now knows it.
    fs.writeFileSync(path.join(dir, 'src/api/new.ts'), VIOLATING_SOURCE);
    expect(await quietCheck(dir)).toBe(1);
    expect(readLastScanRecord(dir)?.violations.map((v) => v.file).sort()).toEqual(['src/api/new.ts', 'src/api/old.ts']);

    // ...and now the accepted file goes away. Before ADR 029 §6 this exited 0 GREEN, with the
    // human's `acceptedBy: manual` sitting on `new.ts` — a violation nobody had ever looked at.
    fs.rmSync(path.join(dir, 'src/api/old.ts'));

    expect(await quietCheck(dir)).toBe(1);
    // The consent stayed where the human put it. `reconcileMoves` leaves an unmatched orphan alone,
    // so nothing was deleted either — the entry is retained at a path that no longer exists, which is
    // the loud, recoverable direction ADR 006's amendment chose deliberately.
    expect(readBaselineSnapshot(dir).entries.map((e) => e.file)).toEqual(['src/api/old.ts']);
  });

  it('HOLDS on the second check, and the third — the refusal is not a one-run delay (LEDGER D030)', async () => {
    // The defect this pins was shipped and reported as closing D015, and it did not: the run that
    // refuses also rewrites the record, and by then the orphan's file is deleted and therefore not
    // observed — so the coexistence evidence that justified the refusal was destroyed by the very run
    // that acted on it. Measured before the fix: check#1 exit 1, **check#2 exit 0** with
    // `acceptedBy: manual` re-homed onto the never-reviewed violation, check#3 green. In CI, where
    // every push runs check, that is a delay of minutes.
    //
    // Three checks, not two: two would prove the refusal survives one rewrite, and the failure mode is
    // precisely that it survives exactly one.
    const dir = await acceptedAndGreen();
    fs.writeFileSync(path.join(dir, 'src/api/new.ts'), VIOLATING_SOURCE);
    expect(await quietCheck(dir)).toBe(1);
    fs.rmSync(path.join(dir, 'src/api/old.ts'));

    expect(await quietCheck(dir)).toBe(1);
    expect(await quietCheck(dir)).toBe(1);
    expect(await quietCheck(dir)).toBe(1);

    expect(readBaselineSnapshot(dir).entries.map((e) => e.file)).toEqual(['src/api/old.ts']);
    // The evidence is visibly carried rather than re-observed: the deleted file cannot be in
    // `violations` (nothing observed it), so a record that still answers about it must say `retained`.
    const record = readLastScanRecord(dir);
    expect(record?.violations.map((v) => v.file)).toEqual(['src/api/new.ts']);
    expect(record?.retained.map((v) => v.file)).toEqual(['src/api/old.ts']);
  });

  it('stops retaining once the human resolves it, so the record converges', async () => {
    // The other half of the mechanism, and the reason it is not an unbounded accumulator: retention is
    // conditional on a baseline entry still naming that violation at that path. Prune the orphan and
    // the evidence is dropped on the next write.
    const dir = await acceptedAndGreen();
    fs.writeFileSync(path.join(dir, 'src/api/new.ts'), VIOLATING_SOURCE);
    await quietCheck(dir);
    fs.rmSync(path.join(dir, 'src/api/old.ts'));
    await quietCheck(dir);
    expect(readLastScanRecord(dir)?.retained).toHaveLength(1);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await baselinePrune(dir, { yes: true, allowIncomplete: true })).toBe(0);
    log.mockRestore();
    await quietCheck(dir);

    expect(readLastScanRecord(dir)?.retained).toEqual([]);
  });

  it('a genuine rename in the same window still transfers, exactly as ADR 006 promises', async () => {
    // Calibration for the test above [S-05]: if the refusal fired on any absent file rather than on
    // an already-observed candidate, this would go red and ADR 006's "a rename must not turn CI red
    // for one cycle" would be broken without anything saying so.
    const dir = await acceptedAndGreen();

    // Rename between two scans: the record has never seen `new.ts`, so nothing refutes the move.
    fs.rmSync(path.join(dir, 'src/api/old.ts'));
    fs.writeFileSync(path.join(dir, 'src/api/new.ts'), VIOLATING_SOURCE);

    expect(await quietCheck(dir)).toBe(0);
    expect(readBaselineSnapshot(dir).entries.map((e) => e.file)).toEqual(['src/api/new.ts']);
  });

  it('with no record at hand, both cases behave exactly as align did before ADR 029', async () => {
    // ADR 029 §5 at the command level. The record is gitignored and machine-local, so its ABSENCE is
    // the ordinary state on a fresh CI checkout — and this asserts that absence changes nothing
    // rather than silently arming or disarming the refusal. It is also the honest statement of what
    // this fix does NOT cover: a first run has no temporal reference, so D015 is still reachable
    // there, and only ADR 006's whole-directory exception stands in front of the D010 shape.
    const dir = await acceptedAndGreen();
    fs.writeFileSync(path.join(dir, 'src/api/new.ts'), VIOLATING_SOURCE);
    expect(await quietCheck(dir)).toBe(1);
    fs.rmSync(path.join(dir, 'src/api/old.ts'));
    fs.rmSync(path.join(dir, '.align/last-scan.json'));

    expect(await quietCheck(dir)).toBe(0);
    expect(readBaselineSnapshot(dir).entries.map((e) => e.file)).toEqual(['src/api/new.ts']);
  });
});

/**
 * **The regression the D015 refusal introduced, and the invariant it broke.** Found by adversarial
 * review 2026-08-18 (LEDGER D024); reproduced here before it was fixed.
 *
 * `commands/check.ts` tolerates a failed `persistMovedBaseline` on an explicit stated ground — *"the
 * next `align check` re-derives and re-persists the same transfer unconditionally"* — and
 * `commands/baseline.ts` defers transfers relying on the same invariant. The record broke it. Once a
 * run has transferred and recorded, the record contains the violation at its NEW path; if the
 * baseline write did not stick, the next run sees the orphan again, asks
 * `wasViolationObservedAt(newPath)`, gets `true` from the record its own predecessor wrote, and
 * refuses. Every later run re-records the same observation, so the state is permanent, and
 * `baseline prune` then deletes the orphan outright.
 *
 * The refusal is UNSOUND there, not merely conservative: "already observed at that path" is supposed
 * to mean the candidate predates the orphan's disappearance, but here the observation came from a run
 * that happened AFTER it — the recorded violation *is* the moved one.
 *
 * The baseline is committed and the record is gitignored, so they diverge in ordinary ways: a
 * tolerated concurrent write, `git checkout -- .align/baseline.json` after align auto-wrote a
 * transfer, or a branch switch. This test uses the revert, being the deterministic one.
 *
 * The fix is to ask about BOTH sides. A real D015 forgery has the previous scan observing the orphan's
 * violation at its OLD path *and* the candidate at its new one — they coexisted, which is what makes
 * "the candidate predates the disappearance" mean anything. In the state below the record holds only
 * the candidate, because the orphan's file was already gone when it was written.
 */
describe('a record that advanced past a lost baseline write must not strand the rename', () => {
  it('re-derives the transfer instead of refusing it forever', async () => {
    const dir = await acceptedAndGreen();
    const beforeTransfer = readBaselineSnapshot(dir).entries;

    // An ordinary rename, in one window: align transfers, and records the violation at its new path.
    fs.rmSync(path.join(dir, 'src/api/old.ts'));
    fs.writeFileSync(path.join(dir, 'src/api/new.ts'), VIOLATING_SOURCE);
    expect(await quietCheck(dir)).toBe(0);
    expect(readBaselineSnapshot(dir).entries.map((e) => e.file)).toEqual(['src/api/new.ts']);
    expect(readLastScanRecord(dir)?.violations.map((v) => v.file)).toEqual(['src/api/new.ts']);

    // ...and the baseline write is undone. `check.ts`'s concurrent-write catch reaches this same
    // state without anyone touching a file.
    seedBaseline(dir, beforeTransfer);

    // The invariant `check.ts` promises: the next run redoes the transfer.
    expect(await quietCheck(dir)).toBe(0);
    expect(readBaselineSnapshot(dir).entries.map((e) => e.file)).toEqual(['src/api/new.ts']);
  });
});

/**
 * **The branch-switch coupling** — `.align/baseline.json` is committed and travels with the branch;
 * `.align/last-scan.json` is gitignored and stays put. So a `git checkout` leaves align holding a
 * record of a tree that is no longer there.
 *
 * Simulated without git, deliberately: the essential mechanic is "the tree and the committed baseline
 * change together while the machine-local record does not", which plain `fs` reproduces exactly. It
 * also isolates the coupling instead of testing git's checkout.
 *
 * **The answer, and it is a trade rather than a fix.** Measured on 2026-08-19 BEFORE retention landed,
 * this self-healed: the first check refused on the other branch's evidence, that same check rewrote
 * the record from the current tree, and the second check transferred. One red cycle. Retention
 * (LEDGER D030) deliberately removes that self-healing, because the branch-switch case and the D015
 * forgery are *indistinguishable to align* — both are "the record says these coexisted; the orphan's
 * file is now gone" — so evidence that sticks for one sticks for the other.
 *
 * That is ADR 006's asymmetry choosing again, and choosing the same way: a missed transfer is loud and
 * one `align baseline accept` from resolved; a forged one is silent and destroys a consent record. The
 * cost is stated here rather than discovered — after a branch switch, a rename that crossed it needs a
 * human to say so.
 */
describe('after a branch switch, the record describes a tree that is no longer checked out', () => {
  it('refuses the transfer and KEEPS refusing until a human resolves it', async () => {
    const dir = await acceptedAndGreen();
    // Branch A: the twin exists and is red, so the record learns the two coexisted.
    fs.writeFileSync(path.join(dir, 'src/api/new.ts'), VIOLATING_SOURCE);
    expect(await quietCheck(dir)).toBe(1);

    // `git checkout branch-b`, where the rename already happened: `old.ts` is not in this tree, the
    // committed baseline still names it, and the gitignored record still describes branch A.
    fs.rmSync(path.join(dir, 'src/api/old.ts'));

    expect(await quietCheck(dir)).toBe(1);
    expect(await quietCheck(dir)).toBe(1);
    expect(readBaselineSnapshot(dir).entries.map((e) => e.file)).toEqual(['src/api/old.ts']);
  });

  it('resolves on one `baseline accept` — the recoverable direction ADR 006 chose', async () => {
    // The cost of the trade, made concrete: this is the whole remedy, and it is the same one a user
    // already runs for any newly-introduced violation they intend to keep.
    const dir = await acceptedAndGreen();
    fs.writeFileSync(path.join(dir, 'src/api/new.ts'), VIOLATING_SOURCE);
    await quietCheck(dir);
    fs.rmSync(path.join(dir, 'src/api/old.ts'));
    expect(await quietCheck(dir)).toBe(1);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await baselineAccept(dir)).toBe(0);
    log.mockRestore();

    expect(await quietCheck(dir)).toBe(0);
    expect(readBaselineSnapshot(dir).entries.map((e) => e.file).sort()).toEqual(['src/api/new.ts', 'src/api/old.ts']);
  });
});
