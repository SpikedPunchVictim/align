import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Whether a dependency declares a public surface at all — LEDGER D055.
 *
 * **The defect.** `align doctor`'s deep-import advisory reported
 * `import 'reactflow/dist/style.css'` as *"reaches past reactflow's public surface via 'dist'"*.
 * Measured on the reporter's fixture: reactflow's manifest has **no `exports` field**, only
 * `main: dist/index.js`. Under Node resolution that makes every subpath in the package public —
 * `dist/style.css` is its documented stylesheet path — so there is no encapsulation boundary for the
 * import to reach past. The advisory was not noisy, it was false.
 *
 * **This is NOT ADR 020's Arm-B, and that distinction is the whole justification.** Arm-B was full
 * `exports`-map subpath resolution — deciding whether a *specific* subpath is exported — and the
 * ADR's placebo test measured it as not worth its cost. That decision stands. This asks one bit:
 * *does a declared surface exist?* One manifest read per distinct target package, no subpath
 * resolution, no conditions, no fallbacks. It removes a class of claim that is wrong by
 * construction rather than refining claims that are right.
 *
 * **Unknown answers TRUE, deliberately, and the direction is the opposite of what "not found"
 * suggests.** This predicate gates a false-positive FILTER. Answering `false` for a package we could
 * not read would suppress every deep-import advisory in a repository with no `node_modules`
 * installed — converting a false-positive fix into a false negative, which is the worse trade for an
 * advisory whose whole value is noticing something. Not found, unreadable, malformed: all report
 * `true`, preserving exactly today's behaviour.
 *
 * Lives in the CLI because it reads a `package.json`. Core does no filesystem I/O, and this
 * repository enforces that executably ("core imports `node:fs` nowhere").
 */
export function packageDeclaresExportsMap(fromDir: string, packageName: string): boolean {
  const manifest = findPackageManifest(fromDir, packageName);
  if (manifest === undefined) return true; // unknown -> keep reporting, see the note above
  return manifest.exports !== undefined;
}

/**
 * Walks `node_modules` upward from `fromDir`, the way Node itself resolves.
 *
 * Upward rather than a single lookup at the repo root because hoisting is the norm: in a pnpm or npm
 * workspace the importing package's own `node_modules` usually does not hold the dependency, and a
 * root-only check would answer "not found" for most real monorepos — which, given the unknown-is-true
 * rule above, would quietly make this filter a no-op exactly where it is needed.
 */
function findPackageManifest(fromDir: string, packageName: string): { readonly exports?: unknown } | undefined {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...packageName.split('/'), 'package.json');
    try {
      if (fs.statSync(candidate).isFile()) {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')) as { readonly exports?: unknown };
      }
    } catch {
      // Missing here, or present and unparseable. Both fall through: a malformed manifest is not
      // evidence of an absent surface, and the caller's unknown-is-true rule handles it.
      if (fs.existsSync(candidate)) return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
