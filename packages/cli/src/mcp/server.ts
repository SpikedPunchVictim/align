/**
 * `align mcp` — stdio MCP server (ADR 001/007). Token-economy discipline: structured-fields-only
 * payloads, priority-sorted, capped, and paginated; passing gates contribute counts only, never
 * per-item prose (ADR 007). Tool descriptions carry searchable capability keywords for
 * deferred-loading harnesses (ADR 009 — probe 1 found align's tools surfaced as deferred tools
 * requiring an explicit load before use).
 *
 * IMPORTANT (stdio transport): stdout carries JSON-RPC frames; all logging goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildMcpCheckPayload } from '@align/core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline } from '../align-dir.js';
import { buildExplainPayload } from '../commands/explain.js';

/** Builds the McpServer with tools registered but no transport attached — split out from
 * `startMcpServer` so tests can connect it to an in-process `InMemoryTransport` instead of stdio
 * (MCP contract tests via the SDK's own client, per the Stage 1 plan). */
export function createMcpServer(rootDir: string): McpServer {
  const server = new McpServer({ name: 'align', version: '0.1.0' });

  server.registerTool(
    'align_check',
    {
      title: 'Check architecture conformance',
      description:
        'Runs align architecture rules (dependency-direction constraints + import-cycle detection ' +
        'over the project dependency graph) and returns a green/red/error verdict with per-gate ' +
        'counts. Performs a FRESH full repo scan every call — the result always reflects the ' +
        'current on-disk code, never a cached or stale prior scan. Call this after structural code ' +
        'changes (new imports, moved files, restructured modules) to verify architecture is intact.',
      inputSchema: {},
    },
    async () => {
      const { ruleset, excludes } = await loadConfig(rootDir);
      const { orchestrator } = createOrchestrator(ruleset, readBaseline(rootDir));
      const run = await orchestrator.check({ rootDir, excludes });
      const payload = buildMcpCheckPayload(run, { maxPerRule: 10, pageSize: 50 });
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerTool(
    'align_violations',
    {
      title: 'List architecture violations',
      description:
        'Returns the current architecture violations (dependency-direction breaches, import ' +
        'cycles) in priority order, with file, line, specifier, and a machine-readable fix hint ' +
        'per violation. Structured fields only — pass an optional cursor to page through results ' +
        'beyond the first page. Performs a fresh scan every call (ADR 005).',
      inputSchema: { cursor: z.string().optional() },
    },
    async ({ cursor }) => {
      const { ruleset, excludes } = await loadConfig(rootDir);
      const { orchestrator } = createOrchestrator(ruleset, readBaseline(rootDir));
      const run = await orchestrator.check({ rootDir, excludes });
      const payload = buildMcpCheckPayload(run, { maxPerRule: 10, pageSize: 50, ...(cursor === undefined ? {} : { cursor }) });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ violations: payload.violations, pagination: payload.pagination }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'align_explain_rule',
    {
      title: 'Explain an architecture rule',
      description:
        'Explains one align architecture rule by id: its kind (no-dependency / no-cycles / ' +
        'layers), the rationale (.because() text), and the components it constrains with example ' +
        'files from the current tree. Use this to understand WHY a violation was raised before ' +
        'proposing a fix.',
      inputSchema: { ruleId: z.string() },
    },
    async ({ ruleId }) => {
      const payload = await buildExplainPayload(rootDir, ruleId);
      if (payload === undefined) {
        return { isError: true, content: [{ type: 'text', text: `Unknown rule id '${ruleId}'.` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  return server;
}

export async function startMcpServer(rootDir: string): Promise<void> {
  const server = createMcpServer(rootDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[align] MCP server ready on stdio');
}
