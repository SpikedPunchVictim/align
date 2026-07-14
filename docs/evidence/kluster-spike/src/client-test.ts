/**
 * In-process MCP client test: spawns the stdio server as a child process,
 * exercises both tools over the real protocol, prints a transcript, and
 * measures the serialized payload size of align_check (Q6: token economy).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SPIKE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(SPIKE_DIR, 'out', 'mcp-transcript.txt');

const lines: string[] = [];
function log(text: string): void {
  lines.push(text);
  console.log(text);
}

function logExchange(label: string, request: unknown, response: unknown): void {
  log(`\n=== ${label} ===`);
  log(`--> request: ${JSON.stringify(request)}`);
  log(`<-- response:\n${JSON.stringify(response, null, 2)}`);
}

interface TextResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
}

function firstText(result: TextResult): string {
  const item = result.content?.find((c) => c.type === 'text');
  if (item?.text === undefined) throw new Error('expected a text content item');
  return item.text;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['exec', 'tsx', 'src/mcp.ts'],
    cwd: SPIKE_DIR,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'align-spike-client-test', version: '0.0.0' });
  await client.connect(transport);
  log(`connected: server ${JSON.stringify(client.getServerVersion())}`);

  const tools = await client.listTools();
  logExchange(
    'tools/list',
    {},
    tools.tools.map((t) => ({ name: t.name, description: t.description?.slice(0, 120) })),
  );

  // 1. align_check — full run.
  const checkRequest = { name: 'align_check', arguments: {} };
  const started = performance.now();
  const checkResult = (await client.callTool(checkRequest)) as TextResult;
  const checkMs = Math.round(performance.now() - started);
  const checkText = firstText(checkResult);
  logExchange(`tools/call align_check (cold, ${checkMs} ms)`, checkRequest, JSON.parse(checkText));

  // Second call to demonstrate the cached-graph path.
  const started2 = performance.now();
  await client.callTool(checkRequest);
  const checkMs2 = Math.round(performance.now() - started2);
  log(`\n(second align_check call, cached graph: ${checkMs2} ms)`);

  // 2. align_explain_rule — pick a rule that actually fired.
  const parsed = JSON.parse(checkText) as { violations?: readonly { ruleId: string }[] };
  const firedRuleId = parsed.violations?.[0]?.ruleId ?? 'bt-core-isolated';
  const explainRequest = { name: 'align_explain_rule', arguments: { ruleId: firedRuleId } };
  const explainResult = (await client.callTool(explainRequest)) as TextResult;
  logExchange('tools/call align_explain_rule', explainRequest, JSON.parse(firstText(explainResult)));

  // 3. Error path: unknown rule id must return a structured tool error, not kill the server.
  const badRequest = { name: 'align_explain_rule', arguments: { ruleId: 'does-not-exist' } };
  const badResult = (await client.callTool(badRequest)) as TextResult & { isError?: boolean };
  logExchange('tools/call align_explain_rule (unknown id)', badRequest, {
    isError: badResult.isError,
    text: firstText(badResult),
  });

  // 4. Payload economics (Q6).
  const bytes = Buffer.byteLength(checkText, 'utf8');
  const estTokens = Math.round(bytes / 4);
  const explainBytes = Buffer.byteLength(firstText(explainResult), 'utf8');

  const perViolationSamples: number[] = [];
  const parsedFull = JSON.parse(checkText) as {
    violations?: readonly { items: readonly unknown[] }[];
  };
  for (const group of parsedFull.violations ?? []) {
    for (const item of group.items) perViolationSamples.push(Buffer.byteLength(JSON.stringify(item), 'utf8'));
  }
  const avgViolationBytes =
    perViolationSamples.length === 0
      ? 0
      : Math.round(perViolationSamples.reduce((a, b) => a + b, 0) / perViolationSamples.length);
  const envelopeBytes = bytes - perViolationSamples.reduce((a, b) => a + b, 0);

  log('\n=== PAYLOAD MEASUREMENTS (Q6) ===');
  log(`align_check response: ${bytes} bytes ≈ ${estTokens} tokens (${perViolationSamples.length} violations included)`);
  log(`align_explain_rule response: ${explainBytes} bytes ≈ ${Math.round(explainBytes / 4)} tokens`);
  log(`avg serialized violation: ${avgViolationBytes} bytes ≈ ${Math.round(avgViolationBytes / 4)} tokens`);
  log(`envelope (verdict + counts + uncertainty): ${envelopeBytes} bytes ≈ ${Math.round(envelopeBytes / 4)} tokens`);
  for (const n of [10, 50, 200]) {
    const projected = envelopeBytes + n * avgViolationBytes;
    log(`projected payload with ${n} violations (uncapped): ${projected} bytes ≈ ${Math.round(projected / 4)} tokens`);
  }

  await client.close();
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, lines.join('\n'));
  console.log(`\ntranscript written to ${OUT_FILE}`);
}

main().catch((error: unknown) => {
  console.error('client-test failed:', error);
  process.exitCode = 1;
});
