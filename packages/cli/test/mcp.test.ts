import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

async function connectedClient(rootDir: string): Promise<Client> {
  const server = createMcpServer(rootDir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[];
  const first = content[0];
  if (first === undefined || first.text === undefined) throw new Error('expected a text content block');
  return first.text;
}

describe('align mcp — align_check', () => {
  it('returns a structured-only payload with the expected shape on a red fixture', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({ name: 'align_check', arguments: {} });
    const payload = JSON.parse(textOf(result)) as {
      verdict: string;
      gates: { gate: string; violationCount: number }[];
      violations: unknown[];
      advisories: unknown[];
    };
    expect(payload.verdict).toBe('red');
    expect(payload.gates.map((g) => g.gate)).toEqual(['parse', 'architecture']);
    expect(payload.violations).toHaveLength(1);
    // Structured-fields-only (ADR 007): no `message` prose field on the machine payload.
    expect(payload.violations[0]).not.toHaveProperty('message');
  });

  it('never includes a mermaid field — diagrams are explain-only (ADR 007 pull-on-demand)', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({ name: 'align_check', arguments: {} });
    const text = textOf(result);
    expect(text).not.toContain('mermaid');
  });

  it('green fixture reports zero violations and passCount, not per-item text', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app'));
    const result = await client.callTool({ name: 'align_check', arguments: {} });
    const payload = JSON.parse(textOf(result)) as { verdict: string; violations: unknown[] };
    expect(payload.verdict).toBe('green');
    expect(payload.violations).toHaveLength(0);
  });

  it('a red response for a small violation set stays well under ~1K tokens (ADR 007 budget, ~4 chars/token heuristic)', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({ name: 'align_check', arguments: {} });
    const text = textOf(result);
    const approxTokens = text.length / 4;
    expect(approxTokens).toBeLessThan(1000);
  });
});

describe('align mcp — align_violations', () => {
  it('returns violations and pagination fields only', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({ name: 'align_violations', arguments: {} });
    const payload = JSON.parse(textOf(result)) as { violations: unknown[] };
    expect(payload.violations).toHaveLength(1);
  });
});

describe('align mcp — align_explain_rule', () => {
  it('explains a known rule with its components and because text', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({
      name: 'align_explain_rule',
      arguments: { ruleId: 'arch.no-dependency:api->ui' },
    });
    const payload = JSON.parse(textOf(result)) as { ruleId: string; because?: string; components: { name: string }[] };
    expect(payload.ruleId).toBe('arch.no-dependency:api->ui');
    expect(payload.because).toBe('The API must remain headless.');
    expect(payload.components.map((c) => c.name).sort()).toEqual(['api', 'ui']);
  });

  it('reports an error for an unknown rule id rather than throwing', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({ name: 'align_explain_rule', arguments: { ruleId: 'no-such-rule' } });
    expect(result.isError).toBe(true);
  });

  it('includes a fenced Mermaid diagram for a rule with a live violation', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app-violation'));
    const result = await client.callTool({
      name: 'align_explain_rule',
      arguments: { ruleId: 'arch.no-dependency:api->ui' },
    });
    const payload = JSON.parse(textOf(result)) as { mermaid?: string };
    expect(payload.mermaid).toBeDefined();
    expect(payload.mermaid).toContain('```mermaid');
    expect(payload.mermaid).toContain('graph LR');
  });

  it('omits mermaid for a rule with no current violation to diagram', async () => {
    const client = await connectedClient(path.join(fixturesDir, 'simple-app'));
    const result = await client.callTool({ name: 'align_explain_rule', arguments: { ruleId: 'arch.no-cycles:repo' } });
    const payload = JSON.parse(textOf(result)) as { mermaid?: string };
    expect(payload.mermaid).toBeUndefined();
  });
});
