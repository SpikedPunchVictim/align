/**
 * `align init`'s npm-script offer: add a single `"align": "align check"` script to the target
 * repo's package.json. Idempotent (mirrors `claude-md.ts`/`gitignore.ts`'s idempotent-write
 * discipline) — a package.json that already declares an `align` script, whatever it runs, is left
 * completely untouched.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';

const ALIGN_SCRIPT_NAME = 'align';
const ALIGN_SCRIPT_COMMAND = 'align check';

export type AddAlignScriptResult =
  | { readonly changed: true; readonly packageJson: Record<string, unknown> }
  | { readonly changed: false; readonly packageJson: Record<string, unknown>; readonly reason: 'already-present' };

/**
 * Pure: adds `"align": "align check"` to `packageJson.scripts` unless a script named `align`
 * already exists (any command — never overwritten). Every other field, including the rest of
 * `scripts`, is preserved unchanged.
 */
export function addAlignScript(packageJson: Record<string, unknown>): AddAlignScriptResult {
  const scripts = (packageJson.scripts as Record<string, string> | undefined) ?? {};
  if (Object.prototype.hasOwnProperty.call(scripts, ALIGN_SCRIPT_NAME)) {
    return { changed: false, packageJson, reason: 'already-present' };
  }
  const nextScripts = { ...scripts, [ALIGN_SCRIPT_NAME]: ALIGN_SCRIPT_COMMAND };
  return { changed: true, packageJson: { ...packageJson, scripts: nextScripts } };
}

export interface OfferAlignScriptOptions {
  /** Skip entirely — no prompt, no write. */
  readonly noScripts?: boolean;
  /** Answer yes without prompting, even when interactive. */
  readonly yes?: boolean;
}

/**
 * The imperative shell: reads the target repo's package.json (no-ops silently if there isn't
 * one — `align init` doesn't require one to exist), decides whether to prompt (interactive, no
 * `--yes`) or default straight to yes (`--yes` or non-interactive — silence defaults to ADDING
 * this one, low-risk, purely-additive script, unlike baseline seeding's "silence is never
 * consent" doctrine), and writes the result via `addAlignScript` above.
 */
export async function offerAlignScript(rootDir: string, isInteractive: boolean, options: OfferAlignScriptOptions): Promise<void> {
  if (options.noScripts === true) return;

  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  const packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  const existingScripts = (packageJson.scripts as Record<string, string> | undefined) ?? {};
  if (Object.prototype.hasOwnProperty.call(existingScripts, ALIGN_SCRIPT_NAME)) {
    console.log(`package.json already has an "${ALIGN_SCRIPT_NAME}" script — leaving it untouched.`);
    return;
  }

  let shouldAdd = options.yes === true || !isInteractive;
  if (isInteractive && options.yes !== true) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Add an "${ALIGN_SCRIPT_NAME}": "${ALIGN_SCRIPT_COMMAND}" script to package.json? [Y/n] `);
    rl.close();
    shouldAdd = !/^n(o)?$/i.test(answer.trim());
  }

  if (!shouldAdd) {
    console.log(`Not adding the "${ALIGN_SCRIPT_NAME}" npm script.`);
    return;
  }

  const result = addAlignScript(packageJson);
  if (result.changed) {
    fs.writeFileSync(pkgPath, `${JSON.stringify(result.packageJson, null, 2)}\n`, 'utf8');
    console.log(`Added "${ALIGN_SCRIPT_NAME}": "${ALIGN_SCRIPT_COMMAND}" script to package.json.`);
  }
}
