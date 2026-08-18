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

/** The one directory name shared by ADR 028 Stage 4's two mutations and by the scenario's declared
 * write-set — written once so the mutation that CREATES the subtree and the mutation that EXCLUDES
 * it cannot drift apart into two spellings. */
export const HARNESS_VENDORED_DIRNAME = 'harness-vendored';

/** The one directory name shared by ADR 028 Stage 4's partial-checkout mutations and by the scenario's declared
 * write-set — the mutation that CREATES it, the mutation that DELETES it, and the config that points
 * a component at it all read this constant, so they cannot drift into three spellings. */
export const HARNESS_TREE_DIRNAME = 'harness-tree';

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

/**
 * ADR 028 Stage 4. Adds one NEW file inside the violating component, in a subdirectory of its own,
 * carrying the same real import the `introduce-arch-violation` rule forbids — so it produces exactly
 * one extra, real baseline entry at a path this harness controls.
 *
 * A new file rather than an existing nest path, deliberately: the scenario needs a subtree it can
 * later exclude, and excluding any REAL subtree of `packages/core` couples the scenario to nest's
 * internal layout at the pinned commit (and excluding a whole component would empty it, which
 * `validateClassifiedComponents` errors on — that is ADR 023 tier 1's path, not the retention path
 * under test). One synthetic file in a directory nest does not have is layout-independent and still
 * exercises the real classification, resolution and rule-evaluation pipeline end to end.
 *
 * The import is deliberately value-level and decorator-free: it must resolve through the workspace's
 * real `node_modules` link to `packages/common` (the same mechanism the 371 existing entries use),
 * without depending on nest's decorator/TS build configuration.
 */
export function addVendoredViolation(workingDir, project) {
  const { fromComponent } = project.violation;
  const dir = path.join(workingDir, 'packages', fromComponent, HARNESS_VENDORED_DIRNAME);
  if (!fs.existsSync(path.join(workingDir, 'packages', fromComponent))) {
    throw new Error(
      `mutation 'add-vendored-violation': packages/${fromComponent} does not exist in the working copy — ` +
        "the project's `violation.fromComponent` no longer names a real package directory at the pinned commit.",
    );
  }
  writeText(
    path.join(dir, 'copy.ts'),
    "// Written by the integration harness's 'add-vendored-violation' mutation (ADR 028 Stage 4).\n" +
      "// A real cross-package import, in a directory the scenario later excludes, so `align baseline prune`\n" +
      '// has exactly one RETAINED entry to report and `--forget-unscanned` has exactly one to forfeit.\n' +
      "import { Logger } from '@nestjs/common';\n\n" +
      "export const harnessVendoredLogger = new Logger('align-integration-harness');\n",
  );
}

/**
 * ADR 028 Stage 4. Appends an `excludes` export naming the subtree `add-vendored-violation` created,
 * which is what makes its baseline entry unobservable WITHOUT it being fixed — a Stage 1 blind spot
 * of reason `excluded`, and the precise state retention exists for.
 *
 * A plain append, not an anchored insert, for the same reason `enableAllowBaselineFromMcp` appends:
 * `excludes` is a top-level named export with no fixed position in `init`'s generated template
 * (verified: `render-config.ts` never emits one), read by `config.ts`'s loader wherever it appears.
 */
export function excludeVendoredSubtree(workingDir, project) {
  const { file } = readConfig(workingDir);
  const subtree = `packages/${project.violation.fromComponent}/${HARNESS_VENDORED_DIRNAME}`;
  fs.appendFileSync(
    file,
    `\n// Appended by the integration harness's 'exclude-vendored-subtree' mutation (ADR 028 Stage 4).\n` +
      `export const excludes = ['${subtree}/**'];\n`,
    'utf8',
  );
}

