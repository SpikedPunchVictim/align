// Named, reusable repo mutations (ADR 025 §3's scenario shape: `{ mutate: 'shadow-component' }`).
// Each mutation is a pure filesystem edit against a working copy's `align.config.ts` — never
// against `.align/*` (mutating align's own output would be cheating the oracle, not testing it).
//
// `align.config.ts` is matched by exact substring against the literal template
// `packages/cli/src/init/render-config.ts` renders (see that file). If `render-config.ts`'s
// template ever changes, these anchors need updating together with it — there is no parser here,
// deliberately: a text anchor that breaks LOUDLY (throws, "anchor not found") on template drift is
// preferable to a permissive one that silently mutates the wrong thing.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeText } from './fs-utils.mjs';

function configPath(workingDir) {
  return path.join(workingDir, 'align.config.ts');
}

function readConfig(workingDir) {
  const file = configPath(workingDir);
  if (!fs.existsSync(file)) {
    throw new Error(`mutation: ${file} does not exist — run \`align init\` before mutating the config`);
  }
  return { file, text: fs.readFileSync(file, 'utf8') };
}

function replaceAnchorOnce(text, anchor, replacement, mutationName) {
  const idx = text.indexOf(anchor);
  if (idx === -1) {
    throw new Error(
      `mutation '${mutationName}': anchor ${JSON.stringify(anchor)} not found in align.config.ts — ` +
        'the render-config.ts template this mutation targets may have changed.',
    );
  }
  return text.slice(0, idx) + replacement + text.slice(idx + anchor.length);
}

/**
 * Prepends a component whose selector (`**` — every path) matches the entire repo, declared
 * BEFORE every real component. align classifies files first-match-wins (`registry.ts`'s
 * `classifyFile`), so every subsequently-declared component (their selectors never get a chance
 * to match) ends up with zero files classified to it this scan — `validateClassifiedComponents`
 * throws a `ComponentValidationError` for the first such component it encounters, which
 * `orchestrator.check()` turns into `verdict: 'error'` with every gate reporting `violations: []`
 * (bug hunt 2026-08-08, BUG #18; `packages/core/src/orchestrator.ts` lines ~120-135;
 * `packages/core/src/components/registry.ts`'s `validateClassifiedComponents`). This is the
 * REAL, reliable trigger for an errored run the prune-destroys-baseline scenario needs — not a
 * synthetic error injection.
 */
export function shadowComponent(workingDir) {
  const { file, text } = readConfig(workingDir);
  const anchor = 'components: {\n';
  const replacement =
    `components: {\n` +
    `    // Inserted by the integration harness's 'shadow-component' mutation: matches every file, ` +
    `declared first, so every real component below it gets zero files classified (first-match-wins) ` +
    `and \`align check\` errors instead of evaluating anything.\n` +
    `    harnessShadowAll: '**',\n`;
  fs.writeFileSync(file, replaceAnchorOnce(text, anchor, replacement, 'shadow-component'), 'utf8');
}

/**
 * Inserts a real `arch.layer(from).cannotDependOn(to)` rule using the project's `violation`
 * descriptor (`projects/nest.mjs`). Forbidding a dependency the pinned commit genuinely has (in
 * either direction — checked once by grep at project-definition time, see that file's comment)
 * produces a real, deterministic violation set tied to real files, rather than a synthetic one
 * the scan can't actually find. Used both by the prune scenario (to seed real baseline debt
 * before shadowing) and the check scenario (green -> red).
 */
function archViolationRuleLine(project) {
  const { fromComponent, toComponent, because } = project.violation;
  return `    c.arch.layer(c.${fromComponent}).cannotDependOn(c.${toComponent}).because(${JSON.stringify(because)}),\n`;
}

export function introduceArchViolation(workingDir, project) {
  const { file, text } = readConfig(workingDir);
  const anchor = 'rules: (c) => [\n';
  const replacement =
    `rules: (c) => [\n` +
    `    // Inserted by the integration harness's 'introduce-arch-violation' mutation.\n` +
    archViolationRuleLine(project);
  fs.writeFileSync(file, replaceAnchorOnce(text, anchor, replacement, 'introduce-arch-violation'), 'utf8');
}

