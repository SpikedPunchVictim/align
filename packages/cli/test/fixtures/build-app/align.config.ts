import { defineProject } from '@spikedpunch/align-core/dsl';

// No architecture rules authored here on purpose — this fixture's rules come entirely from
// `align build` compiling docs/ARCHITECTURE-RULES.md (ADR 011 build-pipeline tests).
export default defineProject({
  components: { api: 'src/api/**', ui: 'src/ui/**' },
});
