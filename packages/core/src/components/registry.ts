import type { ComponentName, RepoRelativePath } from '../types/branded.js';
import type { ComponentDefinitionIR } from '../types/ir.js';
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
 * files is a load-time error pointing at the component definition — unless `allowEmpty: true`.
 * Both checks run against the current scan's file list, since v1 has no separate config-build
 * step; the closest analog to "load time" is "the first scan after config load."
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

    if (def.allowEmpty) continue;
    const matched = allFiles.some((file) => matchesSelector(file, def, workspacePackages));
    if (!matched) {
      throw new ComponentValidationError(
        `Component '${name}' matches zero files. If this is expected, set allowEmpty: true on ` +
          `the component definition.`,
        name,
      );
    }
  }
}
