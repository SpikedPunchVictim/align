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
  if (expect.stderrNotContains !== undefined && normalizedRun.stderrNormalized.includes(expect.stderrNotContains)) {
    failures.push(`expected stderr NOT to contain ${JSON.stringify(expect.stderrNotContains)}`);
  }
  if (expect.stdoutMatches !== undefined && !new RegExp(expect.stdoutMatches).test(normalizedRun.stdoutNormalized)) {
    failures.push(`expected stdout to match /${expect.stdoutMatches}/`);
  }
  return { pass: failures.length === 0, failures };
}

/** Evaluates one `mcpCall` step's declarative `expect` block against the captured MCP tool result
 * (`lib/mcp-client.mjs`'s `callMcpTool` return shape) — the same exhaustive-not-short-circuited
 * discipline as `evaluateExpect` above, applied to the smaller `isError`/text vocabulary a tool
 * call actually has (see `spec-validate.mjs`'s `KNOWN_MCP_EXPECT_KEYS` comment for why this is a
 * separate function rather than a `run`-step key reused past what it means). */
export function evaluateMcpExpect(expect, mcpResult) {
  if (expect === undefined) return { pass: true, failures: [] };
  const failures = [];
  if (expect.isError !== undefined && mcpResult.isError !== expect.isError) {
    failures.push(`expected isError ${expect.isError}, got ${mcpResult.isError}`);
  }
  if (expect.textContains !== undefined && !mcpResult.textNormalized.includes(expect.textContains)) {
    failures.push(`expected mcp result text to contain ${JSON.stringify(expect.textContains)}`);
  }
  if (expect.textNotContains !== undefined && mcpResult.textNormalized.includes(expect.textNotContains)) {
    failures.push(`expected mcp result text NOT to contain ${JSON.stringify(expect.textNotContains)}`);
  }
  return { pass: failures.length === 0, failures };
}

/** Evaluates a standalone `assert` step against the snapshot store (label -> captured state,
 * populated by `snapshot:` steps) and the current captured state. `kind` is a small, closed
 * vocabulary — extend deliberately, not by convention, since an unrecognized kind throws rather
 * than silently passing. (Increment 1 needed exactly four; `jsonArrayEveryHasField` was added for
 * the `init`-strips-contentFingerprint scenario, which has to assert on a FIELD's presence across
 * every baseline entry — no existing kind could see inside an array's elements.) */
/**
 * The array a `jsonArray*` assertion is about — "the list, wherever THIS version of align keeps it".
 *
 * Added 2026-08-19 for `.align/baseline.json`'s `{ schemaVersion, entries }` envelope (ADR 006's
 * amendment), and the tolerance is the whole point rather than a convenience. **This harness runs the
 * same scenario against multiple published versions.** 0.1.4 stores the baseline as a bare array;
 * 0.2.0 stores it under `entries`. A strict `path` would make every assertion on that file fail
 * against 0.1.4 — and eight of these scenarios carry `expectFailOn: ['0.1.4']`, so they would still
 * "fail as pinned" while failing at the ASSERTION instead of at the defect they exist to demonstrate.
 * The calibration would go hollow silently, which is precisely the wrong-reason-failure hazard those
 * scenarios' own headers warn about (`run.mjs`'s check can only see pass/fail, never which step).
 *
 * So: an array at the root IS the list, whatever `path` says. Otherwise `path` names the property
 * holding it.
 *
 * The footgun this accepts, stated rather than discovered: a mistyped `path` against a version that
 * stores the list at the root passes anyway. That is the lesser evil against a harness that cannot
 * assert one property across two formats at all, and the mistype is caught the moment the scenario
 * runs against a version that DOES use an envelope.
 *
 * ONE level deep on purpose — a dotted path expression would be a second, untested accessor language
 * living inside a test harness, and every artifact align writes that holds a list holds it at the top.
 */
function arrayUnderPath(parsed, path) {
  if (Array.isArray(parsed)) return parsed;
  if (path === undefined || parsed === null || typeof parsed !== 'object') return undefined;
  return parsed[path];
}

