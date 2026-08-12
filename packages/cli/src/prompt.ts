import * as readline from 'node:readline/promises';

/**
 * The one real interactive yes/no prompt shared by every command whose consent contract is
 * "default no, silence is never consent" (ADR 006) — `align upgrade`'s prune/accept/transform
 * questions (`commands/upgrade.ts`) and `align init`'s baseline-seed question (`commands/init.ts`).
 * Extracted here rather than left as two copies (one per command) because it was, verbatim, the
 * same three lines in both places: `readline`-backed, `[y/N] ` suffixed, `/^y(es)?$/i` accepted —
 * a single fact ("what does 'ask the user yes/no, defaulting to no' mean in this CLI") that both
 * commands must never be allowed to drift apart on (CODING_BEST_PRACTICES.md §26: DRY the things
 * that must change together).
 *
 * Deliberately NOT reused by `init/npm-script.ts`'s `offerAlignScript` prompt: that one is `[Y/n]`
 * with default YES (an additive, low-risk convenience opt-OUT, not an opt-in), a genuinely
 * different consent contract — unifying it here would silently flip its default.
 *
 * `question` should NOT include its own `[y/N] ` suffix — this function appends it, so a caller
 * that also appends one will read `[y/N] [y/N] ` at the prompt.
 */
export async function defaultConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
