/**
 * Pure argv parsing — no `process.argv`/`process.exit` here (those belong to `index.ts`'s
 * imperative shell). `create-align` recognizes exactly two flags of its own (`--yes`/`-y`,
 * `--pm <pnpm|npm|yarn>`); everything else is forwarded VERBATIM to `align init` (the pass-through
 * contract: `--greenfield`, `--accept-existing`, and `--yes` itself all flow through unchanged —
 * `align init` gained its own `-y, --yes` flag for exactly this handoff, see
 * `packages/cli/src/commands/init.ts`).
 */
import type { PackageManager } from './packageManager.js';

export interface ParsedCreateAlignArgs {
  readonly yes: boolean;
  readonly pm?: PackageManager;
  /** Flags forwarded verbatim to `align init` — never reimplemented here (rule of three: install
   * logic lives only in create-align, scaffolding logic only in init). */
  readonly passthrough: readonly string[];
}

export type ParseArgsResult = { readonly ok: true; readonly args: ParsedCreateAlignArgs } | { readonly ok: false; readonly error: string };

const VALID_PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn']);

function isValidPackageManager(value: string): value is PackageManager {
  return VALID_PACKAGE_MANAGERS.has(value);
}

export function parseCreateAlignArgs(argv: readonly string[]): ParseArgsResult {
  let yes = false;
  let pm: PackageManager | undefined;
  const passthrough: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--yes' || arg === '-y') {
      yes = true;
      passthrough.push(arg); // also forwarded — align init's own --yes governs its script offer
      continue;
    }

    if (arg === '--pm') {
      const value = argv[i + 1];
      if (value === undefined || !isValidPackageManager(value)) {
        return { ok: false, error: '--pm requires one of: pnpm, npm, yarn' };
      }
      pm = value;
      i += 1;
      continue;
    }

    if (arg?.startsWith('--pm=')) {
      const value = arg.slice('--pm='.length);
      if (!isValidPackageManager(value)) {
        return { ok: false, error: '--pm requires one of: pnpm, npm, yarn' };
      }
      pm = value;
      continue;
    }

    if (arg !== undefined) passthrough.push(arg);
  }

  return { ok: true, args: { yes, ...(pm !== undefined ? { pm } : {}), passthrough } };
}
