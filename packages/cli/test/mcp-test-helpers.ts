import * as fs from 'node:fs';
import * as os from 'node:os';
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
  // EXECUTABLE INVARIANT, not a convention (CLAUDE.md: a shape with a second instance earns one).
  // Pointing a server at a committed fixture worked for as long as no MCP tool wrote anything, and
  // ADR 029 ended that silently — `align_check` began leaving `.align/last-scan.json` inside
  // `test/fixtures/`. Refusing here is order-independent, which a "fixtures are clean" assertion in
  // some other test file would not be: it would only catch the pollution if it happened to run last.
  if (rootDir === fixturesDir || rootDir.startsWith(`${fixturesDir}${path.sep}`)) {
    throw new Error(
      `MCP tests must not run against a committed fixture (${path.relative(fixturesDir, rootDir)}): an MCP tool ` +
        'that writes would mutate the repository. Use `copiedFixture(name)`.',
    );
  }
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

const copies: string[] = [];

/**
 * A throwaway copy of a fixture, for any MCP test that starts a server against it.
 *
 * **Never point a server at `fixtures/<name>` directly.** These fixtures are committed, and an MCP
 * tool that writes anything mutates the working tree of whoever runs the suite. That was a latent
 * assumption until ADR 029 made `align_check` a writer: the next run of `pnpm test` left
 * `.align/last-scan.json` inside `fixtures/simple-app` and `fixtures/simple-app-violation`, showing
 * up as untracked files in `git status` — found by an unrelated test failing on the leftovers rather
 * than by anything watching for it.
 *
 * This is the unit-level shape of ADR 026's declared write-sets: a command may write only where its
 * caller expects, and the way to keep that true is to give it somewhere disposable to write.
 */
export function copiedFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-mcp-fixture-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  copies.push(dest);
  return dest;
}

/** Call from an `afterAll` in every file that uses `copiedFixture`. */
export function removeFixtureCopies(): void {
  for (const dir of copies.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
