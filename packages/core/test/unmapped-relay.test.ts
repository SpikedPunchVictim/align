import { describe, expect, it } from 'vitest';
import { evaluateLayers, evaluateNoDependency } from '../src/rules/evaluators.js';
import { renderViolationMessage } from '../src/types/violation.js';
import { toComponentName } from '../src/types/branded.js';
import { edge, graph, node } from './helpers.js';
import type { ArchLayersRule, ArchNoDependencyRule } from '../src/types/ir.js';

/**
 * LEDGER **D061** — a file in no component launders a forbidden edge, and the verdict stays green.
 *
 * Reported from the field and reproduced on the current build: with `a cannotDependOn b`,
 * `import from '../b'` is correctly RED, and `import from '../shared/relay'` — where
 * `src/shared/relay.ts` is one line, `export * from '../b'`, in a directory matching no selector —
 * is **green**. `align check` says nothing; `doctor` lists the relay file among "N file(s) matched
 * no component selector", giving it the same weight as `align.config.ts`.
 *
 * Mechanism: files matching no selector are still graph NODES, carrying a sentinel component. Every
 * internal rule arm matches `fromNode.component === rule.from && toNode.component === rule.to`, so
 * `a -> relay` (target unmapped) and `relay -> b` (source unmapped) both fail the test and the pair
 * is invisible. Rules are direct-edge only, so ANY unmapped intermediary defeats them.
 *
 * **Severity is about reachability, not just correctness.** This is the first defect in this batch
 * that is trivially discoverable by someone trying to work AROUND a rule — one line, no tooling —
 * and it is reachable by accident: the reporting repository has 523 unmapped files, any of which can
 * relay.
 *
 * **Why contracting unmapped nodes is the principled fix rather than making rules transitive.** A
 * MAPPED intermediary is a component: `a -> c -> b` is not a violation of `a cannotDependOn b`,
 * because `c` is an architectural entity that owns that dependency, and making rules transitive
 * would light up every repository. An UNMAPPED file owns nothing — it is a hole in the component
 * map, not a layer — so a dependency routed through it is still a dependency between the mapped
 * endpoints. Core identifies "unmapped" the way `ungoverned-edges.ts` already does: a component the
 * ruleset never declared, no plugin sentinel required.
 */

const COMPONENTS = {
  [toComponentName('a')]: { name: 'a', selector: { kind: 'glob' as const, patterns: ['src/a/**'] }, empty: 'fail' as const },
  [toComponentName('b')]: { name: 'b', selector: { kind: 'glob' as const, patterns: ['src/b/**'] }, empty: 'fail' as const },
};

/** `src/shared/**` matches no selector, so its node carries a component the ruleset never declared. */
const laundered = () =>
  graph(
    [node('src/a/index.ts', 'a'), node('src/b/index.ts', 'b'), node('src/shared/relay.ts', '__unmapped__')],
    [
      edge('src/a/index.ts', 'src/shared/relay.ts', { specifier: '../shared/relay', line: 1 }),
      edge('src/shared/relay.ts', 'src/b/index.ts', { specifier: '../b', line: 1, kind: 'reexport' }),
    ],
  );

const noDep: ArchNoDependencyRule = { kind: 'arch.no-dependency', id: 'r1', from: 'a', to: 'b', provenance: {} } as ArchNoDependencyRule;
const layers: ArchLayersRule = {
  kind: 'arch.layers', id: 'r2', layers: [{ layer: 'a', canDependOn: [] }], provenance: {},
} as ArchLayersRule;

