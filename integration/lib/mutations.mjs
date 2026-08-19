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
/**
 * Truncates `.align/last-scan.json` mid-object — the shape a process killed during a write leaves
 * behind, and the exact input ADR 029 §7.4 originally said should throw (LEDGER D021).
 *
 * The property the scenario using this checks is that align keeps working: a gitignored,
 * machine-local cache that align itself creates and replaces must never be able to block a command,
 * because the user cannot see it in `git status` and has no reason to look for it. ADR 030 §4 was
 * amended for the same misapplied rule one day earlier, on `.align/.lock`, where it bricked the
 * repository it was protecting.
 */
export function corruptLastScanRecord(workingDir) {
  const file = path.join(workingDir, '.align', 'last-scan.json');
  if (!fs.existsSync(file)) {
    // Loud, not a silent no-op: this mutation exists to corrupt a record a previous step created, so
    // an absent file means the scenario is asserting against a state it never reached.
    throw new Error(`corrupt-last-scan-record: ${file} does not exist — the preceding \`align check\` did not write it`);
  }
  fs.writeFileSync(file, '{"recordVersion":1,"observed":{"sou', 'utf8');
}

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
/** The subtree ADR 028 Stage 5's three retention scenarios hide, and the directory they stash it
 * in when the hiding mechanism is a symlink. Named here so the mutation that CREATES the world, the
 * three that HIDE it, and every scenario write-set read one spelling. */
export const HARNESS_HIDEABLE_DIRNAME = 'hidden';
export const HARNESS_STASH_DIRNAME = 'harness-stash';
export const HARNESS_BAIT_DIRNAME = 'bait';
export const HARNESS_FORBIDDEN_DIRNAME = 'harness-forbidden';

/**
 * ADR 028 Stage 5. Builds the world the symlink / unreadable-directory / excludes-shrink scenarios
 * share: a self-owned tree whose scan is `complete: true`, so `prune` reaches the destructive path
 * and the exit-0 form of the defect is reachable — nest's own scan is `complete: false` at the
 * pinned commit, which makes ADR 023 tier 2 refuse first and hides the very behaviour under test
 * (`partial-checkout-retains.mjs` documents that displacement in detail).
 *
 * The shape is chosen so each of ADR 028's mechanisms is exercised in isolation:
 *
 * - `harness-tree/keep.ts` is never hidden, so the component stays grounded and the run stays
 *   complete. Without it, hiding the subtree would make every component ungrounded and the ADR 023
 *   tier-2 refusal added in Stage 4 would be what stops the deletion — a real guard, but not the
 *   one these scenarios exist to pin.
 * - `harness-tree/hidden/{c,d}.ts` carry the accepted entries. They live one directory DOWN so that
 *   hiding them leaves their parent observed: mechanism 3 (the missing-DIRECTORY test) therefore
 *   cannot be what retains them, and the assertion is about mechanism 1 (the blind-spot record).
 * - A dependency-direction rule, not `noCycles`: a cycle needs two mutually-importing files, so no
 *   single added file can reproduce one, and these scenarios need a THIRD file whose violation is
 *   byte-identical to an accepted one (`add-transfer-bait`) to make the forged-transfer assertion
 *   non-vacuous.
 */
