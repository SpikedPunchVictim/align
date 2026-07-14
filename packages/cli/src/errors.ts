/**
 * Friendly, actionable error mapping for `align.config.ts`'s own `import ... from
 * '@spikedpunch/align-core/dsl'` failing to resolve in a target repo that hasn't installed align
 * as a local devDependency yet (the ecosystem norm this repo now follows — see
 * `packages/create-align`). Covers `check`/`doctor`/`mcp`/`init`, all of which funnel through
 * `config.ts`'s `loadConfig`. Never a raw `ERR_MODULE_NOT_FOUND` Node stack trace reaching the
 * user — `index.ts`'s top-level catch renders this error's `.message` cleanly instead.
 */

export class AlignCoreMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlignCoreMissingError';
  }
}

/**
 * Pure: recognizes a dynamic-import failure caused specifically by a target repo missing
 * `@spikedpunch/align-core` and maps it to `AlignCoreMissingError`. Returns `undefined` for any
 * other error so the caller rethrows it unchanged — this must never swallow an unrelated failure
 * (a typo'd `align.config.ts`, a genuine syntax error, etc. still surface as themselves).
 */
export function toAlignCoreMissingError(err: unknown): AlignCoreMissingError | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'ERR_MODULE_NOT_FOUND') return undefined;
  if (!err.message.includes('@spikedpunch/align-core')) return undefined;

  return new AlignCoreMissingError(
    "This repo's align.config.ts imports '@spikedpunch/align-core', but that package isn't " +
      'resolvable here — it needs to be a local devDependency of THIS repo (a transitive or ' +
      "globally-installed align-core isn't enough under a strict node_modules layout). Fix it with " +
      'one of:\n' +
      '  pnpm create @spikedpunch/align        (recommended — installs align-cli + align-core, then runs align init)\n' +
      '  pnpm add -D @spikedpunch/align-core   (then re-run the command you just ran)',
  );
}
