import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { runCheck } from '../src/commands/check.js';

/**
 * LEDGER **D044** (bug hunt FRAGILE F3) — every glob pattern a human can write in
 * `align.config.ts` must be linted against align's glob dialect, not just the component selectors.
 *
 * align's glob matcher is deliberately minimal (`components/glob.ts`, zero-dependency core): `*`,
 * `**`, `?`, flat `{a,b}` braces, literals. `globToRegExp` ESCAPES every other metacharacter, so an
 * unsupported construct does not error and does not approximate — it compiles to a literal that
 * matches nothing. `lintGlobPattern` exists to make that loud, and `validateSelectorSyntax` applies
 * it to component selectors.
 *
 * Three sibling config exports are matched by the SAME `globMatch` and were linted by nothing:
 *
 *   - `excludes`               -> `scanner.ts`'s `matchingExcludePattern`, and the manifest walk
 *   - `includeNestedCheckouts` -> `scanner.ts`'s `isExcludedPath`, "matched the same way excludes
 *                                 matches" (its own doc comment in `config.ts`)
 *   - `knownPublicDeepImports` -> `gates/deep-imports.ts`'s `isAllowlisted`
 *
 * Measured, on a two-component repo with an api->ui violation and
 * `export const excludes = ['src/+(api|legacy)/**']`:
 *
 *     $ align check
 *       architecture RED    1 violation(s)
 *         ✗ src/api/service.ts:1  arch.no-dependency:api->ui
 *
 * The exclude did nothing and said nothing. The user asked align to stop looking at `src/api`,
 * align looked anyway, and the only evidence is a violation they thought they had silenced.
 *
 * **Which direction the silence runs, stated plainly.** All three fail SAFE for the verdict: an
 * inert `excludes` scans more, an inert `includeNestedCheckouts` scans less but records a blind
 * spot (ADR 028), an inert `knownPublicDeepImports` reports an advisory it was told to suppress.
 * None of them is a false green, and that is why this was filed FRAGILE rather than as a live
 * defect. What is wrong is the asymmetry: the identical pattern in a component selector is a hard
 * load-time error naming the exact construct, and in these three it is nothing at all — so a user
 * who learns the dialect from the error message align gave them yesterday gets no message today.
 * [S-09], four arms, one linted.
 *
 * `compositionRoots` is deliberately NOT linted: those are component NAMES. `doctor.ts` builds a
 * `Set<ComponentName>` from them and `computeUngovernedEdgeGaps` asks `compositionRoots.has(from)`
 * — exact membership, never a pattern match. Read rather than assumed. The table below is the
 * register of the ones that ARE patterns, so a fourth cannot be added silently.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** `simple-app` plus an api->ui import, so an inert `excludes` is VISIBLE as a violation the user
 * believed they had excluded rather than as an invisible non-event. */
function repoWithConfig(configBody: string): string {
  const dir = (tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-glob-lint-')));
  fs.cpSync(path.join(here, 'fixtures', 'simple-app'), dir, { recursive: true });
  const scopeDir = path.join(dir, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
  fs.mkdirSync(path.join(dir, 'src/api'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/ui/component.ts'), "export function render(): string {\n  return 'x';\n}\n", 'utf8');
  fs.writeFileSync(
    path.join(dir, 'src/api/service.ts'),
    "import { render } from '../ui/component.js';\nexport function handle(): string {\n  return render();\n}\n",
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'align.config.ts'), configBody, 'utf8');
  return dir;
}

const TWO_COMPONENTS = `import { defineProject } from '@spikedpunch/align-core/dsl';

export default defineProject({
  components: { api: 'src/api/**', ui: 'src/ui/**' },
  rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],
});
`;

/**
 * The glob-carrying string[] exports, each with an unsupported construct and the dialect label
 * `lintGlobPattern` returns for it. Kept as a table rather than three copied tests so adding a
 * fourth export is one row — the register pattern the D037 invariant established.
 */
const GLOB_EXPORTS: readonly { readonly name: string; readonly pattern: string; readonly label: RegExp }[] = [
  { name: 'excludes', pattern: 'src/+(api|legacy)/**', label: /extglob|alternation/ },
  { name: 'includeNestedCheckouts', pattern: 'vendor/[ab]*', label: /character class/ },
  { name: 'knownPublicDeepImports', pattern: 'typescript/lib/!(internal)/**', label: /extglob|alternation/ },
];

describe('every glob-carrying config export is linted against align’s dialect [D044]', () => {
  for (const { name, pattern, label } of GLOB_EXPORTS) {
    it(`\`${name}\` rejects an unsupported pattern at config load`, async () => {
      const dir = repoWithConfig(`${TWO_COMPONENTS}\nexport const ${name} = ${JSON.stringify([pattern])};\n`);

      // Before the fix: resolves, and the pattern silently matches nothing forever.
      await expect(loadConfig(dir)).rejects.toThrow(new RegExp(`\`?${name}\`?`));
      await expect(loadConfig(dir)).rejects.toThrow(label);
      // The message must carry the offending pattern itself — a lint that says "one of your
      // excludes is bad" on a list of thirty is a worse error than none.
      await expect(loadConfig(dir)).rejects.toThrow(pattern); // a bare string is a SUBSTRING match in vitest
    });
  }

  it('accepts every pattern the dialect really supports [S-04]', async () => {
    // Calibration, and the arm that would actually hurt: a lint that over-rejects breaks working
    // repositories at load, for a construct align matches correctly.
    const dir = repoWithConfig(
      `${TWO_COMPONENTS}
export const excludes = ['dist', 'dist/**', '**/*.test.ts', 'packages/*/generated/**', 'src/{a,b}/**', 'f?o/**'];
export const includeNestedCheckouts = ['vendor/submodule'];
export const knownPublicDeepImports = ['typescript/lib/**', 'mocha/lib/*'];
export const compositionRoots = ['api'];
`,
    );

    const loaded = await loadConfig(dir);

    expect(loaded.excludes).toHaveLength(6);
    expect(loaded.includeNestedCheckouts).toEqual(['vendor/submodule']);
  });

  it('reports the bad exclude as a clean CLI error, not a scan that quietly ignored it', async () => {
    // The user-visible half. Before the fix this run printed the api->ui violation the exclude was
    // written to suppress, exit 1, with no mention of the pattern anywhere.
    const dir = repoWithConfig(`${TWO_COMPONENTS}\nexport const excludes = ['src/+(api|legacy)/**'];\n`);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const code = await runCheck(dir, { json: false });

    expect(code).not.toBe(0);
    expect(errors.join('\n')).toMatch(/excludes/);
    expect(errors.join('\n')).toMatch(/src\/\+\(api\|legacy\)\/\*\*/);
    // No raw stack trace — same discipline as BUG #14's clean-catch tests.
    expect(/^\s*at\s+\S+\s+\(.*:\d+:\d+\)/m.test(errors.join('\n'))).toBe(false);
  });

  it('`compositionRoots` is component NAMES and stays unlinted [S-04]', async () => {
    // A name is not a pattern — `computeUngovernedEdgeGaps` asks `compositionRoots.has(from)`.
    // Linting it would reject nothing real today, but it would encode the wrong idea about what
    // that export is, and the next reader would match it with `globMatch`.
    const dir = repoWithConfig(`${TWO_COMPONENTS}\nexport const compositionRoots = ['api'];\n`);

    await expect(loadConfig(dir)).resolves.toBeDefined();
  });
});
