import { describe, expect, it } from 'vitest';
import { evaluateLayers, evaluateNoDependency, evaluateNoCycles } from '../src/rules/evaluators.js';
import { renderViolationMessage } from '../src/types/violation.js';
import { toComponentName } from '../src/types/branded.js';
import { edge, graph, node } from './helpers.js';
import type { ArchLayersRule, ArchNoCyclesRule, ArchNoDependencyRule } from '../src/types/ir.js';

/**
 * LEDGER **D056** — `import type` is invisible to `arch.no-cycles` and unconditionally fatal to
 * `arch.layers`, with no opt-out and nothing in the message saying so.
 *
 * Reported by a user who hit both directions in one session: align accepts `import type` as the FIX
 * for a cycle — they used it eleven times — and the same erased edge is a hard layering violation.
 * Two rules disagreeing about whether a type-only import is a dependency, with no way to reconcile
 * them and no hint in either message that the edge is type-only.
 *
 * Verified in `evaluators.ts`: `arch.no-cycles` gates on `includeTypeOnly` (RUNTIME_KINDS by
 * default), the EXTERNAL arms of `no-dependency`/`layers` gate on the selector's `includeTypeOnly`,
 * and the INTERNAL arms of both iterate `graph.edges` with no `edge.kind` filter at all. Three of
 * four arms had the option; the fourth was the one the user met.
 *
 * **The default is kept, and the reporter agrees it is arguably right**: a type-only import is still
 * a compile-time coupling across an architectural boundary, and `import type` erasing at runtime
 * does not make the dependency go away in the source. So the defect is the ASYMMETRY and the
 * SILENCE, not the strictness. Type-only edges still violate layering by default; there is now an
 * opt-out for authors who disagree, and the message says which kind of edge it caught.
 *
 * No fingerprint impact: the no-dependency/layers ids are computed over rule id, endpoints and
 * specifier — never the edge kind or the rule's options — so neither the message nor the new option
 * re-identifies an accepted violation.
 */

const COMPONENTS = {
  [toComponentName('ui')]: { name: 'ui', selector: { kind: 'glob' as const, patterns: ['src/ui/**'] }, empty: 'fail' as const },
  [toComponentName('core')]: { name: 'core', selector: { kind: 'glob' as const, patterns: ['src/core/**'] }, empty: 'fail' as const },
};

const typeOnlyGraph = () =>
  graph(
    [node('src/ui/a.ts', 'ui'), node('src/core/b.ts', 'core')],
    [edge('src/ui/a.ts', 'src/core/b.ts', { kind: 'type-only' })],
  );

const noDep = (over: Partial<ArchNoDependencyRule> = {}): ArchNoDependencyRule =>
  ({ kind: 'arch.no-dependency', id: 'r1', from: 'ui', to: 'core', provenance: {}, ...over }) as ArchNoDependencyRule;

const layers = (over: Partial<ArchLayersRule> = {}): ArchLayersRule =>
  ({ kind: 'arch.layers', id: 'r2', layers: [{ layer: 'ui', canDependOn: [] }], provenance: {}, ...over }) as ArchLayersRule;

describe('a type-only edge is reported as type-only [D056]', () => {
  it('no-dependency names the edge kind in its message', () => {
    const v = evaluateNoDependency(noDep(), typeOnlyGraph(), COMPONENTS)[0];

    expect(v).toBeDefined();
    // Before the fix the message was identical to a runtime import's, so a user comparing it against
    // a green `no-cycles` on the same edge had nothing to go on.
    expect(renderViolationMessage(v!)).toMatch(/type-only/);
  });

  it('layers names it too — the arm the reporter actually met', () => {
    const v = evaluateLayers(layers(), typeOnlyGraph(), COMPONENTS)[0];

    expect(v).toBeDefined();
    expect(renderViolationMessage(v!)).toMatch(/type-only/);
  });

  it('a runtime import message is unchanged [S-04]', () => {
    // Calibration: the overwhelming majority of edges are runtime imports and their message must not
    // acquire noise about a distinction that does not apply to them.
    const g = graph([node('src/ui/a.ts', 'ui'), node('src/core/b.ts', 'core')], [edge('src/ui/a.ts', 'src/core/b.ts')]);

    expect(renderViolationMessage(evaluateNoDependency(noDep(), g, COMPONENTS)[0]!)).not.toMatch(/type-only/);
  });
});

describe('the internal arms accept includeTypeOnly, like the other three [D056]', () => {
  it('no-dependency can opt out of type-only edges', () => {
    expect(evaluateNoDependency(noDep({ includeTypeOnly: false }), typeOnlyGraph(), COMPONENTS)).toHaveLength(0);
  });

  it('layers can opt out too', () => {
    expect(evaluateLayers(layers({ includeTypeOnly: false }), typeOnlyGraph(), COMPONENTS)).toHaveLength(0);
  });

  it('the DEFAULT still counts type-only edges — no silent weakening [S-04]', () => {
    // The assertion that protects every existing ruleset. Flipping this default to match no-cycles
    // would silently stop enforcing layering across type-only edges in every repository using align,
    // and would look like a fix rather than a weakening.
    expect(evaluateNoDependency(noDep(), typeOnlyGraph(), COMPONENTS)).toHaveLength(1);
    expect(evaluateLayers(layers(), typeOnlyGraph(), COMPONENTS)).toHaveLength(1);
  });

  it('no-cycles keeps its own opposite default [S-04]', () => {
    // The other half of the asymmetry, pinned so nobody "harmonises" the two defaults later: cycles
    // EXCLUDE type-only by default, and that is what makes `import type` a legitimate cycle fix.
    const cyclic = graph(
      [node('src/ui/a.ts', 'ui'), node('src/core/b.ts', 'core')],
      [edge('src/ui/a.ts', 'src/core/b.ts', { kind: 'type-only' }), edge('src/core/b.ts', 'src/ui/a.ts', { kind: 'type-only' })],
    );
    const rule: ArchNoCyclesRule = { kind: 'arch.no-cycles', id: 'r3', scope: 'repo', includeTypeOnly: false, provenance: {} };

    expect(evaluateNoCycles(rule, cyclic, COMPONENTS)).toHaveLength(0);
  });

  it('the violation id is unaffected by the option [S-04]', () => {
    // Fingerprints are computed over rule id, endpoints and specifier — never the edge kind or the
    // rule's options. Pinned so adding an option can never re-identify an accepted violation.
    const a = evaluateNoDependency(noDep(), typeOnlyGraph(), COMPONENTS)[0]!.id;
    const b = evaluateNoDependency(noDep({ includeTypeOnly: true }), typeOnlyGraph(), COMPONENTS)[0]!.id;

    expect(a).toBe(b);
  });
});
