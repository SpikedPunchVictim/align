import type { ComponentName, RepoRelativePath } from '../types/branded.js';
import { toRepoRelativePath } from '../types/branded.js';
import type { ComponentDefinitionIR, EmptyPolicy } from '../types/ir.js';
import { globMatch, lintGlobPattern, staticPrefixOf } from './glob.js';

/** One-sentence statement of align's supported glob dialect, reused in load-time error messages. */
const SUPPORTED_GLOB_VOCABULARY =
  '`*` (one path segment), `**` (any depth), `?` (one character), `{a,b,c}` brace expansion, and literal path segments';

/** Package name -> repo-relative directory (with trailing slash), e.g. from pnpm-workspace.yaml. */
export type WorkspacePackageIndex = ReadonlyMap<string, RepoRelativePath>;

export class ComponentValidationError extends Error {
  constructor(
    message: string,
    public readonly componentName: ComponentName,
  ) {
    super(message);
    this.name = 'ComponentValidationError';
  }
}

function matchesSelector(
  file: RepoRelativePath,
  def: ComponentDefinitionIR,
  workspacePackages: WorkspacePackageIndex,
): boolean {
  if (def.selector.kind === 'glob') {
    return def.selector.patterns.some((pattern) => globMatch(pattern, file));
  }
  // 'package' selector: file belongs if it falls under any named package's directory.
  return def.selector.packageNames.some((name) => {
    const dir = workspacePackages.get(name);
    return dir !== undefined && (file === dir.replace(/\/$/, '') || file.startsWith(dir));
  });
}

/**
 * First-component-match-wins classification, in the order components are declared.
 *
 * **Root workspace packages are the sharp edge here.** A `package:` selector naming a package
 * rooted at the repo root itself (`dir: ''` — see `WorkspacePackage.dir`'s doc comment in
 * `@spikedpunch/align-plugin-typescript`) matches via `file.startsWith('')`, which is true for
 * every repo-relative file. That is the correct semantics for "this component IS the repo root,"
 * but under first-match-wins it also means such a component claims every file not already claimed
 * by an earlier-declared component. **Declare a root-package component last** in the `components`
 * map, or it will silently swallow files meant for components declared after it.
 */
export function classifyFile(
  file: RepoRelativePath,
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
  workspacePackages: WorkspacePackageIndex,
): ComponentName | undefined {
  for (const name of Object.keys(components) as ComponentName[]) {
    const def = components[name];
    if (def !== undefined && matchesSelector(file, def, workspacePackages)) return name;
  }
  return undefined;
}

/**
 * Load-time selector-syntax lint. Runs for EVERY glob component regardless of its `empty` policy —
 * so an `empty: 'allow'` (or `'until-populated'`) component cannot hide a selector using unsupported
 * syntax that would otherwise silently compile to a zero-match literal and leave the component
 * permanently ungrounded. align's glob dialect is deliberately minimal (zero-dependency core); this
 * makes it *loudly* minimal — anything outside the dialect fails here, at the exact pattern, with an
 * actionable message, instead of at scan time as a mysterious zero-match error.
 */
export function validateSelectorSyntax(
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
): void {
  for (const name of Object.keys(components) as ComponentName[]) {
    const def = components[name];
    if (def === undefined || def.selector.kind !== 'glob') continue;
    for (const pattern of def.selector.patterns) {
      const problem = lintGlobPattern(pattern);
      if (problem !== undefined) {
        throw new ComponentValidationError(
          `Component '${name}' selector '${pattern}' uses ${problem}, which align's glob dialect ` +
            `does not support. It supports only ${SUPPORTED_GLOB_VOCABULARY} — list patterns ` +
            `explicitly (e.g. patterns: ['llm-anthropic/**', 'llm-ollama/**']) or use a \`*\` wildcard.`,
          name,
        );
      }
    }
  }
}

