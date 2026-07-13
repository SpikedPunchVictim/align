import { generateSessionId } from './session.js';

/** Single source of truth for the CLI's own version — `program.ts`'s `.version(...)` call imports
 * this too, so there is exactly one place to bump on a release, not two literals that can drift. */
export const ALIGN_VERSION = '0.1.0';

/** Computed once, at module load — ESM caches a module instance per process, so every command
 * within one `align` invocation that imports this sees the identical id (IMPLEMENTATION_PLAN.md:
 * "sessionId injected, CLI generates one per process"). Never regenerated mid-process, never read
 * from anywhere network-facing (`node:crypto`'s local `randomUUID`, `session.ts`). */
export const TELEMETRY_SESSION_ID = generateSessionId();