/**
 * Undoes exactly `introduceArchViolation`'s edit — removes the comment + rule line it inserted,
 * leaving everything else in `align.config.ts` (including any OTHER mutation's edits, e.g.
 * `addNoCyclesRule`'s) untouched. Increment 2's upgrade-churn scenario uses this to construct a
 * real, deterministic PRUNE-actionable item: accept a baseline while the rule is active, then
 * retire the rule before re-checking — every one of its previously-accepted entries is now
 * genuinely orphaned (the rule that produced them no longer runs at all), which is a legitimate,
 * common shape of upgrade-time baseline churn ("a rule was removed between versions") and is used
 * here SPECIFICALLY so the consent-gating mechanism (`align upgrade` without `--yes` must refuse to
 * prune; `--yes` must reconcile) has something real to gate on regardless of whether this pinned
 * nest commit happens to exercise the OTHER churn mechanism this harness measures
 * (`arch.no-cycles` chain extraction, `addNoCyclesRule`) — the two are intentionally independent so
 * a zero measurement on one never silently defeats the other's assertions. Documented in the
 * scenario file as a CONSTRUCTED actionable item, never described as measured cross-version churn.
 */
export function removeArchViolationRule(workingDir, project) {
  const { file, text } = readConfig(workingDir);
  const inserted = `    // Inserted by the integration harness's 'introduce-arch-violation' mutation.\n` + archViolationRuleLine(project);
  const idx = text.indexOf(inserted);
  if (idx === -1) {
    throw new Error(`mutation 'remove-arch-violation-rule': could not find introduce-arch-violation's inserted block in align.config.ts — was it applied first?`);
  }
  fs.writeFileSync(file, text.slice(0, idx) + text.slice(idx + inserted.length), 'utf8');
}

/**
 * Overwrites `align.config.ts` with a deliberately broken file (unterminated object literal, not
 * valid TypeScript) — `align doctor`'s "corrupt config" scenario (ADR 025 coverage table:
 * "doctor's always-zero exit ... including on a config error"). Distinct from `shadowComponent`:
 * that produces a well-formed config whose *runtime evaluation* errors (a valid rule referencing
 * a now-empty component); this produces a config that fails to even PARSE/import.
 */
export function corruptConfig(workingDir) {
  const { file } = readConfig(workingDir);
  fs.writeFileSync(
    file,
    "import { defineProject } from '@spikedpunch/align-core/dsl';\n\n// Deliberately corrupted by the integration harness's 'corrupt-config' mutation.\nexport default defineProject({\n  components: {\n",
    'utf8',
  );
}

/**
 * Inserts a real `arch.noCycles('repo')` rule using `replaceAnchorOnce` the same way
 * `introduceArchViolation` does. Increment 2 (ADR 025 §"a measurement question you must answer
 * honestly"): the `align upgrade` baseline-churn mechanism this harness exists to make
 * reproducible is specifically `arch.no-cycles` chain-extraction (BFS vs. the old greedy walk) —
 * `arch.layer`/`arch.no-dependency` (the rule the other mutations here exercise) never touches that
 * code path at all. A churn scenario MUST use this rule, not `introduceArchViolation`'s, or it
 * measures nothing relevant to the mechanism under test.
 */
export function addNoCyclesRule(workingDir) {
  const { file, text } = readConfig(workingDir);
  const anchor = 'rules: (c) => [\n';
  const replacement =
    `rules: (c) => [\n` +
    `    // Inserted by the integration harness's 'add-no-cycles-rule' mutation (ADR 025 upgrade-churn scenario).\n` +
    `    c.arch.noCycles('repo').because('integration harness: repo-wide import-cycle detection, to measure ` +
    `arch.no-cycles baseline churn across align versions'),\n`;
  fs.writeFileSync(file, replaceAnchorOnce(text, anchor, replacement, 'add-no-cycles-rule'), 'utf8');
}

/**
 * Writes a minimal `docs/ARCHITECTURE-RULES.md` (ADR 011's default doc path,
 * `commands/build.ts`'s `DEFAULT_DOC_PATH`) — increment 2's `mcp`/`build` scenarios need this file
 * to exist (`align_propose_rules`/`align build` both refuse with "Doc not found" otherwise); its
 * exact prose content is NOT what grounds a submitted MCP proposal (`groundFragment` grounds by
 * selector against the live component registry, not by parsing this text) — see
 * `packages/cli/test/mcp-baseline-gate.test.ts` for the same pattern against its own fixture doc.
 * Kept realistic (a heading + a one-line rule statement) rather than empty, so a human reading the
 * captured artifact sees a real doc, not a placeholder.
 */
export function writeArchitectureRulesDoc(workingDir) {
  writeText(
    path.join(workingDir, 'docs', 'ARCHITECTURE-RULES.md'),
    '# Architecture Rules\n\n## core-isolation\n\n`core` must not depend on `common`.\n' +
      '(Written by the integration harness\'s \'write-architecture-rules-doc\' mutation.)\n',
  );
}

