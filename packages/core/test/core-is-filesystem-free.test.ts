import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `packages/core` must import `node:fs` nowhere. This is the constraint that forced ADR 028's
 * existence probe to be INJECTED rather than called directly, and the plan for that stage asked for
 * the grep proving it to be "part of the stage, not an assumption". A grep run once by hand is an
 * assumption the moment the next person adds a file — so it is executable here instead.
 *
 * The rule is not aesthetic. Core is the functional core (CODING_BEST_PRACTICES.md §15/§16): every
 * inference it draws must be reproducible from its inputs, which is what lets the whole baseline
 * domain be tested without a filesystem and what stops a scan-scope question from being answered
 * two different ways in two different layers. The imperative shell — `packages/cli`,
 * `packages/plugin-typescript` — owns real I/O.
 *
 * If this fails, do not add the import. Inject the capability the way `FileExistenceProbe`,
 * `ManifestScanner` and `HostPredicateRegistry` already are.
 */

const CORE_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(abs);
    return entry.isFile() && abs.endsWith('.ts') ? [abs] : [];
  });
}

/** ONE definition, used by both the check and its calibration below. Writing the pattern twice —
 * as this file originally did — means a typo in the check leaves the calibration green and the
 * invariant silently lapses, which is the permanently-green-check shape this repo treats as
 * severity-zero. The calibration must exercise the same constant the check uses.
 *
 * Known boundary, stated rather than discovered later: static specifiers only — `import`,
 * `require`, `import type`, `export ... from`, `import fs = require(...)`, and dynamic
 * `await import('node:fs')`. It does NOT catch a computed/template specifier, `createRequire`
 * indirection, or a third-party filesystem wrapper (`graceful-fs`, `fs-extra`). Each of those needs
 * either deliberate evasion or a new dependency, and core's runtime dependencies are `zod` alone. */
const FS_IMPORT = /(?:\b(?:import|require)\s*\(?\s*|\bfrom\s*)['"](node:fs(?:\/promises)?|fs(?:\/promises)?)['"]/g;

/** Strips line and block comments so a doc comment that MENTIONS `node:fs` — several legitimately
 * do, explaining why core does not import it — is not mistaken for an import. Deliberately crude:
 * it only has to be conservative in the direction of over-reporting, and a false positive here is a
 * five-second read, whereas a false negative is the constraint silently lapsing. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('packages/core is filesystem-free (ADR 028 relies on this)', () => {
  it('imports no filesystem or path-I/O module anywhere under src/', () => {
    const offenders = sourceFiles(CORE_SRC).flatMap((file) => {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      return [...code.matchAll(FS_IMPORT)].map((m) => `${path.relative(CORE_SRC, file)} -> ${m[1]}`);
    });

    expect(offenders).toEqual([]);
  });

  it('the detector actually detects — a negative test would otherwise pass forever on a broken regex', () => {
    // Without this, a typo in the pattern above yields a permanently green check that proves
    // nothing: exactly the false-green shape this repo treats as severity-zero.
    const samples = [
      `import * as fs from 'node:fs';`,
      `import { readFileSync } from "fs";`,
      `import fsp from 'node:fs/promises';`,
      `const fs = require('fs');`,
      `import fs = require('fs');`,
      `const fs = await import('node:fs');`,
      `export * from 'node:fs';`,
      `export { readFileSync } from 'fs';`,
    ];
    for (const sample of samples) {
      // Same constant the check uses — see FS_IMPORT's comment for why that matters. `matchAll`
      // rather than `.test`, because a `/g` regex carries `lastIndex` between `.test` calls and
      // would report every other sample as a miss.
      expect([...stripComments(sample).matchAll(FS_IMPORT)].length, sample).toBeGreaterThan(0);
    }
    // And a doc comment mentioning it must NOT trip the check.
    expect(stripComments(`/** core imports node:fs nowhere */`).trim()).toBe('');
  });
});
