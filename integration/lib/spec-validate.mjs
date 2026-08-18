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
import * as path from 'node:path';

const KNOWN_STEP_ACTION_KEYS = ['install', 'run', 'mutate', 'snapshot', 'assert', 'mcpCall'];
// `keepVersion` (increment 2): opts a `run`/`mcpCall` step OUT of the `known-align-versions`
// normalization rule (lib/normalize.mjs) — needed by any scenario that asserts on a LITERAL
// version number in captured text (e.g. `align upgrade`'s "0.1.3 → 0.1.4" transition line), which
// the default normalization would otherwise scrub to a placeholder before the assertion ever sees
// it. README.md's normalization table already named this as a future requirement ("a future
// version-skew scenario must opt out") — this is that scenario.
const KNOWN_RUN_STEP_KEYS = new Set(['run', 'expect', 'keepVersion']);
const KNOWN_EXPECT_KEYS = new Set(['exit', 'stdoutContains', 'stderrContains', 'stdoutNotContains', 'stderrNotContains', 'stdoutMatches']);
const KNOWN_ASSERT_KEYS_BY_KIND = {
  fileUnchanged: new Set(['kind', 'file', 'since']),
  fileChanged: new Set(['kind', 'file', 'since']),
  jsonArrayLength: new Set(['kind', 'file', 'equals']),
  exists: new Set(['kind', 'file', 'equals']),
  jsonArrayEveryHasField: new Set(['kind', 'file', 'field', 'equals']),
};
// increment 2 (ADR 025 §7 `mcp` row / ADR 024): a step that calls one MCP tool over a real `align
// mcp` child process (lib/mcp-client.mjs) instead of running the CLI directly. Kept as its own step
// kind rather than overloading `run` — a tool call's inputs (`tool` name + structured `arguments`)
// and outputs (`isError` + JSON/text content) have no exit code and no stdout/stderr, so reusing
// `run`'s `expect` vocabulary verbatim would either silently accept meaningless keys (`exit`) or
// require every mcpCall step to carry dead fields — the exact F1 defect class this file exists to
// prevent, just moved one level up.
const KNOWN_MCPCALL_STEP_KEYS = new Set(['mcpCall', 'expect', 'keepVersion']);
const KNOWN_MCPCALL_SPEC_KEYS = new Set(['tool', 'arguments']);
const KNOWN_MCP_EXPECT_KEYS = new Set(['isError', 'textContains', 'textNotContains']);

/**
 * Rejects a duplicate key in any object literal in a scenario's SOURCE — shape S-05's third
 * instance, promoted from a review question to an executable invariant (docs/adr/defects/SHAPES.md).
 *
 * **Why this cannot be checked on the scenario object.** Every other validation in this file
 * inspects the imported value. A duplicate key is invisible there: `{ stdoutContains: 'a',
 * stdoutContains: 'b' }` is legal JavaScript, and by the time `import()` returns, the engine has
 * already discarded the first binding. `Object.keys` sees one key, `validateExpect` sees one key,
 * and the assertion the author wrote FIRST is silently gone. The only place the duplicate still
 * exists is the text on disk, so that is what this reads.
 *
 * **Why it earns an invariant.** Written and caught by hand three times now: LEDGER D006 (an
 * assertion pinned by the next test rather than itself), and twice while writing ADR 028's
 * scenarios — once in `partial-checkout-retains`, where a second `stdoutContains` would have
 * dropped `'Retained 1 entry'` while the scenario still passed. A shape with a second instance has
 * earned promotion so nobody has to remember it; this is the third.
 *
 * The failure mode it prevents is the worst kind this harness has: not a scenario that breaks, but
 * one that keeps passing while asserting less than it claims.
 *
 * Uses the TypeScript compiler's parser (already a devDependency at the repo root, and the same
 * tool `packages/core/test/core-interfaces-doc.test.ts` uses) rather than a regex — a regex over
 * nested object literals inside comments and template strings is exactly the kind of check that
 * appears to work until the day it silently does not, which would make this itself an S-05.
 *
 * Computed keys (`[foo]: 1`) and spreads are skipped: their names are not statically known, so
 * neither a duplicate nor its absence can be established. Scenario files use neither today; if one
 * ever does, this stays silent about it rather than guessing.
 */
