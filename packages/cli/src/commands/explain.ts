import type { McpExplainRulePayload, RepoRelativePath } from '@align/core';
import { toComponentName, toRuleId } from '@align/core';
import { TypeScriptPlugin } from '@align/plugin-typescript';
import { loadConfig } from '../config.js';

const EXAMPLES_PER_COMPONENT = 3;

export async function buildExplainPayload(rootDir: string, ruleId: string): Promise<McpExplainRulePayload | undefined> {
  const { ruleset, excludes } = await loadConfig(rootDir);
  const rule = ruleset.rules.find((r) => r.id === ruleId);
  if (rule === undefined) return undefined;

  const plugin = new TypeScriptPlugin();
  const graph = await plugin.scanner.scan({ rootDir, components: ruleset.components, excludes });

  const filesByComponent = new Map<string, RepoRelativePath[]>();
  for (const node of graph.nodes) {
    const list = filesByComponent.get(node.component) ?? [];
    if (list.length < EXAMPLES_PER_COMPONENT) list.push(node.file);
    filesByComponent.set(node.component, list);
  }

  const componentNames = collectComponentNames(rule);
  const components = componentNames.map((name) => ({
    name: toComponentName(name),
    exampleFiles: filesByComponent.get(name) ?? [],
  }));

  return {
    ruleId: toRuleId(rule.id),
    kind: rule.kind,
    ...(rule.provenance.because === undefined ? {} : { because: rule.provenance.because }),
    components,
  };
}

function collectComponentNames(rule: { kind: string; [k: string]: unknown }): string[] {
  if (rule.kind === 'arch.no-dependency') return [String(rule['from']), String(rule['to'])];
  if (rule.kind === 'arch.no-cycles') {
    const scope = rule['scope'];
    return scope === 'repo' ? [] : [String(scope)];
  }
  if (rule.kind === 'arch.layers') {
    const layers = rule['layers'] as readonly { layer: string; canDependOn: readonly string[] }[];
    return [...new Set(layers.flatMap((l) => [l.layer, ...l.canDependOn]))];
  }
  return [];
}
