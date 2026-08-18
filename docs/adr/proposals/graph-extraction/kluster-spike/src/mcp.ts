/**
 * Minimal stdio MCP server exposing the align spike as two tools.
 *
 * Token-economy discipline: responses contain violations and counts only —
 * no passing-rule prose, no per-file "ok" noise. First 10 violations per rule.
 *
 * IMPORTANT (stdio transport): stdout carries JSON-RPC frames; all logging goes
 * to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { componentByName, COMPONENTS } from './components.js';
import { KLUSTER_ROOT, SCAN_ROOTS } from './kluster-root.js';
import { evaluateRules, RULES, type Rule } from './rules.js';
import { scanRepo } from './scanner.js';
import type { Graph } from './types.js';

const MAX_VIOLATIONS_PER_RULE = 10;

// Rescan on EVERY check. The session cache this used to have served a stale
// verdict after the agent's first fix, and the agent (correctly) concluded the
// tool couldn't be trusted at all — a live demonstration that a verification
// oracle must never answer from state older than the code it is judging.
// Warm rescans measure ~1.4 s here (probe 3), which is cheap enough.
function getGraph(): { graph: Graph; scanMs: number } {
  const { graph, stats } = scanRepo(KLUSTER_ROOT, SCAN_ROOTS);
  const scanMs = Math.round(stats.wallTimeMs);
  console.error(`[align] scanned ${stats.filesScanned} files in ${scanMs} ms (fresh scan per check)`);
  return { graph, scanMs };
}

function ruleById(ruleId: string): Rule | undefined {
  return RULES.find((r) => r.id === ruleId);
}

const server = new McpServer({ name: 'align-spike', version: '0.0.0' });

server.registerTool(
  'align_check',
  {
    title: 'Check architecture conformance',
    description:
      'Runs align architecture rules (dependency constraints + cycle detection) over the kluster ' +
      'dependency graph. Returns a verdict, per-rule violation counts, and the first ' +
      `${MAX_VIOLATIONS_PER_RULE} violations per rule with file, line, and fix hints. ` +
      'Passing rules report a count of 0 and nothing else.',
    inputSchema: {
      ruleIds: z.array(z.string()).optional().describe('Restrict the check to these rule ids (default: all rules).'),
    },
  },
  async ({ ruleIds }) => {
    const { graph } = getGraph();
    const selected =
      ruleIds === undefined || ruleIds.length === 0 ? [...RULES] : [...RULES].filter((r) => ruleIds.includes(r.id));
    if (selected.length === 0) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown rule ids: ${ruleIds?.join(', ') ?? ''}. Known: ${RULES.map((r) => r.id).join(', ')}` }],
      };
    }

    const evaluations = evaluateRules(graph, selected);
    const totalViolations = evaluations.reduce((sum, e) => sum + e.violations.length, 0);
    const payload = {
      verdict: totalViolations === 0 ? 'green' : 'red',
      totalViolations,
      rules: evaluations.map((e) => ({ ruleId: e.rule.id, kind: e.rule.kind, violationCount: e.violations.length })),
      violations: evaluations
        .filter((e) => e.violations.length > 0)
        .map((e) => ({
          ruleId: e.rule.id,
          shown: Math.min(e.violations.length, MAX_VIOLATIONS_PER_RULE),
          total: e.violations.length,
          items: e.violations.slice(0, MAX_VIOLATIONS_PER_RULE),
        })),
      uncertainty: {
        totalCount: graph.uncertain.length,
        filesAffected: new Set(graph.uncertain.map((u) => u.file)).size,
        byReason: countBy(graph.uncertain, (u) => u.reason),
      },
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

server.registerTool(
  'align_explain_rule',
  {
    title: 'Explain an architecture rule',
    description:
      'Explains one align rule: its intent, the components it constrains (with example files), and what a fix looks like.',
    inputSchema: {
      ruleId: z.string().describe(`One of: ${RULES.map((r) => r.id).join(', ')}`),
    },
  },
  async ({ ruleId }) => {
    const rule = ruleById(ruleId);
    if (rule === undefined) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown rule '${ruleId}'. Known: ${RULES.map((r) => r.id).join(', ')}` }],
      };
    }
    const { graph } = getGraph();
    const componentNames =
      rule.kind === 'no-dependency' ? [rule.from, rule.to] : rule.scope === 'repo' ? [] : [rule.scope.component];
    const components = componentNames.map((name) => {
      const component = componentByName(name);
      const exampleFiles = [...graph.nodes.keys()].filter((p) => component?.pathPrefixes.some((x) => p.startsWith(x))).slice(0, 3);
      return { name, description: component?.description ?? 'unknown component', pathPrefixes: component?.pathPrefixes ?? [], exampleFiles };
    });
    const payload = {
      ruleId: rule.id,
      kind: rule.kind,
      intent: rule.rationale,
      constraint:
        rule.kind === 'no-dependency'
          ? `No file in component '${rule.from}' may import (statically, dynamically, via re-export, or type-only) any file in component '${rule.to}'.`
          : `The ${rule.scope === 'repo' ? 'repository-wide' : `'${rule.scope.component}'`} import graph over edge kinds [${rule.edgeKinds.join(', ')}] must be acyclic.`,
      components,
      whatAFixLooksLike:
        rule.kind === 'no-dependency'
          ? 'Delete the offending import if unused; otherwise move the shared code to a component both sides may depend on, or invert the dependency behind an interface owned by the importing component.'
          : 'Break one edge of the reported chain: extract shared symbols into a new module both parties import, or convert the back-edge to a type-only import if only types are needed.',
      totalComponents: COMPONENTS.length,
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[align] MCP server ready on stdio');
