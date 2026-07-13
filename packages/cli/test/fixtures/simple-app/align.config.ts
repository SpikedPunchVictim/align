import { defineProject } from '@spikedpunch/align-core/dsl';

export default defineProject({
  components: { app: 'src/**' },
  rules: (c) => [c.arch.noCycles()],
});
