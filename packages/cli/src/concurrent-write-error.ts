/**
 * Raised when a `.align/` write could not proceed because another align process was writing, or had
 * written, the same file. Distinguished from every other error by TYPE rather than by message text,
 * because two callers need to treat it completely differently and matching on prose would rot.
 *
 * **Why this class exists at all.** ADR 030's first version let both refusals — the lock timeout and
 * the baseline token mismatch — escape as plain `Error`s. `align check` catches everything from
 * `persistMovedBaseline` and routes it to `reportCliError`, which exits 1 *before any check results
 * are printed*. So a concurrent align turned a green repository into a failed `check` showing only
 * an error line, indistinguishable in CI from a real violation. Found by adversarial review.
 *
 * That is wrong specifically for `check`, and the codebase already said so: `commands/baseline.ts`
 * notes that deferring a move-transfer loses nothing, because "`align check`'s
 * `persistMovedBaseline` independently transfers the same moves, unconditionally, on every run."
 * The transfer is re-derived next run; the verdict this run does not depend on it, since the
 * in-memory store already applied it. For a command whose PURPOSE is the write (`baseline
 * accept`/`prune`, `init`), the same condition must still fail loudly — nothing was recorded.
 */
export class ConcurrentAlignWriteError extends Error {
  readonly kind = 'concurrent-align-write';

  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentAlignWriteError';
  }
}

/** Type guard usable across module instances — an `instanceof` check can fail when a package is
 * loaded twice (two copies of align-cli in one node_modules tree), and this failure mode would
 * silently restore the exact bug the class exists to fix. */
export function isConcurrentAlignWriteError(err: unknown): boolean {
  return err instanceof ConcurrentAlignWriteError || (typeof err === 'object' && err !== null && (err as { kind?: unknown }).kind === 'concurrent-align-write');
}
