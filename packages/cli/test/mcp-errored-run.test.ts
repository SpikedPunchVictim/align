import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { connectedClient, copiedFixture, removeFixtureCopies, textOf } from './mcp-test-helpers.js';
import { runCheck } from '../src/commands/check.js';

/**
 * LEDGER **D047** — an errored scan must not reach an agent as an empty violation list, and must
 * carry the reason it errored.
 *
 * Measured on a copy of `simple-app` with one component selector repointed at a path that does not
 * exist, driving the real MCP server over an in-memory transport:
 *
 *     ===== align_check =====      isError: false
 *     { "verdict": "error", "complete": false,
 *       "gates": [ { "gate": "parse", "status": "error", "violationCount": 0, ... } ],
 *       "violations": [], "advisories": [], ... }
 *
 *     ===== align_violations =====  isError: false
 *     { "violations": [] }
 *
 * **The second one is the severe half and it is not about messages at all.** An agent that asks
 * "what violations are there?" is told `[]` with no error flag — byte-identical to the answer for a
 * clean repository. The scan evaluated no rule; absent means "never verified", and here it is being
 * rendered as "none". `align_check` at least reports `verdict: "error"`, so a careful caller can
 * branch; `align_violations` gives it nothing to branch on. CLAUDE.md rule 6 — reports success
 * wrongly — on the surface this project calls its primary consumer.
 *
 * `align_check`'s half is the milder one: the verdict is honest, the diagnosis is missing.
 * `GateResult.errorMessage` holds six lines naming the component, the selector, and three remedies;
 * the human surface prints all of it and the payload dropped the field.
 *
 * **Why `align_violations` refuses rather than reporting the error inside a normal response.** It
 * has ONE job and cannot do it: there is no violation list to return, partial or otherwise. An
 * `isError` response is the same answer the handler already gives when `freshCheck` throws, and it
 * puts the reason where the agent will read it. A `{violations: [], error: ...}` hybrid would leave
 * the misreadable `[]` in place for any caller that reads the field it asked for.
 *
 * A RED run is deliberately NOT refused: violations exist, the list is real, and refusing would
 * make the tool useless for its actual purpose.
 */

let tmpDir: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});
afterAll(removeFixtureCopies);

/** `simple-app` with a second component whose selector matches nothing — the cheapest way to error
 * the parse gate through the real pipeline rather than by constructing a `CheckRun` by hand. */
function erroredRepo(): string {
  const dir = copiedFixture('simple-app');
  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    "import { defineProject } from '@spikedpunch/align-core/dsl';\n\n" +
      "export default defineProject({\n  components: { app: 'src/**', ghost: 'no/such/place/**' },\n" +
      '  rules: (c) => [c.arch.noCycles()],\n});\n',
    'utf8',
  );
  return dir;
}

describe('align_check reports WHY it errored [D047]', () => {
  it('carries the errored gate’s message', async () => {
    const client = await connectedClient(erroredRepo());

    const payload = JSON.parse(textOf(await client.callTool({ name: 'align_check', arguments: {} })));

    // PREMISE [S-05]: without an errored run, every assertion below is about nothing.
    expect(payload.verdict).toBe('error');

    const parse = payload.gates.find((g: { gate: string }) => g.gate === 'parse');
    expect(parse.status).toBe('error');
    // Before the fix: the gate object had no `errorMessage` key at all.
    expect(parse.errorMessage).toContain('ghost');
    expect(parse.errorMessage).toContain('no/such/place/**');
  });
});

describe('align_violations does not report an errored scan as "no violations" [D047]', () => {
  it('refuses, naming the gate and the reason', async () => {
    const client = await connectedClient(erroredRepo());

    const result = await client.callTool({ name: 'align_violations', arguments: {} });

    // Before the fix: `isError: false` and `{"violations": []}` — indistinguishable from clean.
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('parse gate');
    expect(text).toContain('ghost');
    // The text must not be readable as a violation list; an agent that string-matches for an empty
    // array should find nothing that looks like one.
    expect(text).not.toContain('"violations": []');
  });

  it('still answers normally for a RED repo — the refusal is for errored runs only [S-04]', async () => {
    // The calibration that matters most: this tool exists to list violations, and a fix that
    // refused whenever anything was wrong would refuse in exactly the case it is called for.
    const client = await connectedClient(copiedFixture('simple-app-violation'));

    const result = await client.callTool({ name: 'align_violations', arguments: {} });

    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(textOf(result));
    expect(payload.violations.length).toBeGreaterThan(0);
  });

  it('still answers normally for a GREEN repo [S-04]', async () => {
    const client = await connectedClient(copiedFixture('simple-app'));

    const result = await client.callTool({ name: 'align_violations', arguments: {} });

    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(textOf(result)).violations).toEqual([]);
  });
});

describe('align check --json carries the reason too [D047]', () => {
  it('puts the errored gate’s message on stdout, where the exit code alone said nothing', async () => {
    // The other machine surface named in the same fix. Measured before it: exit 1, a JSON payload
    // with no reason in it, and an EMPTY stderr — nothing on either stream told the user what broke.
    tmpDir = erroredRepo();
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void chunks.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let code: number;
    try {
      code = await runCheck(tmpDir, { json: true });
    } finally {
      process.stdout.write = write;
    }

    expect(code).toBe(1);
    const payload = JSON.parse(chunks.join(''));
    expect(payload.verdict).toBe('error');
    expect(payload.gates.find((g: { gate: string }) => g.gate === 'parse').errorMessage).toContain('ghost');
  });
});
