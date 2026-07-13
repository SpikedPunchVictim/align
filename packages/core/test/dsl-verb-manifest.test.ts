import { describe, expect, it } from 'vitest';
import { describeDslVerbs } from '../src/dsl/verb-manifest.js';

describe('describeDslVerbs (Stage 5 verb manifest — single source of truth for `align skill`)', () => {
  it('returns a non-empty, fully-described verb table without throwing', () => {
    const verbs = describeDslVerbs();
    expect(verbs.length).toBeGreaterThan(0);
    for (const verb of verbs) {
      expect(verb.description.length).toBeGreaterThan(0);
      expect(verb.producesRuleKind.length).toBeGreaterThan(0);
    }
  });

  it('covers every verb currently on the live builder surface (arch, custom, security.manifest)', () => {
    const paths = describeDslVerbs().map((v) => v.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        expect.stringContaining('arch.layer(x).canOnlyDependOn'),
        expect.stringContaining('arch.layer(x).cannotDependOn'),
        expect.stringContaining('arch.component(x).isIsolated'),
        expect.stringContaining('arch.component(x).maxLinesPerFile'),
        expect.stringContaining('arch.noCycles'),
        expect.stringContaining('custom.host'),
        expect.stringContaining('security.manifest.sourceHygiene'),
        expect.stringContaining('security.manifest.newDependencyGate'),
      ]),
    );
  });
});
