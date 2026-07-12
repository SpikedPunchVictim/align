import { buildUncertaintyAdvisories, toComponentName, type Advisory } from '@align/core';
import { TypeScriptPlugin, UNMAPPED_COMPONENT, findDeadAliases, findOrphanedPackages } from '@align/plugin-typescript';
import { loadConfig } from '../config.js';

const UNMAPPED_EXAMPLES = 5;

/**
 * `align doctor` — read-only advisory survey (Stage 2). Unlike `align check`, doctor never fails
 * a build: it's a diagnostic tool for the humans/agents configuring align on a repo, not a gate.
 * Exit code is always 0; every failure mode downgrades to an advisory instead of throwing, since a
 * misconfigured repo is exactly the case doctor exists to help someone understand.
 */
export async function runDoctor(rootDir: string): Promise<number> {
  const advisories: Advisory[] = [];

  const loaded = await loadConfig(rootDir).catch((err: unknown) => {
    advisories.push({
      kind: 'config-error',
      message: `Could not load align.config.ts: ${err instanceof Error ? err.message : String(err)}`,
    });
    return undefined;
  });
  const excludes = loaded?.excludes ?? [];

  if (loaded !== undefined) {
    const { ruleset, excludes } = loaded;
    const plugin = new TypeScriptPlugin();
    const graph = await plugin.scanner.scan({ rootDir, components: ruleset.components, excludes }).catch((err: unknown) => {
      advisories.push({ kind: 'scan-error', message: err instanceof Error ? err.message : String(err) });
      return undefined;
    });

    if (graph !== undefined) {
      advisories.push(...buildUncertaintyAdvisories(graph.uncertain));

      const unmapped = graph.nodes.filter((n) => n.component === UNMAPPED_COMPONENT);
      if (unmapped.length > 0) {
        const examples = unmapped.slice(0, UNMAPPED_EXAMPLES).map((n) => n.file);
        const more = unmapped.length > UNMAPPED_EXAMPLES ? `, +${unmapped.length - UNMAPPED_EXAMPLES} more` : '';
        advisories.push({
          kind: 'unmapped-files',
          message: `${unmapped.length} file(s) matched no component selector: ${examples.join(', ')}${more}.`,
        });
      }

      const seenComponents = new Set(graph.nodes.map((n) => n.component));
      const emptyComponents = Object.keys(ruleset.components).filter(
        (name) => !seenComponents.has(toComponentName(name)),
      );
      if (emptyComponents.length > 0) {
        advisories.push({
          kind: 'empty-component',
          message: `${emptyComponents.length} component(s) matched zero files (allowEmpty): ${emptyComponents.join(', ')}.`,
        });
      }
    }
  }

  for (const alias of findDeadAliases(rootDir, excludes)) {
    advisories.push({
      kind: 'dead-alias',
      message: `${alias.tsconfig}: alias '${alias.alias}' -> '${alias.target}' does not resolve to an existing path.`,
    });
  }

  for (const pkg of findOrphanedPackages(rootDir, excludes)) {
    advisories.push({
      kind: 'workspace-orphaned-package',
      message: `${pkg.dir} (package '${pkg.name}') is on disk but not covered by any pnpm-workspace.yaml glob.`,
    });
  }

  printReport(advisories);
  return 0; // advisory tool — never fails the build
}

function printReport(advisories: readonly Advisory[]): void {
  if (advisories.length === 0) {
    console.log('align doctor: no advisories.');
    return;
  }
  console.log(`align doctor: ${advisories.length} advisory(ies)\n`);
  const byKind = new Map<string, Advisory[]>();
  for (const a of advisories) {
    const list = byKind.get(a.kind);
    if (list === undefined) byKind.set(a.kind, [a]);
    else list.push(a);
  }
  for (const [kind, list] of byKind) {
    console.log(`  ${kind} (${list.length}):`);
    for (const a of list) console.log(`    - ${a.message}`);
  }
}
