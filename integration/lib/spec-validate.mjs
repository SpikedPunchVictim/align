// Scenario/spec shape validation — closes the false-green class where a typo'd key in `expect`/
// `assert` is silently ignored (`evaluateExpect`/`evaluateAssert` in lib/assert.mjs only ever
// LOOK at the keys they know about; an unknown key was previously just dead weight, and a spec
// that ends up checking nothing degrades to a tautology that passes on every version, including
// the one it exists to catch red).
//
// Deliberately validated at LOAD time (`run.mjs`'s `loadScenarios`, before any scenario executes)
// rather than at evaluation time: a scenario with a bad spec must not be able to run at all, not
// even partially — "illegal states unrepresentable" (see CODING_BEST_PRACTICES.md §10) applied to
// scenario data: a scenario object that parses is a scenario object that is valid, full stop.

const KNOWN_STEP_ACTION_KEYS = ['install', 'run', 'mutate', 'snapshot', 'assert'];
const KNOWN_RUN_STEP_KEYS = new Set(['run', 'expect']);
const KNOWN_EXPECT_KEYS = new Set(['exit', 'stdoutContains', 'stderrContains', 'stdoutNotContains', 'stdoutMatches']);
const KNOWN_ASSERT_KEYS_BY_KIND = {
  fileUnchanged: new Set(['kind', 'file', 'since']),
  fileChanged: new Set(['kind', 'file', 'since']),
  jsonArrayLength: new Set(['kind', 'file', 'equals']),
  exists: new Set(['kind', 'file', 'equals']),
};

function unknownKeys(obj, known) {
  return Object.keys(obj).filter((k) => !known.has(k));
}

/** Validates a single `expect` block (from a `run` step). Throws on: an unknown key (the exact
 * F1 defect — `stdouContains`/`exitCode` typos silently no-op'd), an expect object with zero keys
 * (asserts nothing — a tautology dressed as a check), or an empty-string `stdoutContains` /
 * `stderrContains` / `stdoutNotContains` (an empty string is a substring of everything /
 * "not contains ''" is never true — either way it's not expressing what the author meant). */
export function validateExpect(expect, context) {
  if (expect === undefined) return;
  if (typeof expect !== 'object' || expect === null || Array.isArray(expect)) {
    throw new Error(`${context}: 'expect' must be a plain object, got ${JSON.stringify(expect)}`);
  }
  const bad = unknownKeys(expect, KNOWN_EXPECT_KEYS);
  if (bad.length > 0) {
    throw new Error(
      `${context}: expect has unknown key(s) [${bad.join(', ')}] — known keys: ${[...KNOWN_EXPECT_KEYS].join(', ')}. ` +
        'A typo\'d key silently asserts nothing; this is a load-time hard error precisely so that can never happen.',
    );
  }
  if (Object.keys(expect).length === 0) {
    throw new Error(`${context}: expect is an empty object — it asserts nothing. Remove the 'expect' block or add a real check.`);
  }
  for (const key of ['stdoutContains', 'stderrContains', 'stdoutNotContains']) {
    if (expect[key] === '') {
      throw new Error(`${context}: expect.${key} is an empty string, which matches/fails-to-match trivially — use a real, non-empty substring.`);
    }
  }
}

/** Validates a single `assert` step spec. Throws on: an unrecognized `kind`, or any key not in
 * that kind's known set (the same class of typo F1 targets, applied to `assert` specs). */
export function validateAssertSpec(assertSpec, context) {
  if (typeof assertSpec !== 'object' || assertSpec === null || Array.isArray(assertSpec)) {
    throw new Error(`${context}: 'assert' must be a plain object, got ${JSON.stringify(assertSpec)}`);
  }
  const known = KNOWN_ASSERT_KEYS_BY_KIND[assertSpec.kind];
  if (known === undefined) {
    throw new Error(`${context}: assert.kind '${assertSpec.kind}' is not recognized — known kinds: ${Object.keys(KNOWN_ASSERT_KEYS_BY_KIND).join(', ')}`);
  }
  const bad = unknownKeys(assertSpec, known);
  if (bad.length > 0) {
    throw new Error(`${context}: assert (kind '${assertSpec.kind}') has unknown key(s) [${bad.join(', ')}] — known keys for this kind: ${[...known].join(', ')}`);
  }
  if (assertSpec.file !== undefined && assertSpec.file === '') {
    throw new Error(`${context}: assert.file is an empty string`);
  }
}

/** Validates one scenario object end to end: `id`/`project` present, `steps` non-empty, each step
 * has exactly one recognized action key, and every `expect`/`assert` payload is well-formed. Also
 * validates the optional `expectFailOn` field (F3 — the red/green calibration guard; see
 * run.mjs's `--expect-fail`/`expectFailOn` handling), if present. */
export function validateScenario(scenario) {
  if (scenario === null || typeof scenario !== 'object') throw new Error('scenario module default export must be a plain object');
  if (typeof scenario.id !== 'string' || scenario.id.length === 0) throw new Error(`scenario is missing a non-empty string 'id'`);
  const label = `scenario '${scenario.id}'`;
  if (typeof scenario.project !== 'string' || scenario.project.length === 0) throw new Error(`${label}: missing a non-empty string 'project'`);
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) throw new Error(`${label}: 'steps' must be a non-empty array`);
  if (scenario.expectFailOn !== undefined) {
    if (!Array.isArray(scenario.expectFailOn) || scenario.expectFailOn.some((t) => typeof t !== 'string' || t.length === 0)) {
      throw new Error(`${label}: 'expectFailOn' must be an array of non-empty target strings`);
    }
  }

  scenario.steps.forEach((step, i) => {
    const context = `${label} step ${i}`;
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      throw new Error(`${context}: must be a plain object`);
    }
    const presentActions = KNOWN_STEP_ACTION_KEYS.filter((k) => step[k] !== undefined);
    if (presentActions.length !== 1) {
      throw new Error(
        `${context}: must have exactly one of [${KNOWN_STEP_ACTION_KEYS.join(', ')}], found [${presentActions.join(', ') || 'none'}]`,
      );
    }
    const action = presentActions[0];

    if (action === 'run') {
      const bad = unknownKeys(step, KNOWN_RUN_STEP_KEYS);
      if (bad.length > 0) throw new Error(`${context}: run step has unknown key(s) [${bad.join(', ')}] — known: ${[...KNOWN_RUN_STEP_KEYS].join(', ')}`);
      if (typeof step.run !== 'string' || step.run.length === 0) throw new Error(`${context}: 'run' must be a non-empty string`);
      validateExpect(step.expect, context);
    } else {
      if (step.expect !== undefined) throw new Error(`${context}: 'expect' is only valid on a 'run' step`);
      if (action === 'install') {
        if (typeof step.install !== 'string' || step.install.length === 0) throw new Error(`${context}: 'install' must be a non-empty string`);
      } else if (action === 'mutate') {
        if (typeof step.mutate !== 'string' || step.mutate.length === 0) throw new Error(`${context}: 'mutate' must be a non-empty string`);
      } else if (action === 'snapshot') {
        if (typeof step.snapshot !== 'string' || step.snapshot.length === 0) throw new Error(`${context}: 'snapshot' must be a non-empty string`);
      } else if (action === 'assert') {
        validateAssertSpec(step.assert, context);
      }
    }
  });
}
