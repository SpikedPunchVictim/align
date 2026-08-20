import { describe, expect, it } from 'vitest';
import { ComponentValidationError, validateComponents, validateSelectorSyntax } from '../src/components/registry.js';
import { toComponentName, toRepoRelativePath } from '../src/types/branded.js';
import type { ComponentDefinitionIR, EmptyPolicy } from '../src/types/ir.js';
import type { ComponentName } from '../src/types/branded.js';

/**
 * LEDGER **D045** (found while measuring D044) — the glob-dialect lint must not be shadowed by the
 * zero-match check that runs before it.
 *
 * `validateSelectorSyntax`'s own doc comment states the property it exists to provide: unsupported
 * syntax fails "at the exact pattern, with an actionable message, instead of at scan time as a
 * mysterious zero-match error". Measured on a real repo, that is precisely what a user got:
 *
 *     components: { api: 'src/+(api|legacy)/**', ui: 'src/ui/**' }
 *
 *     $ align check
 *       parse        ERROR
 *         Component 'api' (selector: src/+(api|legacy)/**) matches zero files. Likely cause: its
 *         directory was renamed/moved or the selector is stale. ...
 *
 * The mysterious zero-match error, verbatim, plus a remedy that sends the reader to look for a
 * renamed directory that is sitting right where they left it. CLAUDE.md rule 5 — a comment
 * asserting a property nothing implemented.
 *
 * **The ordering, which is the whole defect.** `validateComponents` runs in the PARSE gate (the
 * plugin scanner calls it — "the first fresh scan IS load time"). `validateSelectorSyntax` runs in
 * the ARCHITECTURE gate, which never executes because parse already errored. An unsupported
 * construct compiles to a literal matching nothing (`globToRegExp` escapes it), so a bad selector
 * ALWAYS matches zero files — the coarse check always wins the race, and the precise one is
 * reachable only for `empty: 'allow' | 'until-populated'`, where the zero-match branch is skipped.
 *
 * So it worked for exactly the case its comment calls out as an afterthought and failed for the
 * default. [S-09], and a sharp one: the lint was not missing, it was unreachable, so the file that
 * proves it exists (`components-registry.test.ts`, calling it directly) passes either way.
 *
 * Fixed by running the syntax check first inside `validateComponents` — syntax before semantics,
 * at the same moment, changing nothing about WHEN validation happens.
 */

function glob(name: string, pattern: string, empty: EmptyPolicy = 'fail'): ComponentDefinitionIR {
  return { name, selector: { kind: 'glob', patterns: [pattern] }, empty };
}

function components(defs: Readonly<Record<string, ComponentDefinitionIR>>): Readonly<Record<ComponentName, ComponentDefinitionIR>> {
  return Object.fromEntries(Object.entries(defs).map(([k, v]) => [toComponentName(k), v])) as Readonly<
    Record<ComponentName, ComponentDefinitionIR>
  >;
}

const NO_PACKAGES = new Map<string, ReturnType<typeof toRepoRelativePath>>();
const SOME_FILES = [toRepoRelativePath('src/api/service.ts'), toRepoRelativePath('src/ui/component.ts')];

describe('the dialect lint is reachable for the DEFAULT empty policy [D045]', () => {
  it('diagnoses unsupported syntax, not a stale directory', () => {
    const defs = components({ api: glob('api', 'src/+(api|legacy)/**') });

    // PREMISE [S-05]: the selector really does match nothing, which is what let the coarse check
    // fire first. Without this the test could pass because the syntax happened to match a file.
    expect(SOME_FILES.some((f) => f.includes('+('))).toBe(false);

    let thrown: unknown;
    try {
      validateComponents(defs, SOME_FILES, NO_PACKAGES);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ComponentValidationError);
    const message = (thrown as Error).message;
    // Before the fix: "matches zero files. Likely cause: its directory was renamed/moved".
    expect(message).toMatch(/extglob|alternation/);
    expect(message).toContain('src/+(api|legacy)/**');
    expect(message).not.toMatch(/renamed\/moved/);
  });

  it('still diagnoses a genuinely stale selector as stale [S-04]', () => {
    // Calibration, and the failure a careless fix would cause: reporting every zero-match component
    // as a dialect problem would bury the message that is right almost every time.
    const defs = components({ api: glob('api', 'src/renamed-away/**') });

    expect(() => validateComponents(defs, SOME_FILES, NO_PACKAGES)).toThrow(/renamed\/moved/);
  });

  it('a valid selector that matches files is silent [S-04]', () => {
    expect(() => validateComponents(components({ api: glob('api', 'src/api/**') }), SOME_FILES, NO_PACKAGES)).not.toThrow();
  });

  it('the greenfield arm that always worked still works', () => {
    // `empty: 'allow'` skips the zero-match branch, which is why `validateSelectorSyntax` used to be
    // the only reachable check for it. Both paths now reject the same pattern, and both must.
    const defs = components({ api: glob('api', 'src/+(api|legacy)/**', 'allow') });

    expect(() => validateComponents(defs, SOME_FILES, NO_PACKAGES)).toThrow(/extglob|alternation/);
    expect(() => validateSelectorSyntax(defs)).toThrow(/extglob|alternation/);
  });
});
