// MCP stdio client — increment 2 (ADR 025 §7's `mcp` row; ADR 024's baseline-acceptance gate).
//
// Spawns the REAL `align mcp` command (the exact entry point `exec.mjs`'s `runAlign` uses for
// every other command) and speaks genuine MCP JSON-RPC over its stdio, using the
// `@modelcontextprotocol/sdk` client that is already installed in the WORKING COPY's own
// `node_modules` — it ships there because `@spikedpunch/align-cli` depends on it directly
// (`packages/cli/package.json`), not because the harness does. This keeps ADR 025's "zero new
// runtime dependency" property intact: nothing is added to the harness's own package graph (it has
// none — Node ESM only), and the SDK version exercised is whatever version the align build under
// test actually ships with, not a harness-pinned one that could quietly drift from it.
//
// Deliberately NOT the in-process `InMemoryTransport` the CLI's own unit tests use
// (`packages/cli/test/mcp-test-helpers.ts`) — that connects a client directly to
// `createMcpServer()` inside the SAME process, which never exercises the actual `align mcp` CLI
// subcommand, its stdio framing, or the installed build's own `dist/index.js` entry point. A real
// child-process stdio round trip is the whole point of this harness (ADR 025 §1): commands run for
// real, and the result is asserted, never simulated.
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeEnv } from './exec.mjs';
import { normalizeText, makeNormalizeContext } from './normalize.mjs';

/** Resolves an SDK subpath (e.g. `'client/index.js'`) against the WORKING COPY's own installed
 * copy, never the harness's own tree (the harness has no `node_modules` of its own to resolve
 * against) — see this module's header comment for why the SDK version under test must be the
 * installed build's, not a harness-pinned one. */
function sdkModuleUrl(workingDir, subpath) {
  return pathToFileURL(path.join(workingDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', subpath)).href;
}

function alignCliEntry(workingDir) {
  return path.join(workingDir, 'node_modules', '@spikedpunch', 'align-cli', 'dist', 'index.js');
}

/**
 * Calls one MCP tool over a fresh `align mcp` child process (one connection per call — simpler and
 * more diagnosable than pooling a long-lived connection across a scenario's steps, and MCP tool
 * calls are cheap enough that reconnecting every time is not a meaningful cost here).
 *
 * Returns `{ isError, text, textNormalized, durationMs }` for a call that reached a real MCP tool
 * response — INCLUDING a tool-level refusal (`isError: true` in a well-formed `CallToolResult`,
 * e.g. ADR 024's gate refusal). That is a normal, expected, declarative outcome for the caller's
 * `expect` block to evaluate, exactly like a non-zero exit code is for a `run` step — never an
 * exception here.
 *
 * Throws only when the harness itself could not complete the round trip: the child process failed
 * to launch, the stdio handshake never completed, or the SDK/CLI produced a transport-level
 * failure rather than a tool response. Mirrors `runAlign`'s "never throws on a non-zero exit, but
 * DOES throw on a launch failure" contract from `exec.mjs` — the same ERROR-vs-FAIL distinction
 * this harness draws everywhere (`README.md`'s "PASS / FAIL / ERROR" section).
 */
export async function callMcpTool(workingDir, toolName, args, options = {}) {
  const { Client } = await import(sdkModuleUrl(workingDir, 'client/index.js'));
  const { StdioClientTransport } = await import(sdkModuleUrl(workingDir, 'client/stdio.js'));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [alignCliEntry(workingDir), 'mcp'],
    cwd: workingDir,
    env: sanitizeEnv(),
    stderr: 'pipe', // don't let the server's stderr ('[align] MCP server ready on stdio', ADR009 log lines) leak to the harness's own stderr
  });
  const client = new Client({ name: 'align-integration-harness', version: '0.0.0' });

  const start = Date.now();
  let result;
  try {
    await client.connect(transport);
    result = await client.callTool({ name: toolName, arguments: args });
  } catch (err) {
    throw new Error(
      `mcp call '${toolName}' failed to complete a round trip against the child 'align mcp' process in ${workingDir}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      await client.close();
    } catch {
      // best-effort teardown — a close failure after a successful call is not this call's outcome
    }
  }
  const durationMs = Date.now() - start;

  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .join('');
  const ctx = makeNormalizeContext(workingDir, workingDir, options.keepVersion ?? false);
  return { isError: result.isError === true, text, textNormalized: normalizeText(text, ctx), durationMs };
}
