import { defineProject, external } from '@spikedpunch/align-core/dsl';

// ADR 017 Part A portability fixture: an external-selector rule is IR-only (a glob pattern
// matched against graph.externalEdges, no host code) — this proves it evaluates correctly under
// `align check --untrusted`, where `align.config.ts` (this very file) is never imported.
export default defineProject({
  components: { app: 'src/**' },
  rules: (c) => [c.arch.layer(c.app).cannotDependOn(external('node:child_process'))],
});