export function useHideableSubtreeWorld(workingDir) {
  writeText(
    path.join(workingDir, HARNESS_FORBIDDEN_DIRNAME, 'target.ts'),
    "// Written by the integration harness's 'use-hideable-subtree-world' mutation (ADR 028 Stage 5).\n" +
      "export const forbiddenValue = 'forbidden';\n",
  );
  writeText(
    path.join(workingDir, HARNESS_TREE_DIRNAME, 'keep.ts'),
    "// Written by the integration harness's 'use-hideable-subtree-world' mutation (ADR 028 Stage 5).\n" +
      '// Deliberately clean, and deliberately never hidden: it is what keeps the component grounded\n' +
      '// so an ADR 023 tier-2 refusal cannot stand in for the retention being tested.\n' +
      "export const keep = 'keep';\n",
  );
  for (const name of ['c', 'd']) {
    writeText(
      path.join(workingDir, HARNESS_TREE_DIRNAME, HARNESS_HIDEABLE_DIRNAME, `${name}.ts`),
      violatingSource(name),
    );
  }
  writeText(
    configPath(workingDir),
    "// Written by the integration harness's 'use-hideable-subtree-world' mutation (ADR 028 Stage 5).\n" +
      "import { defineProject } from '@spikedpunch/align-core/dsl';\n\n" +
      'export default defineProject({\n' +
      '  components: {\n' +
      `    app: '${HARNESS_TREE_DIRNAME}/**',\n` +
      `    forbidden: '${HARNESS_FORBIDDEN_DIRNAME}/**',\n` +
      '  },\n' +
      // No `empty:` policy, deliberately: `keep.ts` and `target.ts` are never hidden, so neither
      // component is ever empty and the default `'fail'` policy is never reached. That keeps the
      // config to vocabulary every published version understands, which is what lets these
      // scenarios be installed with `install: 'target'` and calibrated with `expectFailOn`.
      '  rules: (c) => [c.arch.layer(c.app).cannotDependOn(c.forbidden)],\n' +
      '});\n',
  );
}

/** One violating file's source. `name` appears only in the exported symbol, never in the import
 * line, so `bait.ts` below can be byte-identical to `c.ts` in the construct the fingerprint is
 * taken over — which is the whole point of the bait. */
function violatingSource(name) {
  return (
    "// Written by the integration harness (ADR 028 Stage 5): a real forbidden cross-component import.\n" +
    `import { forbiddenValue } from '../../${HARNESS_FORBIDDEN_DIRNAME}/target.js';\n\n` +
    `export const uses${name.toUpperCase()} = forbiddenValue;\n`
  );
}

/**
 * ADR 028 Stage 5. Adds an UNACCEPTED violation whose content fingerprint matches an accepted
 * entry's, at a path the scan can still see.
 *
 * This is what makes "`align check` did not forge a transfer" a real assertion rather than a
 * tautology. `reconcileMoves` runs on every plain `align check` and matches an orphaned entry to a
 * live violation by content fingerprint (FRAGILE #7); with no fingerprint-identical candidate on
 * disk there is nothing for it to match, so a scenario that omits this step would assert that a
 * transfer did not happen in a world where none could — shape S-05, an assertion that passes
 * whether or not the property holds (LEDGER D006 is the same shape).
 *
 * Must run AFTER the baseline is seeded: the point is that this violation was never reviewed, so a
 * transfer onto it forges consent (LEDGER D010, D015).
 */
/**
 * LEDGER D015, the file-level sibling of D010: delete ONE accepted file and leave its sibling behind.
 *
 * Every detail is chosen so that the three ADR 028 mechanisms decline and the transfer arm is
 * genuinely reached — which is what makes a scenario using this an assertion about ADR 029's
 * refusal rather than about a guard that already existed:
 *
 * - the file is really gone from disk, so mechanism 2 (the file-existence probe) answers false;
 * - nothing was excluded, symlinked or made unreadable, so mechanism 1 records no blind spot;
 * - `d.ts` stays, so `harness-tree/hidden/` still produces an observed file and mechanism 3 (the
 *   missing-DIRECTORY test, ADR 006's amendment) does not fire. Deleting the whole directory would
 *   make THAT the guard under test and this scenario would pass without ADR 029 existing [S-05].
 *
 * Uses `d.ts`'s survival rather than a second bait for the same reason `useHideableSubtreeWorld`
 * keeps `keep.ts`: the cheapest way to hold one variable still.
 */
/**
 * Rewinds `.align/version.json` to a repository that was last reconciled under 0.1.4 — BOTH fields,
 * which is what a real post-ADR-022 repository on that version looks like (`align init` writes
 * `baselineReconciledBy` unconditionally on every run).
 *
 * Exists for LEDGER D028's reproduction, and it has to be a mutation rather than a sequence of real
 * commands: local binaries always stamp both fields to the CURRENT version, so there is no way to
 * reach "reconciled under an older version" by running align. Rewinding the stamp is the honest
 * stand-in — it is exactly the state a real 0.1.4-era repository is in the moment its binary is
 * upgraded.
 *
 * Throws if the file is absent rather than creating one: a scenario that reaches here without an
 * `init` has not set up what it thinks it has, and inventing the file would let it pass while testing
 * a state no user can be in.
 */
