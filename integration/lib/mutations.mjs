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
export function introduceArchViolation(workingDir, project) {
  const { fromComponent, toComponent, because } = project.violation;
  const { file, text } = readConfig(workingDir);
  const anchor = 'rules: (c) => [\n';
  const replacement =
    `rules: (c) => [\n` +
    `    // Inserted by the integration harness's 'introduce-arch-violation' mutation.\n` +
    `    c.arch.layer(c.${fromComponent}).cannotDependOn(c.${toComponent}).because(${JSON.stringify(because)}),\n`;
  fs.writeFileSync(file, replaceAnchorOnce(text, anchor, replacement, 'introduce-arch-violation'), 'utf8');
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

export const MUTATIONS = {
  'shadow-component': (ctx) => shadowComponent(ctx.workingDir),
  'introduce-arch-violation': (ctx) => introduceArchViolation(ctx.workingDir, ctx.project),
  'corrupt-config': (ctx) => corruptConfig(ctx.workingDir),
};

export function applyMutation(name, ctx) {
  const fn = MUTATIONS[name];
  if (fn === undefined) throw new Error(`unknown mutation '${name}' — known: ${Object.keys(MUTATIONS).join(', ')}`);
  fn(ctx);
}
