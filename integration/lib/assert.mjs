// Declarative assertion evaluation — ADR 025 §1 "no AI in the loop": every assertion here is a
// pure data comparison over captured state. Nothing in this file makes a judgment call; it either
// matches the declared expectation or it doesn't.

const ALIGN_DIR_FILE_RE = /^\.align\/(.+)$/;

/** Resolves a scenario-declared `file:` path (`'.align/baseline.json'`, `'align.config.ts'`,
 * `'CLAUDE.md'`) against a captured-state object (`lib/capture.mjs`'s `captureState` output) to
 * the normalized text used for comparison. Returns `undefined` if the file wasn't present at
 * capture time — a scenario asserting `fileUnchanged` against a file that never existed is a
 * scenario bug, surfaced as a clear failure rather than a false pass on two `undefined`s. */
function resolveNormalized(state, file) {
  if (file === 'align.config.ts') return state.alignConfig.present ? state.alignConfig.normalized : undefined;
  if (file === 'CLAUDE.md') return state.claudeMdBlock.present ? state.claudeMdBlock.normalized : undefined;
  const m = ALIGN_DIR_FILE_RE.exec(file);
  if (m) {
    const entry = state.alignFiles[m[1]];
    return entry !== undefined && entry.present ? entry.normalized : undefined;
  }
  throw new Error(`assert: don't know how to resolve file '${file}' — expected 'align.config.ts', 'CLAUDE.md', or '.align/<name>'`);
}

/** Evaluates one `run` step's declarative `expect` block against the captured (unnormalized-exit,
 * normalized-text) run result. Every configured check runs — the returned failure list is
 * exhaustive, not short-circuited on the first mismatch, so a single failed step's report shows
 * everything that was wrong, not just the first thing. */
export function evaluateExpect(expect, normalizedRun) {
  if (expect === undefined) return { pass: true, failures: [] };
  const failures = [];
  if (expect.exit !== undefined && normalizedRun.exitCode !== expect.exit) {
    failures.push(`expected exit ${expect.exit}, got ${normalizedRun.exitCode}`);
  }
  if (expect.stdoutContains !== undefined && !normalizedRun.stdoutNormalized.includes(expect.stdoutContains)) {
    failures.push(`expected stdout to contain ${JSON.stringify(expect.stdoutContains)}`);
  }
  if (expect.stderrContains !== undefined && !normalizedRun.stderrNormalized.includes(expect.stderrContains)) {
    failures.push(`expected stderr to contain ${JSON.stringify(expect.stderrContains)}`);
  }
  if (expect.stdoutNotContains !== undefined && normalizedRun.stdoutNormalized.includes(expect.stdoutNotContains)) {
    failures.push(`expected stdout NOT to contain ${JSON.stringify(expect.stdoutNotContains)}`);
  }
  if (expect.stdoutMatches !== undefined && !new RegExp(expect.stdoutMatches).test(normalizedRun.stdoutNormalized)) {
    failures.push(`expected stdout to match /${expect.stdoutMatches}/`);
  }
  return { pass: failures.length === 0, failures };
}

/** Evaluates a standalone `assert` step against the snapshot store (label -> captured state,
 * populated by `snapshot:` steps) and the current captured state. `kind` is a small, closed
 * vocabulary (ADR 025 increment 1 needs exactly these four) — extend deliberately, not by
 * convention, since an unrecognized kind throws rather than silently passing. */
export function evaluateAssert(assertSpec, snapshots, currentState) {
  const { kind } = assertSpec;
  if (kind === 'fileUnchanged' || kind === 'fileChanged') {
    const since = snapshots.get(assertSpec.since);
    if (since === undefined) throw new Error(`assert: no snapshot named '${assertSpec.since}'`);
    const before = resolveNormalized(since, assertSpec.file);
    const after = resolveNormalized(currentState, assertSpec.file);
    const identical = before === after;
    if (kind === 'fileUnchanged') {
      return identical
        ? { pass: true, failures: [] }
        : { pass: false, failures: [`expected '${assertSpec.file}' unchanged since '${assertSpec.since}', but it differs`], before, after };
    }
    return identical
      ? { pass: false, failures: [`expected '${assertSpec.file}' to differ from snapshot '${assertSpec.since}', but it is identical`], before, after }
      : { pass: true, failures: [] };
  }
  if (kind === 'jsonArrayLength') {
    const raw = resolveNormalized(currentState, assertSpec.file);
    if (raw === undefined) return { pass: false, failures: [`'${assertSpec.file}' is not present`] };
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return { pass: false, failures: [`'${assertSpec.file}' is not a JSON array`] };
    return value.length === assertSpec.equals
      ? { pass: true, failures: [] }
      : { pass: false, failures: [`expected ${assertSpec.file} to have ${assertSpec.equals} entries, got ${value.length}`] };
  }
  if (kind === 'exists') {
    const raw = resolveNormalized(currentState, assertSpec.file);
    const present = raw !== undefined;
    return present === assertSpec.equals
      ? { pass: true, failures: [] }
      : { pass: false, failures: [`expected exists('${assertSpec.file}') === ${assertSpec.equals}, got ${present}`] };
  }
  throw new Error(`assert: unknown kind '${kind}'`);
}
