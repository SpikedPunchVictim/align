import type { ComponentName, RepoRelativePath } from '../types/branded.js';
import type { ComponentDefinitionIR, EmptyPolicy } from '../types/ir.js';
import { globMatch } from './glob.js';

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

/** First-component-match-wins classification, in the order components are declared. */
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
 * Load-time validation (ADR 003): a `package:` selector naming a package absent from the
 * resolved workspace inventory is an error, and a component whose selector resolves to zero
 * files is a load-time error pointing at the component definition — unless its empty policy
 * (`empty: 'allow' | 'until-populated'`, greenfield mode, ADR 003 amendment) opts out. Both
 * checks run against the current scan's file list, since v1 has no separate config-build step;
 * the closest analog to "load time" is "the first scan after config load."
 */
export function validateComponents(
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
  allFiles: readonly RepoRelativePath[],
  workspacePackages: WorkspacePackageIndex,
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
