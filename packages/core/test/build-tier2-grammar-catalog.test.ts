import { describe, expect, it } from 'vitest';
import { BULLET_GRAMMAR_FORMS, parseBulletSentence } from '../src/build/tier2.js';

describe('BULLET_GRAMMAR_FORMS (Stage 5 skill catalog — must not drift from parseBulletSentence)', () => {
  it.each(BULLET_GRAMMAR_FORMS)('example for $ruleKind parses to a fragment of that kind', ({ ruleKind, example }) => {
    const fragment = parseBulletSentence(example);
    expect(fragment).toBeDefined();
    expect(fragment?.kind).toBe(ruleKind);
  });

  it('covers every tier-2-authorable rule kind at least once', () => {
    const kinds = new Set(BULLET_GRAMMAR_FORMS.map((f) => f.ruleKind));
    expect(kinds).toEqual(
      new Set(['arch.no-dependency', 'arch.layers', 'arch.no-cycles', 'arch.metric', 'security.manifest.source-hygiene', 'security.manifest.new-dependency']),
    );
  });
});