/**
 * Plants the lock a crashed align on ANOTHER machine would leave behind — and, since `.align/.lock`
 * was gitignored nowhere until 2026-08-19, the lock a single `git add -A` would then commit into the
 * repository for everyone (LEDGER D029).
 *
 * Two years old, deliberately: the point is that no amount of age used to clear it. `host` must not be
 * this machine's, or the same-host liveness path would handle it and the scenario would pin the wrong
 * branch.
 */
export function plantForeignHostLock(workingDir) {
  plantLock(workingDir, '2024-01-01T00:00:00.000Z');
}

/**
 * The same lock, but ACQUIRED JUST NOW — i.e. another align that is genuinely mid-write, rather than
 * one that died. Below `FOREIGN_HOST_STALE_AFTER_MS`, so it is not breakable and the waiting command
 * must time out and refuse.
 *
 * This is how the harness reaches "two aligns overlapping" without a background-step primitive: the
 * lock IS align's representation of another align holding the repository, so planting a live one is a
 * faithful stand-in for the process that would have taken it — and unlike real concurrency it is
 * deterministic, because the outcome does not depend on which process wins a scheduling race.
 */
export function plantLiveForeignLock(workingDir) {
  plantLock(workingDir, new Date().toISOString());
}

/** Releases it, the way the other align would on finishing — so a scenario can show that the refusal
 * was about the lock and nothing else. */
export function removeAlignLock(workingDir) {
  const file = path.join(workingDir, '.align', '.lock');
  if (!fs.existsSync(file)) {
    throw new Error(`mutation 'remove-align-lock': ${file} does not exist — nothing to release`);
  }
  fs.rmSync(file);
}

function plantLock(workingDir, acquiredAt) {
  const dir = path.join(workingDir, '.align');
  fs.mkdirSync(dir, { recursive: true });
  writeText(
    path.join(dir, '.lock'),
    `${JSON.stringify({ pid: 4821, host: 'buildbox-01', command: 'align baseline accept', acquiredAt }, null, 2)}\n`,
  );
}

export function stampVersionFileAs014(workingDir) {
  const file = path.join(workingDir, '.align', 'version.json');
  if (!fs.existsSync(file)) {
    throw new Error(`mutation 'stamp-version-file-as-0.1.4': ${file} does not exist — run 'init' first`);
  }
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  writeText(file, `${JSON.stringify({ ...current, alignVersion: '0.1.4', baselineReconciledBy: '0.1.4' }, null, 2)}\n`);
}

export function deleteOneAcceptedFile(workingDir) {
  const victim = path.join(workingDir, HARNESS_TREE_DIRNAME, HARNESS_HIDEABLE_DIRNAME, 'c.ts');
  if (!fs.existsSync(victim)) {
    throw new Error(`mutation 'delete-one-accepted-file': ${victim} does not exist — run 'use-hideable-subtree-world' first`);
  }
  const survivor = path.join(workingDir, HARNESS_TREE_DIRNAME, HARNESS_HIDEABLE_DIRNAME, 'd.ts');
  if (!fs.existsSync(survivor)) {
    // Without the survivor the parent directory produces no observed file, mechanism 3 retains the
    // orphan, and the scenario silently stops testing what it says it tests.
    throw new Error(`mutation 'delete-one-accepted-file': ${survivor} must survive, or ADR 028 mechanism 3 becomes the guard under test`);
  }
  fs.rmSync(victim);
}

