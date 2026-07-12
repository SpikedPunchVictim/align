import { defineProject } from '@align/core/dsl';

export default defineProject({
  components: { app: 'src/**' },
  rules: (c) => [c.arch.component(c.app).maxLinesPerFile(5).because('Files should stay small and focused.')],
});