/**
 * ADR 028 Stage 4's partial-checkout case, which needs a state no other mutation here can produce:
 * baselined files genuinely GONE from disk (not excluded, not unreadable — absent), so neither of
 * the per-file retention mechanisms saves them and `prune` reaches the mass-delete that two
 * independent reviewers reproduced on 2026-08-17 as "Pruned N fixed violation(s)", exit 0, baseline
 * emptied. Mechanism 3 (the missing-DIRECTORY test) is what must now catch it.
 *
 * It cannot be built on nest's own tree. Deleting `packages/**` would put thousands of paths in the
 * before/after delta, which ADR 026's whole-tree write-set would (correctly) reject as undeclared,
 * and excluding them instead produces a blind spot — which RETAINS the entries, the opposite of what
 * this needs. Emptying a single nest package leaves the other eight grounded, and the floor requires
 * ALL of them (see `scan-blind-spot-retention.ts` for why "any" would break the legitimate "I deleted the
 * legacy directory" prune).
 *
 * So this mutation gives the working copy a one-component world it owns end to end: two files with a
 * real import cycle, and a config declaring exactly one component over them. `empty: 'allow'` is the
 * load-bearing detail and is NOT contrived — it is a policy `align init` itself writes onto any
 * zero-file component (`commands/init.ts`, and onto all of them under `--greenfield`), and it is
 * precisely the policy under which `validateClassifiedComponents` stays silent, so the run reaches
 * the destructive path instead of erroring out through ADR 023 tier 1.
 *
 * Writes the config wholesale rather than editing `init`'s template (the `corrupt-config` precedent)
 * because the point is to REPLACE nine components with one; there is no anchored edit that expresses
 * that. A scenario using this therefore never runs `align init`, so no marker block or `CLAUDE.md`
 * exists to protect — which is why `checkMarkerOwnedRegion` has nothing to say about it.
 */
export function useSingleComponentTree(workingDir) {
  writeText(
    path.join(workingDir, HARNESS_TREE_DIRNAME, 'a.ts'),
    "// Written by the integration harness's 'use-single-component-tree' mutation (ADR 028 Stage 4).\n" +
      "import { fromB } from './b.js';\n\n" +
      'export function fromA(): string {\n  return `a:${fromB()}`;\n}\n',
  );
  writeText(
    path.join(workingDir, HARNESS_TREE_DIRNAME, 'b.ts'),
    "// Written by the integration harness's 'use-single-component-tree' mutation (ADR 028 Stage 4).\n" +
      "import { fromA } from './a.js';\n\n" +
      "export function fromB(): string {\n  return typeof fromA === 'function' ? 'b' : 'b';\n}\n",
  );
  writeText(
    configPath(workingDir),
    "// Written by the integration harness's 'use-single-component-tree' mutation (ADR 028 Stage 4).\n" +
      "import { defineProject } from '@spikedpunch/align-core/dsl';\n\n" +
      'export default defineProject({\n' +
      `  components: { app: { pattern: '${HARNESS_TREE_DIRNAME}/**', empty: 'allow' } },\n` +
      // Scoped to the component, NOT `'repo'`: a repo-wide cycle rule would also report nest's own
      // 18 real cycles (see upgrade-with-existing-baseline.mjs's measurement), making the seed
      // count depend on nest's internals and mixing entries the deletion below does not affect into
      // the very set this scenario is asserting about.
      '  rules: (c) => [c.arch.noCycles(c.app)],\n' +
      '});\n',
  );
}

/** The other half of `use-single-component-tree`: removes the directory outright, so the accepted
 * baseline entries point at paths that are simply not there. No blind spot can cover an absent
 * directory and the file-existence probe answers false, so ADR 028's mechanisms 1 and 2 both
 * correctly decline to retain — which is why mechanism 3, the missing-DIRECTORY test, has to catch
 * it. (An earlier version of this comment named a "whole-run floor"; that guard was removed on
 * 2026-08-17 for missing this very case. See docs/adr/defects/D001-floor-missed-partial-checkout.md.) */
export function deleteSingleComponentTree(workingDir) {
  const dir = path.join(workingDir, HARNESS_TREE_DIRNAME);
  if (!fs.existsSync(dir)) {
    throw new Error(`mutation 'delete-single-component-tree': ${dir} does not exist — run 'use-single-component-tree' first`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export const MUTATIONS = {
  'shadow-component': (ctx) => shadowComponent(ctx.workingDir),
  'use-single-component-tree': (ctx) => useSingleComponentTree(ctx.workingDir),
  'delete-single-component-tree': (ctx) => deleteSingleComponentTree(ctx.workingDir),
  'add-vendored-violation': (ctx) => addVendoredViolation(ctx.workingDir, ctx.project),
  'exclude-vendored-subtree': (ctx) => excludeVendoredSubtree(ctx.workingDir, ctx.project),
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