export function validateNoDuplicateKeys(sourceText, context, ts) {
  const source = ts.createSourceFile(context, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const problems = [];

  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Map();
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) continue;
        const nameNode = prop.name;
        if (nameNode === undefined || ts.isComputedPropertyName(nameNode)) continue;
        const name = ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode) ? nameNode.text : nameNode.getText(source);
        const previous = seen.get(name);
        if (previous !== undefined) {
          const line = (offset) => source.getLineAndCharacterOfPosition(offset).line + 1;
          problems.push(`'${name}' appears twice in the same object literal (lines ${line(previous)} and ${line(prop.getStart(source))})`);
        } else {
          seen.set(name, prop.getStart(source));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (problems.length > 0) {
    throw new Error(
      `${context}: duplicate object key(s) — ${problems.join('; ')}. JavaScript keeps only the LAST ` +
        'one, so the earlier assertion is silently discarded and the scenario passes while checking ' +
        'less than it appears to (shape S-05). Combine them into a single key — `stdoutMatches` with ' +
        'one regex covers what two `stdoutContains` keys were reaching for.',
    );
  }
}

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
  for (const key of ['stdoutContains', 'stderrContains', 'stdoutNotContains', 'stderrNotContains']) {
    if (expect[key] === '') {
      throw new Error(`${context}: expect.${key} is an empty string, which matches/fails-to-match trivially — use a real, non-empty substring.`);
    }
  }
}

/** Validates a single `mcpCall` step's `expect` block (increment 2 — see `KNOWN_MCP_EXPECT_KEYS`'s
 * comment for why this is a separate vocabulary from `run`'s). Same discipline as
 * `validateExpect`: unknown key throws, empty object throws (asserts nothing), empty-string content
 * check throws (trivially true/false). */
export function validateMcpExpect(expect, context) {
  if (expect === undefined) return;
  if (typeof expect !== 'object' || expect === null || Array.isArray(expect)) {
    throw new Error(`${context}: 'expect' must be a plain object, got ${JSON.stringify(expect)}`);
  }
  const bad = unknownKeys(expect, KNOWN_MCP_EXPECT_KEYS);
  if (bad.length > 0) {
    throw new Error(
      `${context}: expect has unknown key(s) [${bad.join(', ')}] — known keys for an mcpCall step: ${[...KNOWN_MCP_EXPECT_KEYS].join(', ')}.`,
    );
  }
  if (Object.keys(expect).length === 0) {
    throw new Error(`${context}: expect is an empty object — it asserts nothing. Remove the 'expect' block or add a real check.`);
  }
  for (const key of ['textContains', 'textNotContains']) {
    if (expect[key] === '') {
      throw new Error(`${context}: expect.${key} is an empty string, which matches/fails-to-match trivially — use a real, non-empty substring.`);
    }
  }
}

/** Validates a single `mcpCall` step spec: `tool` a non-empty string, `arguments` a plain object
 * (may be `{}` — some tools take no input — but must be present and object-shaped, not omitted,
 * so a scenario author cannot accidentally call a tool with `undefined` arguments by forgetting
 * the field). */
