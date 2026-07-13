/**
 * `align mcp` — stdio MCP server (ADR 001/007). Token-economy discipline: structured-fields-only
 * payloads, priority-sorted, capped, and paginated; passing gates contribute counts only, never
 * per-item prose (ADR 007). Tool descriptions carry searchable capability keywords for
 * deferred-loading harnesses (ADR 009 — probe 1 found align's tools surfaced as deferred tools
 * requiring an explicit load before use).
 *
 * IMPORTANT (stdio transport): stdout carries JSON-RPC frames; all logging goes to stderr.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildMcpCheckPayload, proposeRulesFromDoc, ruleFragmentSchema, toRepoRelativePath, type CheckRun } from '@align/core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline, writeBaseline } from '../align-dir.js';
import { buildExplainPayload } from '../commands/explain.js';
import { DEFAULT_DOC_PATH, proposeFromClientSubmission, writeBuildArtifacts, type DryRunResult } from '../commands/build.js';
import { renderCondensedFixingSkill } from '../skill/condensed.js';

/** Shared by `align_check`/`align_violations`: runs a fresh check and persists any move-transfer
 * (ADR 006) the run performed, so a renamed file's baselined violation doesn't need a separate
 * `align baseline prune` to stop being re-reported on the next call. */
async function freshCheck(rootDir: string): Promise<CheckRun> {
  const { ruleset, excludes, hostRules } = await loadConfig(rootDir);
  const { orchestrator, baselineStore } = createOrchestrator(ruleset, readBaseline(rootDir), hostRules);
  const run = await orchestrator.check({ rootDir, excludes });
  if (run.advisories.some((a) => a.kind === 'baseline-moved')) {
    writeBaseline(rootDir, baselineStore.snapshot());
  }
  return run;
}

/** Builds the McpServer with tools registered but no transport attached — split out from
 * `startMcpServer` so tests can connect it to an in-process `InMemoryTransport` instead of stdio
 * (MCP contract tests via the SDK's own client, per the Stage 1 plan). */
export function createMcpServer(rootDir: string): McpServer {
  // `instructions` (Stage 5, IMPLEMENTATION_PLAN.md "Elevated first items"): the condensed
  // fixing-topic skill, token-budgeted (~30 lines), rendered from the same source module the full
  // `align skill --topic fixing` markdown expands (packages/cli/src/skill/fix-loop-protocol.ts) —
  // not a second hand-written copy of the protocol.
  const server = new McpServer({ name: 'align', version: '0.1.0' }, { instructions: renderCondensedFixingSkill() });

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
      const run = await freshCheck(rootDir);
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
      const run = await freshCheck(rootDir);
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

  const proposalInputSchema = z.object({
    section: z.string(),
    fragment: ruleFragmentSchema,
    sourceLineRange: z.object({ startLine: z.number().int(), endLine: z.number().int() }),
    sourceQuote: z.string(),
  });

  server.registerTool(
    'align_propose_rules',
    {
      title: 'Propose architecture rules from a markdown doc (build)',
      description:
        'Compiles an architecture/best-practices markdown doc into align rules — the same ' +
        'precision ladder as `align build` (fenced ```align blocks, structured `- **Rule**:` ' +
        'bullets, prose needing judgment). TWO-PASS: call with ONLY `doc_path` first (discovery) ' +
        'to get per-section tier classification, deterministically-extracted rules, and an empty ' +
        '"concerns" scaffold for prose sections for YOU to fill with your own judgment (align ' +
        'never invents rules from prose). Then call again with `proposals` (your confirmed ' +
        'concerns turned into rule fragments with provenance, plus any deterministic rules you ' +
        'want to keep) to validate, ground selectors against the components registry, and dry-run ' +
        'the impact (added/flagged-ungroundable/violation-count delta) — nothing is written yet. ' +
        'Add `apply: true` on a follow-up call once you have reviewed the dry run to write ' +
        '.align/generated-rules.json + rules.lock.json + the audit report. align validates and ' +
        'grounds; no API key or LLM call happens inside align itself.',
      inputSchema: {
        doc_path: z.string().optional(),
        proposals: z.array(proposalInputSchema).optional(),
        apply: z.boolean().optional(),
        accept_new_into_baseline: z.boolean().optional(),
      },
    },
    async ({ doc_path, proposals, apply, accept_new_into_baseline }) => {
      const docRelPath = doc_path ?? DEFAULT_DOC_PATH;

      if (proposals === undefined) {
        // Pass 1 — Discovery (ADR 011 two-pass clarification): classify sections, surface the
        // deterministic tier-1/2 rules ready to pass through verbatim, and an empty `concerns`
        // scaffold per prose section for the client to fill — align never invents rules from
        // prose.
        const absDocPath = path.join(rootDir, docRelPath);
        if (!fs.existsSync(absDocPath)) {
          return { isError: true, content: [{ type: 'text', text: `Doc not found: ${docRelPath}` }] };
        }
        const docText = fs.readFileSync(absDocPath, 'utf8');
        const { ruleset, hostRules } = await loadConfig(rootDir, { includeGenerated: false });
        const proposal = proposeRulesFromDoc(docText, toRepoRelativePath(docRelPath), ruleset.components, new Set(hostRules.keys()));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  docPath: docRelPath,
                  sections: proposal.sections,
                  deterministicRules: proposal.rules,
                  flagged: proposal.flagged,
                  proseSections: proposal.proseSections,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Pass 2 (validate/ground/dry-run, no write) or `{ apply: true }` (writes via the same
      // pipeline as `align build --apply`).
      let result: DryRunResult;
      try {
        result = await proposeFromClientSubmission(rootDir, docRelPath, proposals);
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
      }

      const diffPayload = {
        docPath: docRelPath,
        accepted: result.proposal.rules.map((r) => ({ id: r.id, kind: r.kind, provenance: r.provenance })),
        flaggedUngroundable: result.proposal.flagged,
        diff: {
          added: result.diff.added.map((r) => r.id),
          changed: result.diff.changed.map((c) => c.after.id),
          removed: result.diff.removed.map((r) => r.id),
          unchanged: result.diff.unchanged.map((r) => r.id),
        },
        impact: { addsNewViolations: result.impact.addedNew.length, masksBaselined: result.impact.maskedBaselined.length },
      };

      if (apply !== true) {
        return { content: [{ type: 'text', text: JSON.stringify(diffPayload, null, 2) }] };
      }

      const applied = writeBuildArtifacts(rootDir, result, { acceptNewIntoBaseline: accept_new_into_baseline === true });
      if (!applied.ok) {
        return { isError: true, content: [{ type: 'text', text: applied.message }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...diffPayload, applied: true, message: applied.message }, null, 2) }] };
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
