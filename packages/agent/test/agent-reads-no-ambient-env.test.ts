import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `packages/agent` must read `process.env` nowhere — the sibling of core's `node:fs` invariant, for
 * the same reason and enforced the same way.
 *
 * **Why it needed to become executable.** `AnthropicFixProvider`'s constructor read
 * `process.env['ALIGN_AGENT_MODEL']` directly, and it was the only ambient environment read below an
 * entry point anywhere in this repo. It was also **untested**, and those two facts are the same fact:
 * exercising the env branch would have meant mutating `process.env` inside a test, which is precisely
 * the cost that makes ambient reads worth eliminating rather than documenting. The value is now
 * resolved once at the CLI entry point (`cli/src/program.ts` → `resolveAgentModel`) and threaded in
 * as `options.model`, exactly as `ALIGN_TELEMETRY` already was.
 *
 * **What this defends.** This package is the functional-core side of the shell/core split: the fix
 * loop's behaviour must be reproducible from its arguments, so that a caller — the CLI, a test, some
 * future embedder — gets the same run for the same inputs. One `process.env` read makes that false
 * for every caller at once, invisibly, and no type signature shows it.
 *
 * If this fails, do not add the read. Resolve it at the CLI boundary and pass it down.
 */

const AGENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(abs);
    return entry.isFile() && abs.endsWith('.ts') ? [abs] : [];
  });
}

/** ONE definition, used by both the check and its calibration — the discipline
 * `core-is-filesystem-free.test.ts` records: writing the pattern twice means a typo in the check
 * leaves the calibration green and the invariant silently lapses.
 *
 * Known boundary, stated rather than discovered later: this catches `process.env` in both access
 * forms (`process.env.X` and `process.env['X']`) and a destructured `const { env } = process`. It
 * does NOT catch `globalThis.process.env`, a computed member access, or an env value handed in by a
 * dependency — each of which needs deliberate evasion, and this package's runtime dependencies are
 * `@anthropic-ai/sdk` and `@spikedpunch/align-core` alone. */
const ENV_READ = /\bprocess\s*\.\s*env\b|\{\s*env\s*\}\s*=\s*process\b/g;

/** Strips line and block comments, so a doc comment that MENTIONS `process.env` — several here
 * legitimately do, explaining why this package does not read it — is not counted as a read. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('packages/agent reads no ambient environment', () => {
  it('has no process.env access in any source file', () => {
    const offenders = sourceFiles(AGENT_SRC)
      .map((file) => ({ file, hits: [...stripComments(fs.readFileSync(file, 'utf8')).matchAll(ENV_READ)] }))
      .filter(({ hits }) => hits.length > 0)
      .map(({ file }) => path.relative(AGENT_SRC, file));

    expect(offenders).toEqual([]);
  });

  it('would catch one if it came back (the pattern is calibrated, not decorative)', () => {
    // Without this, a typo in ENV_READ leaves the check above permanently green — the
    // passes-for-the-wrong-reason shape [S-05] this project treats as severity-zero in a guard.
    const reintroduced = "const model = options.model ?? process.env['ALIGN_AGENT_MODEL'];";

    expect([...stripComments(reintroduced).matchAll(ENV_READ)]).toHaveLength(1);
    expect([...stripComments('process.env.ALIGN_AGENT_MODEL').matchAll(ENV_READ)]).toHaveLength(1);
    // ...and does not fire on prose about it, which is why the comment strip exists.
    expect([...stripComments('// reads process.env nowhere\n').matchAll(ENV_READ)]).toHaveLength(0);
  });
});