/**
 * Cheap diagnostic heuristic, not a real match (no such file exists): asks whether a component's
 * selector could plausibly reach inside a skipped nested checkout. Two complementary tests, since
 * either shape is common:
 *
 * 1. The selector's scope CONTAINS or EQUALS the checkout (e.g. `vendor/**` reaching
 *    `vendor/submodule`) — caught by running a synthetic probe path directly under the checkout
 *    through `matchesSelector`, the SAME glob dialect and package-index lookup the real
 *    classification uses (BUG #4's lesson from plugin-typescript's scanner.ts: never build a
 *    second, independently-drifting matcher).
 * 2. The selector points DEEPER INSIDE the checkout (e.g. `vendor/submodule/src/**`) — the
 *    likelier real shape for a vendored checkout, and one the probe above structurally cannot
 *    catch (the probe file lives at the checkout's root, not inside `src/`). Caught instead by
 *    `staticPrefixOf` (`./glob.js`): does any glob pattern's wildcard-free directory prefix lie at
 *    or under the checkout directory? A pattern with no literal anchor at all (`**`) has an empty
 *    prefix and always counts, since it could match anywhere.
 *
 * Task #25's empty-component interaction: without this, a component whose selector only ever
 * matched files inside an auto-excluded checkout throws the same generic "renamed/moved/stale"
 * message as an ordinary stale selector — actively misleading, since the real cause (a nested
 * checkout, visible in the scan's `nested-checkout-skipped` advisory) is knowable right here. A
 * false negative (neither test fires — e.g. a `package:` selector, which carries no literal path
 * to test) just falls back to the generic message, no worse than today. A false positive only adds
 * an extra path name to an error message — never a behavior change.
 */
function skippedCheckoutsMatchingSelector(
  def: ComponentDefinitionIR,
  skippedNestedCheckouts: readonly RepoRelativePath[],
  workspacePackages: WorkspacePackageIndex,
): readonly RepoRelativePath[] {
  const staticPrefixes = def.selector.kind === 'glob' ? def.selector.patterns.map(staticPrefixOf) : [];
  return skippedNestedCheckouts.filter((dir) => {
    if (matchesSelector(toRepoRelativePath(`${dir}/__align_probe__.ts`), def, workspacePackages)) return true;
    return staticPrefixes.some((prefix) => prefix === '' || prefix === dir || prefix.startsWith(`${dir}/`));
  });
}

/**
 * Load-time validation (ADR 003): a `package:` selector naming a package absent from the
 * resolved workspace inventory is an error, and a component whose selector resolves to zero
 * files is a load-time error pointing at the component definition — unless its empty policy
 * (`empty: 'allow' | 'until-populated'`, greenfield mode, ADR 003 amendment) opts out. Both
 * checks run against the current scan's file list, since v1 has no separate config-build step;
 * the closest analog to "load time" is "the first scan after config load."
 *
 * `skippedNestedCheckouts` (task #25, default `[]` for every pre-existing caller): repo-relative
 * paths the walk auto-excluded this scan because they carry their own `.git`. When a `fail`-policy
 * component matches zero files AND its selector could plausibly have reached one of these paths
 * (`skippedCheckoutsMatchingSelector`), the thrown message names that as the likely cause instead
 * of the generic "renamed/moved/stale selector" — see this function's doc comment above.
 */
export function validateComponents(
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
  allFiles: readonly RepoRelativePath[],
  workspacePackages: WorkspacePackageIndex,
  skippedNestedCheckouts: readonly RepoRelativePath[] = [],
): void {
  for (const name of Object.keys(components) as ComponentName[]) {
    const def = components[name];
    if (def === undefined) continue;

    if (def.selector.kind === 'package') {
      for (const pkgName of def.selector.packageNames) {
        if (!workspacePackages.has(pkgName)) {
          throw new ComponentValidationError(
            `Component '${name}' references package '${pkgName}', which is not in the resolved ` +
              `workspace inventory. Check pnpm-workspace.yaml / package.json names.`,
            name,
          );
        }
      }
    }

    if (def.empty !== 'fail') continue;
    const matched = allFiles.some((file) => matchesSelector(file, def, workspacePackages));
    if (!matched) {
      const likelyCheckouts = skippedCheckoutsMatchingSelector(def, skippedNestedCheckouts, workspacePackages);
      if (likelyCheckouts.length > 0) {
        throw new ComponentValidationError(
          `Component '${name}' (selector: ${describeSelector(def)}) matches zero files. Likely cause: ` +
            `its files live only under ${likelyCheckouts.join(', ')} — nested git checkout(s) auto-` +
            `excluded from this scan, not a stale selector. If this is genuinely part of the project ` +
            `(e.g. a submodule), add it to align.config.ts's includeNestedCheckouts export.`,
          name,
        );
      }
      throw new ComponentValidationError(
        `Component '${name}' (selector: ${describeSelector(def)}) matches zero files. Likely ` +
          `cause: its directory was renamed/moved or the selector is stale. If this is expected, ` +
          `set empty: 'until-populated' on the component definition (greenfield — auto-arms once ` +
          `files land, and shows as a distinct 'ungrounded, provisionally green' line in \`align ` +
          `check\` rather than plain green) or empty: 'allow' for a component that stays ` +
          `permanently optional. (\`allowEmpty: true\` is still supported as a deprecated alias ` +
          `for \`empty: 'allow'\`.)`,
        name,
      );
    }
  }
}