export function addTransferBait(workingDir) {
  const dir = path.join(workingDir, HARNESS_TREE_DIRNAME);
  if (!fs.existsSync(dir)) {
    throw new Error(`mutation 'add-transfer-bait': ${dir} does not exist — run 'use-hideable-subtree-world' first`);
  }
  // Depth matters, and it is not cosmetic: the violating import is written relative
  // (`../../harness-forbidden/target.js`), so the bait only resolves — and only produces a
  // violation whose fingerprint matches — when it sits at the SAME depth as the accepted entries.
  // At `harness-tree/bait.ts` the specifier escapes the repo root, resolves to nothing, and the
  // scenario silently loses its whole point (measured: `align check` went green at step 7).
  writeText(path.join(dir, HARNESS_BAIT_DIRNAME, 'bait.ts'), violatingSource('bait'));
}

function hideableDir(workingDir) {
  const dir = path.join(workingDir, HARNESS_TREE_DIRNAME, HARNESS_HIDEABLE_DIRNAME);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `mutation: ${dir} does not exist — run 'use-hideable-subtree-world' first`,
    );
  }
  return dir;
}

/**
 * ADR 028 Stage 5, blind-spot reason `not-regular-file`. Moves the subtree aside and leaves a
 * SYMLINK where it was.
 *
 * `readdirSync(…, { withFileTypes: true })` does not follow links, so a symlinked directory answers
 * false to both `isDirectory()` and `isFile()` and matches neither branch of the walk — an entire
 * subtree disappears from the scan while every one of its files is still readable at its old path.
 * That gap between "align did not look" and "the file is gone" is the whole of ADR 028.
 *
 * The stash is a real directory inside the working copy rather than a dangling link, because a
 * dangling link is the degenerate case: with a real target the file-existence probe (mechanism 2)
 * DOES resolve `harness-tree/hidden/c.ts` through the link, so this scenario also pins that the
 * blind-spot record is consulted first and its reason is the one reported.
 */
export function hideSubtreeAsSymlink(workingDir) {
  const dir = hideableDir(workingDir);
  // Stashed one level DOWN (`harness-stash/hidden/`), not at `harness-stash/`, so the moved files'
  // relative import still resolves. A stash at depth 1 makes `../../harness-forbidden/target.js`
  // escape the repo root, which turns two resolvable specifiers into uncertainty markers and the
  // run from `complete: true` into `complete: false` — at which point ADR 023 tier 2 refuses the
  // prune and this scenario would be pinning the wrong guard.
  const stash = path.join(workingDir, HARNESS_STASH_DIRNAME, HARNESS_HIDEABLE_DIRNAME);
  fs.mkdirSync(path.dirname(stash), { recursive: true });
  fs.renameSync(dir, stash);
  fs.symlinkSync(path.join('..', HARNESS_STASH_DIRNAME, HARNESS_HIDEABLE_DIRNAME), dir);
}

/**
 * ADR 028 Stage 5, blind-spot reason `unreadable`. `chmod 000` on the directory, so `readdirSync`
 * throws EACCES and the walk records the path instead of crashing or, worse, silently continuing.
 *
 * **Verifies its own precondition, loudly.** `chmod` does not stop `root`, so as root this mutation
 * would leave the directory perfectly readable and the scenario would fail with a confusing
 * retention assertion instead of an honest "this cannot be tested here". Both execution paths are
 * non-root today — `.github/workflows/ci.yml` runs `node integration/run.mjs` on the GitHub runner,
 * and `integration/Dockerfile` sets `USER node` for exactly this reason — so the check below is a
 * guard against that changing, not a standing limitation. LEDGER D012's lesson: a scenario the gate
 * does not really execute is not calibration.
 */
export function hideSubtreeUnreadable(workingDir) {
  const dir = hideableDir(workingDir);
  fs.chmodSync(dir, 0o000);
  try {
    fs.readdirSync(dir);
  } catch {
    return; // EACCES: the blind spot exists, which is what this mutation is for.
  }
  fs.chmodSync(dir, 0o755); // leave the working copy usable for the post-mortem
  throw new Error(
    "mutation 'hide-subtree-unreadable': the directory is still readable after chmod 000 — this " +
      'process is almost certainly running as root. Both supported paths run non-root (CI on the ' +
      "GitHub runner, and `integration/Dockerfile`'s `USER node`), so reaching this means one of " +
      'them changed. Run the harness as a non-root user; this scenario cannot produce an ' +
      '`unreadable` blind spot as root, and passing it vacuously would be worse than failing.',
  );
}

