import { defineProject } from '@align/core/dsl';

export default defineProject({
  components: { api: 'src/api/**', ui: 'src/ui/**' },
  rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui).because('The API must remain headless.')],
});