/** ` at 'entries'` for a failure message, or nothing when the assertion was about the root. */
function describePath(path) {
  return path === undefined ? '' : ` at '${path}'`;
}

export function evaluateAssert(assertSpec, snapshots, currentState) {
  const { kind } = assertSpec;
  if (kind === 'fileUnchanged' || kind === 'fileChanged') {
    const since = snapshots.get(assertSpec.since);
    if (since === undefined) throw new Error(`assert: no snapshot named '${assertSpec.since}'`);
    const before = resolveNormalized(since, assertSpec.file);
    const after = resolveNormalized(currentState, assertSpec.file);
    if (before === undefined && after === undefined) {
      // Both undefined means the file was ABSENT at both points, not that it was present and
      // identical. `before === after` alone can't tell those apart (undefined === undefined is
      // true), which is exactly the false-green this function's docstring promises is impossible
      // ("surfaced as a clear failure rather than a false pass on two undefineds") but the code,
      // before this fix, did not deliver. A file that never existed is not "unchanged" — it's a
      // scenario bug (wrong path, or asserting before the file was ever created) — so both
      // fileUnchanged and fileChanged fail loudly here rather than one of them passing vacuously.
      return {
        pass: false,
        failures: [
          `assert ${kind}: '${assertSpec.file}' was absent both at snapshot '${assertSpec.since}' and now — there is nothing to compare, ` +
            'this is very likely a scenario bug (wrong file path, or the assertion runs before the file is ever created)',
        ],
        before,
        after,
      };
    }
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
    const value = arrayUnderPath(JSON.parse(raw), assertSpec.path);
    if (!Array.isArray(value)) {
      return { pass: false, failures: [`'${assertSpec.file}'${describePath(assertSpec.path)} is not a JSON array`] };
    }
    return value.length === assertSpec.equals
      ? { pass: true, failures: [] }
      : { pass: false, failures: [`expected ${assertSpec.file} to have ${assertSpec.equals} entries, got ${value.length}`] };
  }
  if (kind === 'jsonArrayEveryHasField') {
    const raw = resolveNormalized(currentState, assertSpec.file);
    if (raw === undefined) return { pass: false, failures: [`'${assertSpec.file}' is not present`] };
    const value = arrayUnderPath(JSON.parse(raw), assertSpec.path);
    if (!Array.isArray(value)) {
      return { pass: false, failures: [`'${assertSpec.file}'${describePath(assertSpec.path)} is not a JSON array`] };
    }
    // An empty array satisfies BOTH `equals: true` and `equals: false` vacuously — "every entry
    // has it" and "no entry has it" are each trivially true of nothing. That is precisely the
    // false-green F6 fixed for `jsonArrayLength` (a degraded assertion comparing [] with [] and
    // passing without observing anything), so fail loudly rather than let a scenario whose seed
    // silently produced zero entries report success.
    if (value.length === 0) {
      return {
        pass: false,
        failures: [
          `assert jsonArrayEveryHasField: '${assertSpec.file}' is an EMPTY array — this assertion would pass ` +
            'vacuously for either value of `equals`, so it is treated as a scenario bug (the step that was ' +
            'supposed to seed entries produced none).',
        ],
      };
    }
    const nonObjects = value.filter((e) => e === null || typeof e !== 'object').length;
    if (nonObjects > 0) {
      return { pass: false, failures: [`'${assertSpec.file}' has ${nonObjects} entr(ies) that are not objects`] };
    }
    const withField = value.filter((e) => Object.prototype.hasOwnProperty.call(e, assertSpec.field)).length;
    const wanted = assertSpec.equals === true ? value.length : 0;
    return withField === wanted
      ? { pass: true, failures: [] }
      : {
          pass: false,
          failures: [
            `expected every one of ${assertSpec.file}'s ${value.length} entries to ` +
              `${assertSpec.equals === true ? 'HAVE' : 'LACK'} '${assertSpec.field}', but ${withField} of them have it`,
          ],
        };
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
