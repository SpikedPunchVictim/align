import { defineProject } from '@spikedpunch/align-core/dsl';

// The SAME literal pattern, quoted twice — once per component. Exists to drive the transform's
// "ambiguous quoted literal" refusal: `align.config.ts` source text contains
// 'app/**/model.ts' more than once, so the transform cannot tell which occurrence to rewrite and
// must refuse rather than guess.
export default defineProject({
  components: { app: 'app/**/model.ts', app2: 'app/**/model.ts' },
  rules: (c) => [c.arch.noCycles()],
});