export function validateMcpCallSpec(spec, context) {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new Error(`${context}: 'mcpCall' must be a plain object, got ${JSON.stringify(spec)}`);
  }
  const bad = unknownKeys(spec, KNOWN_MCPCALL_SPEC_KEYS);
  if (bad.length > 0) {
    throw new Error(`${context}: mcpCall has unknown key(s) [${bad.join(', ')}] — known keys: ${[...KNOWN_MCPCALL_SPEC_KEYS].join(', ')}`);
  }
  if (typeof spec.tool !== 'string' || spec.tool.length === 0) {
    throw new Error(`${context}: mcpCall.tool must be a non-empty string`);
  }
  if (typeof spec.arguments !== 'object' || spec.arguments === null || Array.isArray(spec.arguments)) {
    throw new Error(`${context}: mcpCall.arguments must be a plain object (use {} for a tool that takes no input)`);
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
/** A `writeSet` entry must be an exact, repo-relative POSIX path — never a glob (ADR 026 Decision:
 * "each addition to a scenario's write-set" must be independently reviewable/greppable, which a
 * glob defeats), never absolute, never an upward `..` escape (a scenario declaring a path outside
 * its own working copy is certainly a typo, never an intended write). `\` is rejected outright
 * rather than silently accepted-and-ignored: a Windows-style separator would silently fail to match
 * any real POSIX-relative path `lib/write-set.mjs`'s snapshot produces, degrading the declaration
 * into a no-op that still LOOKS like a real entry. */
function validateWriteSetPath(p, context) {
  if (typeof p !== 'string' || p.length === 0) throw new Error(`${context}: every 'writeSet' entry must be a non-empty string`);
  if (path.isAbsolute(p) || p.startsWith('/')) throw new Error(`${context}: writeSet entry '${p}' must be repo-relative, not absolute`);
  if (p.split('/').includes('..')) throw new Error(`${context}: writeSet entry '${p}' must not contain '..'`);
  if (p.includes('\\')) throw new Error(`${context}: writeSet entry '${p}' must use POSIX '/' separators, not '\\'`);
  if (p.includes('*') || p.includes('?')) {
    throw new Error(`${context}: writeSet entry '${p}' looks like a glob — writeSet entries are exact literal paths (ADR 026: every addition is a reviewable event), not patterns`);
  }
}

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
  // ADR 026: absent entirely is the fail-closed default (an empty write-set — see
  // lib/scenario-runner.mjs's `writeSetDeclared = scenario.writeSet ?? []`), so `undefined` is
  // valid and deliberately NOT required here — requiring the key would just push every scenario
  // author to write `writeSet: []` by rote instead of it meaning something when present.
  if (scenario.writeSet !== undefined) {
    if (!Array.isArray(scenario.writeSet)) throw new Error(`${label}: 'writeSet' must be an array of repo-relative path strings`);
    scenario.writeSet.forEach((p, i) => validateWriteSetPath(p, `${label} writeSet[${i}]`));
    const dupes = scenario.writeSet.filter((p, i) => scenario.writeSet.indexOf(p) !== i);
    if (dupes.length > 0) throw new Error(`${label}: 'writeSet' has duplicate entrie(s): ${[...new Set(dupes)].join(', ')}`);
  }
  // ADR 026 item 3 (tiering): `tags` selects scenarios via `--tags` (run.mjs) without a remembered
  // `--scenarios id1,id2,...` list. Same non-empty-string discipline as `expectFailOn` above.
  if (scenario.tags !== undefined) {
    if (!Array.isArray(scenario.tags) || scenario.tags.some((t) => typeof t !== 'string' || t.length === 0)) {
      throw new Error(`${label}: 'tags' must be an array of non-empty tag strings`);
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
      if (step.keepVersion !== undefined && typeof step.keepVersion !== 'boolean') throw new Error(`${context}: 'keepVersion' must be a boolean`);
      validateExpect(step.expect, context);
    } else if (action === 'mcpCall') {
      const bad = unknownKeys(step, KNOWN_MCPCALL_STEP_KEYS);
      if (bad.length > 0) throw new Error(`${context}: mcpCall step has unknown key(s) [${bad.join(', ')}] — known: ${[...KNOWN_MCPCALL_STEP_KEYS].join(', ')}`);
      validateMcpCallSpec(step.mcpCall, context);
      if (step.keepVersion !== undefined && typeof step.keepVersion !== 'boolean') throw new Error(`${context}: 'keepVersion' must be a boolean`);
      validateMcpExpect(step.expect, context);
    } else {
      if (step.expect !== undefined) throw new Error(`${context}: 'expect' is only valid on a 'run' or 'mcpCall' step`);
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
