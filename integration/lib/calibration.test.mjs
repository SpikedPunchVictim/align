/**
 * LEDGER D068 — a pinned scenario that ERRORED was counted as calibration success.
 *
 * `expectFailOn` claims a scenario goes red against a target *by failing its assertions*, because
 * that version has the defect. The check only ever asked `m.pass`, so a pinned pair that blew up
 * before reaching its assertions — an install failure, a Docker hiccup, a harness bug — satisfied
 * the pin. The run then printed "all N pinned scenario(s) went RED as required" on evidence it had
 * never collected, and exited 0.
 *
 * That sentence is the release gate's whole calibration claim, and CLAUDE.md instructs a human to
 * read it. [S-13: the failure disables the instrument that would report it.]
 *
 * `run.mjs` already draws this distinction correctly one arm over — working-copy retention computes
 * `!result.pass && !result.errored && pinnedToFailHere`, with a comment saying in so many words
 * that a pin "never" covers the harness itself blowing up. One arm fixed, the other missed [S-09].
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { calibrationBreaks, describeBreaks } from './calibration.mjs';

const PINNED = [{ id: 'a', expectFailOn: ['0.1.4'] }];
const row = (over) => ({ target: '0.1.4', scenarioId: 'a', pass: false, errored: false, ...over });

describe('red/green calibration (LEDGER D068)', () => {
  it('a pinned pair that FAILED its assertions is the required outcome — no break', () => {
    assert.deepEqual(calibrationBreaks(PINNED, [row()], ['0.1.4']), []);
  });

  it('a pinned pair that PASSED is a break', () => {
    const breaks = calibrationBreaks(PINNED, [row({ pass: true })], ['0.1.4']);
    assert.deepEqual(breaks, [{ pair: 'a@0.1.4', why: 'PASSED' }]);
  });

  it('a pinned pair that ERRORED is a break — its assertions never ran', () => {
    // The defect. `pass:false` alone satisfied the old check, so a harness error read as proof.
    const breaks = calibrationBreaks(PINNED, [row({ errored: true })], ['0.1.4']);
    assert.deepEqual(breaks, [{ pair: 'a@0.1.4', why: 'ERRORED' }]);
  });

  it('reports WHY, so the two are not conflated in the log', () => {
    // PASSED and ERRORED are opposite diagnoses: one says the bug is gone or the assertion rotted,
    // the other says nothing was learned. A reader deciding whether to ship needs to know which.
    const breaks = calibrationBreaks(
      [{ id: 'a', expectFailOn: ['0.1.4'] }, { id: 'b', expectFailOn: ['0.1.4'] }],
      [row({ pass: true }), row({ scenarioId: 'b', errored: true })],
      ['0.1.4'],
    );
    assert.equal(describeBreaks(breaks), 'a@0.1.4 (PASSED), b@0.1.4 (ERRORED)');
  });

  it('a pair that never ran is not a break — an interrupted run under-reports', () => {
    assert.deepEqual(calibrationBreaks(PINNED, [], ['0.1.4']), []);
  });

  it('a target this run did not exercise is not checked', () => {
    assert.deepEqual(calibrationBreaks(PINNED, [row({ pass: true })], ['local']), []);
  });

  it('an unpinned scenario is never a break, however it went', () => {
    const unpinned = [{ id: 'a' }];
    assert.deepEqual(calibrationBreaks(unpinned, [row({ pass: true })], ['0.1.4']), []);
    assert.deepEqual(calibrationBreaks(unpinned, [row({ errored: true })], ['0.1.4']), []);
  });
});
