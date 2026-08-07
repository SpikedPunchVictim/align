import type { McpExplainRulePayload, RepoRelativePath } from '@spikedpunch/align-core';
import { buildViolationMermaid, evaluateRule, toComponentName, toRuleId } from '@spikedpunch/align-core';
import { TypeScriptPlugin } from '@spikedpunch/align-plugin-typescript';
import { loadConfig } from '../config.js';
import { reportCliError } from '../cli-error.js';

const EXAMPLES_PER_COMPONENT = 3;

/**
 * `align explain <ruleId>` — the CLI entry point. `buildExplainPayload` below is shared with the
 * MCP `align_explain_rule` tool (`mcp/server.ts`), which relies on `loadConfig`'s throw reaching
 * the SDK's own try/catch (verified empirically: the SDK converts any uncaught throw into a clean
 * `isError` response, bug hunt 2026-08-03, BUG #14) — so the catch belongs HERE, at the CLI-only
 * wrapper, not inside the shared function, where it would swallow the throw MCP depends on.
 */
export async function runExplain(rootDir: string, ruleId: string): Promise<number> {
  let payload: McpExplainRulePayload | undefined;
  try {
    payload = await buildExplainPayload(rootDir, ruleId);
  } catch (err) {
    return reportCliError('align explain', err);
  }
  if (payload === undefined) {
    console.error(`Unknown rule id '${ruleId}'.`);
    return 1;
  }
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

export async function buildExplainPayload(rootDir: string, ruleId: string): Promise<McpExplainRulePayload | undefined> {
  const { ruleset, excludes, hostRules } = await loadConfig(rootDir);
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

  // Mermaid is explain-only (ADR 007: pull-on-demand, never in align_check/align_violations).
  // Diagram ONE representative violation instance, if the rule currently has any — a rule with
  // no live violations has no "offending path" to visualize.
  const violations = evaluateRule(rule, graph, ruleset.components, hostRules);
  const firstViolation = violations[0];
  const mermaid = firstViolation === undefined ? undefined : buildViolationMermaid(firstViolation);

  return {
    ruleId: toRuleId(rule.id),
    kind: rule.kind,
    ...(rule.provenance.because === undefined ? {} : { because: rule.provenance.because }),
    components,
    ...(mermaid === undefined ? {} : { mermaid }),
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
  if (rule.kind === 'arch.metric') return [String(rule['target'])];
  // `security.manifest.*` (ADR 013): no `ComponentRef` — falls through to the default `[]`.
  return [];
}
