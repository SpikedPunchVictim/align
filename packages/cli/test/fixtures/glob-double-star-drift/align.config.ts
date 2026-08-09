import { defineProject } from '@spikedpunch/align-core/dsl';

// `app/**/model.ts` is the exact pattern shape from commit 6d6c9c1's own bug report: under the
// pre-0.2.0 semantics an interior `**` crossed `/` boundaries, so this pattern also matched
// `app/datamodel.ts` (no path-segment boundary at all). Under the current whole-segment semantics
// it does not — `app/sub/model.ts` is the only real match. This fixture exists to drive
// `glob-double-star-drift.ts`'s validator against a real repo scan.
export default defineProject({
  components: { app: 'app/**/model.ts' },
  rules: (c) => [c.arch.noCycles()],
});