/**
 * Appends a line to the doc `writeArchitectureRulesDoc` wrote — `align build --verify`'s
 * "doc-drift" scenario (ADR 025 §7 `build` row: "`--verify` after a doc edit"): the doc's content
 * hash no longer matches what `rules.lock.json` recorded at the last `--apply`, so `--verify` must
 * go red. A separate mutation (rather than reusing `writeArchitectureRulesDoc` a second time with
 * different inline content) because a named mutation documents ONE fixed edit, matching every
 * other mutation in this file — see this module's header comment.
 */
/**
 * Like `writeArchitectureRulesDoc`, but with a real FENCED ```align block (ADR 011 tier 1 —
 * portable-JSON rule syntax, `docs/ARCHITECTURE-RULES.md`'s own format, e.g.
 * `{"kind":"arch.no-dependency","from":"core","to":"common"}`) instead of plain prose. `align
 * build`'s deterministic doc-compile pipeline (no MCP client, no proposals) only ever picks up
 * fenced blocks and structured `- **Rule**:` bullets — prose needs an MCP client's judgment
 * (`proposeRulesFromDoc`) — so the `build` scenarios (dry-run / `--apply` / `--verify`) need this
 * variant, distinct from `writeArchitectureRulesDoc`'s prose-only content the `mcp` scenario uses.
 */
export function writeArchitectureRulesDocWithFencedRule(workingDir) {
  writeText(
    path.join(workingDir, 'docs', 'ARCHITECTURE-RULES.md'),
    '# Architecture Rules\n\n' +
      '## core-isolation\n\n' +
      '```align\n' +
      '{"kind":"arch.no-dependency","from":"core","to":"common"}\n' +
      '```\n\n' +
      "(Written by the integration harness's 'write-architecture-rules-doc-with-fenced-rule' mutation.)\n",
  );
}

export function editArchitectureRulesDoc(workingDir) {
  const file = path.join(workingDir, 'docs', 'ARCHITECTURE-RULES.md');
  if (!fs.existsSync(file)) {
    throw new Error(`mutation 'edit-architecture-rules-doc': ${file} does not exist — run 'write-architecture-rules-doc' first`);
  }
  fs.appendFileSync(file, "\n## drift-marker\n\nEdited by the integration harness's 'edit-architecture-rules-doc' mutation.\n", 'utf8');
}

/**
 * Appends `export const allowBaselineFromMcp = true;` to `align.config.ts` — the human-only,
 * config-file opt-in ADR 024 requires for `align_propose_rules`'s `accept_new_into_baseline` gate
 * (`mcp/baseline-gate.ts`'s `decideMcpBaselineWrite`). A plain append (not a
 * `replaceAnchorOnce`-style anchored insert) is correct here specifically because this export has
 * no fixed position in `init`'s generated template — `config.ts`'s loader reads it as a top-level
 * named export wherever it appears in the file, unlike `components`/`rules` which live inside the
 * single `defineProject({...})` call the other mutations edit in place.
 */
export function enableAllowBaselineFromMcp(workingDir) {
  const { file } = readConfig(workingDir);
  fs.appendFileSync(file, '\nexport const allowBaselineFromMcp = true;\n', 'utf8');
}

export const MUTATIONS = {
  'shadow-component': (ctx) => shadowComponent(ctx.workingDir),
  'introduce-arch-violation': (ctx) => introduceArchViolation(ctx.workingDir, ctx.project),
  'remove-arch-violation-rule': (ctx) => removeArchViolationRule(ctx.workingDir, ctx.project),
  'corrupt-config': (ctx) => corruptConfig(ctx.workingDir),
  'add-no-cycles-rule': (ctx) => addNoCyclesRule(ctx.workingDir),
  'write-architecture-rules-doc': (ctx) => writeArchitectureRulesDoc(ctx.workingDir),
  'write-architecture-rules-doc-with-fenced-rule': (ctx) => writeArchitectureRulesDocWithFencedRule(ctx.workingDir),
  'edit-architecture-rules-doc': (ctx) => editArchitectureRulesDoc(ctx.workingDir),
  'enable-allow-baseline-from-mcp': (ctx) => enableAllowBaselineFromMcp(ctx.workingDir),
};

export function applyMutation(name, ctx) {
  const fn = MUTATIONS[name];
  if (fn === undefined) throw new Error(`unknown mutation '${name}' — known: ${Object.keys(MUTATIONS).join(', ')}`);
  fn(ctx);
}