describe('an unmapped file does not launder a forbidden edge [D061]', () => {
  it('no-dependency sees through the relay', () => {
    const violations = evaluateNoDependency(noDep, laundered(), COMPONENTS);

    // Before the fix: zero, and the verdict was green.
    expect(violations).toHaveLength(1);
    // Reported at the import the author wrote, not inside the relay file they may not own.
    expect(String(violations[0]?.file)).toBe('src/a/index.ts');
  });

  it('the message names the relay, or the report is unactionable', () => {
    // Without this the user is told a imports b via '../shared/relay', which looks like a mistake in
    // align rather than a real path. The relay file is the thing they have to go look at.
    const message = renderViolationMessage(evaluateNoDependency(noDep, laundered(), COMPONENTS)[0]!);

    expect(message).toContain('src/shared/relay.ts');
    expect(message).toMatch(/no component|unmapped/i);
  });

  it('layers was never vulnerable to this, and the reason matters [S-05]', () => {
    // This passed BEFORE the fix, and asserting it as "layers sees through the relay too" would have
    // been a test passing for the wrong reason. `canOnlyDependOn` is an ALLOWLIST: an edge to an
    // unmapped file is already outside it and already a violation, so nothing is laundered. The hole
    // is specific to `cannotDependOn`, which is target-specific and therefore misses a target it was
    // never pointed at. Pinned so nobody "fixes" layers to match.
    expect(evaluateLayers(layers, laundered(), COMPONENTS)).toHaveLength(1);
    const v = evaluateLayers(layers, laundered(), COMPONENTS)[0];
    expect(v?.kind).toBe('layers');
    if (v?.kind === 'layers') expect(String(v.toFile)).toBe('src/shared/relay.ts');
  });

  it('a MAPPED intermediary is still not a violation [S-04]', () => {
    // The calibration that keeps this from becoming "rules are transitive". `c` is a declared
    // component, so it owns its dependency on b; `a -> c -> b` has never violated
    // `a cannotDependOn b` and must not start.
    const withC = {
      ...COMPONENTS,
      [toComponentName('c')]: { name: 'c', selector: { kind: 'glob' as const, patterns: ['src/c/**'] }, empty: 'fail' as const },
    };
    const g = graph(
      [node('src/a/index.ts', 'a'), node('src/b/index.ts', 'b'), node('src/c/mid.ts', 'c')],
      [edge('src/a/index.ts', 'src/c/mid.ts'), edge('src/c/mid.ts', 'src/b/index.ts')],
    );

    expect(evaluateNoDependency(noDep, g, withC)).toHaveLength(0);
  });

  it('a direct violation keeps its exact fingerprint — no baseline churn [S-04]', () => {
    // Contracting unmapped nodes must not re-identify anything already accepted. For a direct edge
    // the resolved target IS `edge.to`, so the fingerprint inputs are unchanged by construction;
    // pinned as an exact id so a future change to what enters the fingerprint fails here.
    const direct = graph(
      [node('src/a/index.ts', 'a'), node('src/b/index.ts', 'b')],
      [edge('src/a/index.ts', 'src/b/index.ts', { specifier: '../b', line: 1 })],
    );

    // Measured identical in BOTH runs — before the fix and after it. That is the assertion, not the
    // literal: contraction computes the fingerprint over the RESOLVED target, and for a direct edge
    // the resolved target IS `edge.to`, so the inputs cannot have changed.
    expect(evaluateNoDependency(noDep, direct, COMPONENTS)[0]?.id).toBe('fb779ee46113af78');
  });

  it('a relay chain through two unmapped files still resolves', () => {
    const g = graph(
      [
        node('src/a/index.ts', 'a'), node('src/b/index.ts', 'b'),
        node('src/shared/one.ts', '__unmapped__'), node('src/shared/two.ts', '__unmapped__'),
      ],
      [
        edge('src/a/index.ts', 'src/shared/one.ts'),
        edge('src/shared/one.ts', 'src/shared/two.ts'),
        edge('src/shared/two.ts', 'src/b/index.ts'),
      ],
    );

    expect(evaluateNoDependency(noDep, g, COMPONENTS)).toHaveLength(1);
  });

  it('a cycle among unmapped files terminates', () => {
    // Contraction walks a subgraph the author does not control; an unmapped cycle must not hang.
    const g = graph(
      [node('src/a/index.ts', 'a'), node('src/shared/x.ts', '__unmapped__'), node('src/shared/y.ts', '__unmapped__')],
      [
        edge('src/a/index.ts', 'src/shared/x.ts'),
        edge('src/shared/x.ts', 'src/shared/y.ts'),
        edge('src/shared/y.ts', 'src/shared/x.ts'),
      ],
    );

    expect(evaluateNoDependency(noDep, g, COMPONENTS)).toHaveLength(0);
  });
});
