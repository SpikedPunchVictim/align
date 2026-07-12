/**
 * The one real `FixProvider` implementation — raw Anthropic API tool-use, per the plan's "Inner
 * PLAN+FIX: raw Anthropic API pure function (zod-constrained tool-use, memoizable), not a nested
 * agent." Never imported by the state machine directly (`fixProvider.ts`'s interface is the only
 * thing `run.ts` depends on) — this file is the sole place `@anthropic-ai/sdk` is imported.
 *
 * Model default per the `claude-api` skill reference, per explicit task instruction to default to
 * the latest Sonnet-class model id (not the skill's general-purpose Opus default) — a background
 * fix loop that may run many PLAN+FIX calls per session is exactly the cost-sensitive, high-volume
 * workload Sonnet-tier is for. Config/env-selectable (`ALIGN_AGENT_MODEL` / `--model`).
 */
import Anthropic from '@anthropic-ai/sdk';
import { fixProposalSchema, type FixProposal } from '@align/core';
import type { FixProvider, FixProviderInput } from './fixProvider.js';

export const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_SCHEMA_RETRIES = 2;

const TOOL_NAME = 'propose_fix';

const EDIT_BLOCK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    search: {
      type: 'string',
      description:
        'Exact, continuous block present in the file — literal, character-for-character match including whitespace/indentation/newlines. Include 1-2 lines of untouched context above/below for uniqueness.',
    },
    replace: { type: 'string', description: 'Replacement text. Empty string means deletion.' },
    nearLine: {
      type: 'integer',
      description: 'Approximate 1-based line number, used ONLY to disambiguate if `search` matches more than once. Never affects file content.',
    },
    forViolations: { type: 'array', items: { type: 'string' }, description: 'Violation ids this edit addresses.' },
  },
  required: ['search', 'replace'],
} as const;

const FIX_PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative path, exactly as given in the violation payload.' },
          edits: { type: 'array', items: EDIT_BLOCK_JSON_SCHEMA, minItems: 1 },
        },
        required: ['path', 'edits'],
      },
      minItems: 1,
    },
    rationale: { type: 'string', description: 'Short explanation — becomes the git commit body.' },
  },
  required: ['files', 'rationale'],
} as const;

export interface AnthropicFixProviderOptions {
  /** Falls back to the SDK's own credential resolution (env/profile) when omitted — never log it. */
  readonly apiKey?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly schemaRetries?: number;
}

function renderInputPrompt(input: FixProviderInput, correction?: string): string {
  const parts: string[] = [];

  parts.push(
    'You are fixing architecture-conformance violations in a TypeScript monorepo. Respond ONLY by ' +
      `calling the \`${TOOL_NAME}\` tool with a FixProposal. Adhere strictly to the schema: emit only ` +
      'the precise chunks requiring modification (search/replace edit blocks, never full files, never ' +
      'line-number diffs); `search` must match the file exactly including whitespace/indentation/' +
      'newlines; include 1-2 lines of untouched context above/below each block for uniqueness. Do not ' +
      'use the `suppressions` field — no suppressible rule categories are active in this repo.',
  );

  parts.push('\n## Rule explanations\n');
  for (const exp of input.ruleExplanations) {
    parts.push(`- ${exp.ruleId} (${exp.kind})${exp.because ? `: ${exp.because}` : ''}`);
  }

  parts.push('\n## Violations\n');
  for (const v of input.violations) {
    parts.push(
      `- id=${v.id} rule=${v.ruleId} kind=${v.kind} ${v.file}:${v.range.startLine}-${v.range.endLine}\n  snippet: ${v.snippet}`,
    );
  }

  parts.push('\n## Current file contents\n');
  for (const [path, content] of input.fileContents) {
    parts.push(`### ${path}\n\`\`\`\n${content}\n\`\`\``);
  }

  if (input.condensedSymbolTable.length > 0) {
    parts.push('\n## Importable symbols (files this target may import)\n');
    for (const entry of input.condensedSymbolTable) {
      parts.push(`- ${entry.file}: ${entry.exports.join(', ')}`);
    }
    parts.push('Only reference symbols that exist above — do not invent imports.');
  }

  if (input.previousFailure !== undefined) {
    parts.push(`\n## Previous attempt failed to apply\n`);
    parts.push(`reason: ${input.previousFailure.reason}`);
    if (input.previousFailure.nearestCandidate !== undefined) {
      parts.push(
        `Nearest candidate region (line numbers for your reference only — do NOT include them in \`search\`):\n${input.previousFailure.nearestCandidate.linesWithContext}`,
      );
    }
    parts.push('Re-anchor your `search` block to match the file exactly, character-for-character.');
  }

  if (correction !== undefined) {
    parts.push(`\n## Your previous response was invalid\n${correction}\nRetry, adhering strictly to the schema.`);
  }

  return parts.join('\n');
}

export class AnthropicFixProvider implements FixProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly schemaRetries: number;

  constructor(options: AnthropicFixProviderOptions = {}) {
    this.client = options.apiKey !== undefined ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic();
    this.model = options.model ?? process.env['ALIGN_AGENT_MODEL'] ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.schemaRetries = options.schemaRetries ?? DEFAULT_SCHEMA_RETRIES;
  }

  async proposeFix(input: FixProviderInput): Promise<FixProposal> {
    let correction: string | undefined;

    for (let attempt = 0; attempt <= this.schemaRetries; attempt++) {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        tools: [
          {
            name: TOOL_NAME,
            description: 'Propose a search/replace edit-block fix for the given violations.',
            input_schema: FIX_PROPOSAL_JSON_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [{ role: 'user', content: renderInputPrompt(input, correction) }],
      });

      if (message.stop_reason === 'refusal') {
        throw new Error('AnthropicFixProvider: model refused the request');
      }

      const toolUse = message.content.find((block) => block.type === 'tool_use' && block.name === TOOL_NAME);
      if (toolUse === undefined || toolUse.type !== 'tool_use') {
        correction = 'No tool call was returned. You must call the tool with a valid FixProposal.';
        continue;
      }

      const parsed = fixProposalSchema.safeParse(toolUse.input);
      if (parsed.success) return parsed.data;

      correction = `Schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
    }

    throw new Error(`AnthropicFixProvider: exceeded ${this.schemaRetries} schema-mismatch retries`);
  }
}
