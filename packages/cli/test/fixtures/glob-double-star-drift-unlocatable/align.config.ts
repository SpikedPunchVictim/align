import { defineProject } from '@spikedpunch/align-core/dsl';

// The effective pattern is `app/**/model.ts` (identical drift to the `glob-double-star-drift`
// fixture), but it is COMPUTED via template interpolation rather than a plain quoted literal — the
// exact text `app/**/model.ts` never appears verbatim, quoted, anywhere in this file. Exists to
// drive the transform's "cannot locate the literal" refusal.
const base = 'app';
export default defineProject({
  components: { app: `${base}/**/model.ts` },
  rules: (c) => [c.arch.noCycles()],
});