/**
 * ADR 028 Stage 5. Puts the mode back, and it is not optional bookkeeping.
 *
 * ADR 026's write-set check walks the WHOLE working copy after the last step to prove nothing
 * outside the declared set changed. A `chmod 000` directory makes that walk throw EACCES, so a
 * scenario that hides a subtree this way and does not restore it ends in a harness ERROR after every
 * one of its steps has already passed (measured 2026-08-18, before this mutation existed).
 *
 * Restoring is the honest fix rather than teaching the write-set walk to skip unreadable
 * directories: a directory the harness cannot read is a directory whose contents it cannot verify,
 * and silently passing over it would reproduce, inside the invariant, the very inference ADR 028
 * exists to refuse.
 */
export function restoreSubtreeReadable(workingDir) {
  const dir = path.join(workingDir, HARNESS_TREE_DIRNAME, HARNESS_HIDEABLE_DIRNAME);
  if (!fs.existsSync(dir)) {
    throw new Error(`mutation 'restore-subtree-readable': ${dir} does not exist`);
  }
  fs.chmodSync(dir, 0o755);
}

/**
 * ADR 028 Stage 5, blind-spot reason `excluded` — the excludes-shrink case. Appends an `excludes`
 * export naming the subtree, so the scan's scope shrinks under a baseline that was accepted when it
 * was wider. Nothing about the files changes; only align's view of them does.
 *
 * Distinct from `exclude-vendored-subtree` (Stage 4) in the property it supports rather than the
 * mechanism it triggers: that one pins `prune` retention plus the `--forget-unscanned` hatch against
 * nest's `complete: false` scan, where tier 2 refuses first. This one runs against a complete scan,
 * so the deletion is reachable at exit 0, and it pins the `align check` transfer arm that scenario
 * never exercises.
 */
export function shrinkScanWithExcludes(workingDir) {
  const { file } = readConfig(workingDir);
  const subtree = `${HARNESS_TREE_DIRNAME}/${HARNESS_HIDEABLE_DIRNAME}`;
  fs.appendFileSync(
    file,
    `\n// Appended by the integration harness's 'shrink-scan-with-excludes' mutation (ADR 028 Stage 5).\n` +
      `export const excludes = ['${subtree}/**'];\n`,
    'utf8',
  );
}

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
  'use-hideable-subtree-world': (ctx) => useHideableSubtreeWorld(ctx.workingDir),
  'add-transfer-bait': (ctx) => addTransferBait(ctx.workingDir),
  'delete-one-accepted-file': (ctx) => deleteOneAcceptedFile(ctx.workingDir),
  'stamp-version-file-as-0.1.4': (ctx) => stampVersionFileAs014(ctx.workingDir),
  'plant-foreign-host-lock': (ctx) => plantForeignHostLock(ctx.workingDir),
  'plant-live-foreign-lock': (ctx) => plantLiveForeignLock(ctx.workingDir),
  'remove-align-lock': (ctx) => removeAlignLock(ctx.workingDir),
  'hide-subtree-as-symlink': (ctx) => hideSubtreeAsSymlink(ctx.workingDir),
  'hide-subtree-unreadable': (ctx) => hideSubtreeUnreadable(ctx.workingDir),
  'restore-subtree-readable': (ctx) => restoreSubtreeReadable(ctx.workingDir),
  'shrink-scan-with-excludes': (ctx) => shrinkScanWithExcludes(ctx.workingDir),
  'add-vendored-violation': (ctx) => addVendoredViolation(ctx.workingDir, ctx.project),
  'exclude-vendored-subtree': (ctx) => excludeVendoredSubtree(ctx.workingDir, ctx.project),
  'introduce-arch-violation': (ctx) => introduceArchViolation(ctx.workingDir, ctx.project),
  'remove-arch-violation-rule': (ctx) => removeArchViolationRule(ctx.workingDir, ctx.project),
  'corrupt-config': (ctx) => corruptConfig(ctx.workingDir),
  'corrupt-last-scan-record': (ctx) => corruptLastScanRecord(ctx.workingDir),
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
