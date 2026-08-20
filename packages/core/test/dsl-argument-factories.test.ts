import { describe, expect, it } from 'vitest';
import * as dsl from '../src/dsl/index.js';
import { describeDslVerbs } from '../src/dsl/verb-manifest.js';

/**
 * LEDGER **D057** — `external()` is fully implemented, works, and appears in ZERO shipped guidance.
 *
 * Measured 2026-08-20, `external(` occurrences: `align skill --topic authoring` 0,
 * `--topic all` 0, `align docs config` 0, `docs verbs` 0, `docs rules` 0. The verb table described
 * `cannotDependOn(...refs)` as taking "the listed components", actively implying external targets
 * are impossible.
 *
 * The cost, in the reporter's words: their brief was literally "the chrome extension cannot import
 * node modules". They read `align skill --topic authoring` in full, found nothing, and wrote a
 * ~60-line `custom.host` predicate over `externalNodes`/`externalEdges` instead of
 * `cannotDependOn(external('node:*'))`. The feature was builtin-aware and worked perfectly the whole
 * time.
 *
 * **The blind spot is the durable half.** `verb-manifest.ts` guarantees guidance completeness by
 * introspecting the live builder objects — `Object.keys(arch.layer(x))` and friends. `external()` is
 * a standalone export used as an ARGUMENT, so it is structurally outside what method introspection
 * can see. The invariant that exists to stop exactly this drift could not see the one piece of
 * surface that drifted [S-13]: the guard's blind spot is the defect's habitat.
 *
 * This test closes it by asking a different question — not "does every builder METHOD have a
 * description?" but "does every CALLABLE a user can import from `@spikedpunch/align-core/dsl` have
 * one?" That is the actual public surface: anything importable from the DSL entrypoint can appear in
 * a config, and anything that can appear in a config needs to be findable in guidance.
 */

/**
 * Callables a user can import from the DSL entrypoint that are NOT authoring surface, each with the
 * reason. A new export lands in the failure below until someone classifies it — which is the point:
 * `external()` shipped for months because nothing forced that decision.
 */
const NOT_AUTHORING_SURFACE = new Map<string, string>([
  ['defineProject', 'the entry point itself — every config calls it, and it is documented as the thing you call, not as a verb'],
  ['makeArchFactory', 'internal constructor for the `c.arch` builder; users receive the built object, never call this'],
  ['makeCustomFactory', 'internal constructor for the `c.custom` builder, same as makeArchFactory'],
  ['makeSecurityFactory', 'internal constructor for the `c.security` builder, same as makeArchFactory'],
  ['describeDslVerbs', 'the manifest reader itself — tooling surface consumed by `align skill`/`align docs`, not config surface'],
  ['ruleBuilder', 'the `.because(...)` wrapper every verb returns; a user calls the VERB and chains onto its result, never constructs one'],
]);

function exportedCallables(): string[] {
  return Object.entries(dsl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
}

describe('every DSL callable is discoverable in guidance [D057]', () => {
  it('classifies every callable exported from @spikedpunch/align-core/dsl', () => {
    const callables = exportedCallables();

    // PREMISE [S-05]: if the namespace import stops yielding functions, everything below passes
    // vacuously and this file becomes a green that measures nothing.
    expect(callables.length).toBeGreaterThanOrEqual(5);

    const describedPaths = describeDslVerbs().map((v) => v.path);
    const unclassified = callables.filter(
      (name) => !NOT_AUTHORING_SURFACE.has(name) && !describedPaths.some((p) => p.includes(`${name}(`)),
    );

    // If this fails: you added something a user can import and call in align.config.ts, and it
    // appears in no guidance. Either add it to VERB_DESCRIPTIONS so `align skill`/`align docs`
    // teach it, or add it above WITH the reason it is not authoring surface. Do not delete this
    // test — `external()` shipped fully working and completely undocumented because method
    // introspection structurally could not see an argument factory.
    expect(unclassified).toEqual([]);
  });

  it('external() specifically is described, since that is the one that got missed', () => {
    const described = describeDslVerbs().map((v) => `${v.path} ${v.description}`).join('\n');

    expect(described).toMatch(/external\(/);
    // The thing the reporter needed and could not find: that it takes a PATTERN and covers builtins.
    expect(described).toMatch(/node:\*|builtin/i);
  });

  it('every exemption carries a real reason, so the register stays a decision record', () => {
    for (const [name, reason] of NOT_AUTHORING_SURFACE) {
      expect(reason.length, `${name} needs a real reason, not a placeholder`).toBeGreaterThan(30);
    }
  });

  it('no stale exemption — a name that is no longer exported must not linger', () => {
    const callables = new Set(exportedCallables());
    const stale = [...NOT_AUTHORING_SURFACE.keys()].filter((n) => !callables.has(n));

    expect(stale).toEqual([]);
  });
});
