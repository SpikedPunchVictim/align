import { randomUUID } from 'node:crypto';

/** One session id per CLI process (IMPLEMENTATION_PLAN.md's cross-session-comparability
 * refinement) — generated once here and threaded through every event the process emits, never
 * regenerated mid-process. `randomUUID` is a local, non-network primitive (Node's `node:crypto`),
 * not a call to any external id service. */
export function generateSessionId(): string {
  return randomUUID();
}
