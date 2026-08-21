/**
 * The red/green calibration check, as a pure function — LEDGER D068.
 *
 * A scenario's `expectFailOn` names the targets it is PINNED to go red against, because it
 * reproduces a defect that version demonstrably has. Ten scenarios carry one today, and the count
 * is the single piece of evidence that this harness can still detect a real regression: "these ten
 * went red on 0.1.4" is only worth something if a pin that stops going red is loud.
 *
 * Extracted from `run.mjs` so it can be tested directly (`calibration.test.mjs`). It was previously
 * a closure over `scenarios`/`matrix` inside `main`, which is why the defect below survived: the
 * one function whose correctness the release gate rests on was the one function nothing could call.
 */

/**
 * @typedef {{ id: string, expectFailOn?: string[] }} PinnedScenario
 * @typedef {{ target: string, scenarioId: string, pass: boolean, errored: boolean }} MatrixRow
 * @typedef {{ pair: string, why: 'PASSED' | 'ERRORED' }} CalibrationBreak
 */

/**
 * Pinned scenario/target pairs that were exercised and did NOT demonstrate the bug they are pinned
 * to demonstrate.
 *
 * A pair that never ran has no row and is skipped — an interrupted run under-reports rather than
 * inventing a break.
 *
 * @param {readonly PinnedScenario[]} scenarios
 * @param {readonly MatrixRow[]} matrix
 * @param {readonly string[]} targets targets exercised by this run
 * @returns {CalibrationBreak[]}
 */
export function calibrationBreaks(scenarios, matrix, targets) {
  const breaks = [];
  for (const scenario of scenarios) {
    for (const target of scenario.expectFailOn ?? []) {
      if (!targets.includes(target)) continue; // not exercised this run — nothing to check
      const m = matrix.find((m2) => m2.target === target && m2.scenarioId === scenario.id);
      if (m === undefined) continue; // never ran
      // Two ways to fail the pin, not one. PASSED means the bug is no longer detected. ERRORED
      // means the assertions never ran, so the pair demonstrated nothing — which is not the same
      // diagnosis, and is emphatically not success.
      if (m.errored) breaks.push({ pair: `${scenario.id}@${target}`, why: 'ERRORED' });
      else if (m.pass) breaks.push({ pair: `${scenario.id}@${target}`, why: 'PASSED' });
    }
  }
  return breaks;
}

/** Renders breaks for a log line: `id@target (PASSED), id2@target (ERRORED)`. */
export function describeBreaks(breaks) {
  return breaks.map((b) => `${b.pair} (${b.why})`).join(', ');
}
