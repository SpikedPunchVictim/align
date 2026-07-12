/**
 * Compile-time-only check (not a vitest test — vitest never imports this file; `pnpm typecheck`
 * / `tsc --noEmit` is the verifier). If a component key collides with a reserved factory name and
 * `NoReservedComponentKeys` stops working, the `@ts-expect-error` directive below becomes unused,
 * which `tsc` reports as an error under default settings — so this file fails to typecheck
 * exactly when the guard it's testing has regressed.
 */
import { defineProject } from './index.js';

// @ts-expect-error — 'arch' collides with the reserved `c.arch` factory name (ADR 002).
defineProject({ components: { arch: 'packages/oops/**' } });

// @ts-expect-error — 'security' collides with the reserved `c.security` factory name (ADR 013:
// `c.security.manifest.*` is now a real factory, not just a reserved name).
defineProject({ components: { security: 'packages/oops/**' } });

// A non-colliding key must NOT error.
defineProject({ components: { api: 'packages/api/**' } });
