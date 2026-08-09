import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';

// Shared by every MCP tool-level test file (`mcp.test.ts`, `mcp-baseline-gate.test.ts`, ...) — one
// in-memory client/transport wiring and one text-content extractor, not a hand-copy per file
// (CODING_BEST_PRACTICES.md #26: this is the same fact in every caller, not a coincidental
// similarity). Split out of `mcp.test.ts` when that file crossed align's own 500-line
// `arch.metric` limit for the `cli` component (`docs/ARCHITECTURE-RULES.md`).

export const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export async function connectedClient(rootDir: string): Promise<Client> {
  const server = createMcpServer(rootDir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

export function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[];
  const first = content[0];
  if (first === undefined || first.text === undefined) throw new Error('expected a text content block');
  return first.text;
}