function describeSelector(def: ComponentDefinitionIR): string {
  return def.selector.kind === 'glob'
    ? def.selector.patterns.join(', ')
    : `package: ${def.selector.packageNames.join(', ')}`;
}

/** R1 (greenfield mode, IMPLEMENTATION_PLAN.md Design Reserve "Greenfield mode"): every component
 * that is green ONLY because it matched zero files this scan (`empty: 'allow'` or
 * `'until-populated'`, and currently zero classified files) — the data `align explain`/`doctor`
 * already had, now surfaced in the loop a check-agent actually runs (`align check`'s human output,
 * `--json`, and the MCP `align_check` payload; `orchestrator.ts` calls this once per check and
 * threads the result onto `CheckRun.ungroundedComponents`). A component with `empty: 'fail'` never
 * reaches here empty (it would have thrown in `validateComponents`/`validateClassifiedComponents`
 * first) — this function only ever returns entries for the two policies that tolerate emptiness,
 * closing the exact visibility hole this file's `validateClassifiedComponents` doc comment names:
 * "the same false-green class as an unknown ComponentRef," now distinguishable in the verdict
 * itself rather than requiring a per-rule `align explain` to notice `exampleFiles: []`.
 */
export function findUngroundedComponents(
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
  classifiedComponents: ReadonlySet<string>,
): UngroundedComponent[] {
  const out: UngroundedComponent[] = [];
  for (const name of Object.keys(components) as ComponentName[]) {
    const def = components[name];
    if (def === undefined || def.empty === 'fail') continue;
    if (classifiedComponents.has(name)) continue;
    out.push({ name, selector: describeSelector(def), policy: def.empty });
  }
  return out;
}

export interface UngroundedComponent {
  readonly name: ComponentName;
  readonly selector: string;
  readonly policy: Exclude<EmptyPolicy, 'fail'>;
}

/**
 * Classification-based companion to `validateComponents`, for callers that only have the
 * *classified* scan result rather than the raw file list + workspace inventory (the
 * `GateOrchestrator` — see its check-time validation step). Enforces the same ADR 003
 * empty-selector-fails-by-default doctrine one step later in the pipeline, where it also catches
 * a case selector-based validation structurally cannot: a component whose selector DOES match
 * files but loses every one of them to an earlier component under first-match-wins
 * classification (`classifyFile` above) — zero classified files means every rule referencing the
 * component evaluates vacuously green, the same false-green class as an unknown ComponentRef
 * (`rules/component-refs.ts`). Fail-fast on the first offender, same convention as
 * `validateComponents`.
 */
export function validateClassifiedComponents(
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
  classifiedComponents: ReadonlySet<string>,
): void {
  for (const name of Object.keys(components) as ComponentName[]) {
    const def = components[name];
    if (def === undefined || def.empty !== 'fail') continue;
    if (classifiedComponents.has(name)) continue;
    throw new ComponentValidationError(
      `Component '${name}' (selector: ${describeSelector(def)}) has zero files classified to it ` +
        `in this scan — every rule referencing '${name}' would silently pass. Likely cause: its ` +
        `directory was renamed/moved, the selector is stale, or an earlier component's selector ` +
        `claims all of its files (components classify first-match-wins, in declaration order). ` +
        `If '${name}' is legitimately empty, set empty: 'until-populated' (greenfield — auto-arms ` +
        `once files land) or empty: 'allow' (permanent) on the component definition. ` +
        `(\`allowEmpty: true\` is still supported as a deprecated alias for \`empty: 'allow'\`.)`,
      name,
    );
  }
}
