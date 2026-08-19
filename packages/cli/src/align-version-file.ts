import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { withAlignDirLock } from './align-lock.js';
import { writeFileAtomic } from './fs-atomic.js';
import { ALIGN_VERSION } from './telemetry/process-context.js';
import { versionFileSchema, type VersionFile } from './version-file.js';

/**
 * Where `.align/` is, and the one artifact in it that records WHO wrote and WHO reconciled.
 *
 * Split out of `align-dir.ts` on 2026-08-19, when putting this file's read-modify-write under the
 * lock (LEDGER D031) pushed that module past align's own 500-line limit — dogfooding picking the seam.
 * It is a good seam independently: everything here concerns `.align/version.json` plus the directory
 * helpers it needs, it depends on no other artifact, and the dependency therefore runs ONE way
 * (`align-dir.ts` imports this; this imports nothing back), so there is no cycle for `align check` to
 * find and none for a reader to hold in their head.
 */

export const ALIGN_DIR = '.align';
const VERSION_FILENAME = 'version.json';

export function alignDirPath(rootDir: string): string {
  return path.join(rootDir, ALIGN_DIR);
}

/**
 * The missing sibling of the `JSON.parse` catch at each of this file's three artifact readers
 * (`readBaseline`, `readGeneratedRules`, `readRulesetIr`): all three already turn a JSON-syntax
 * error into align-authored prose naming the file, but until now all three let a *schema*-invalid
 * (valid JSON, wrong shape) artifact throw zod's raw `ZodError` straight through — an issue array
 * with no file name and no framing, inconsistent with the JSON.parse catch two lines above it at
 * every one of these call sites (bug hunt 2026-08-03, noted alongside BUG #14 but not folded into
 * its fix). `safeParse` instead of `parse` so the failure is a normal return value to format here,
 * not a second exception type callers would need to distinguish from the JSON.parse one.
 */
export function parseArtifact<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, parsed: unknown, file: string, shapeDescription: string): T {
  const result = schema.safeParse(parsed);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `  ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`${file} does not match the expected shape (${shapeDescription}):\n${issues}`);
}

export function ensureAlignDir(rootDir: string): void {
  fs.mkdirSync(alignDirPath(rootDir), { recursive: true });
}

export function versionFilePath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), VERSION_FILENAME);
}

/**
 * Reads and zod-validates `.align/version.json` (ADR 022). Absence is a legitimate state — every
 * install created before 0.2.0, and even a fresh 0.2.0+ repo before its first `.align/`-writing
 * command, has no stamp — and returns `undefined`, never an error: "unknown, predates stamping" is
 * a normal thing for this file to say. A file that EXISTS but fails to parse as JSON or fails
 * schema validation throws — the same corrupt-≠-absent discipline as `readBaseline`/
 * `readGeneratedRules`/`readRulesetIr` above, naming the file in the thrown message. This function
 * backs both the `align check` provenance advisory (`version-skew.ts`) and the internal
 * read-merge-write inside `stampAlignVersion`/`recordBaselineReconciled` below — one reader, not two that
 * could drift on what "corrupt" means.
 */
export function readVersionFile(rootDir: string): VersionFile | undefined {
  const file = versionFilePath(rootDir);
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseArtifact<VersionFile>(versionFileSchema, parsed, file, '{ alignVersion, baselineReconciledBy? }');
}

export function writeVersionFile(rootDir: string, data: VersionFile): void {
  ensureAlignDir(rootDir);
  writeFileAtomic(versionFilePath(rootDir), `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * The single choke point for `alignVersion` stamping (ADR 022's write discipline). Called from
 * every COMMITTED `.align/` artifact writer, all four of which are in THIS file — `writeBaseline`,
 * `writeGeneratedRules`, `writeRulesLock`, `writeRulesetIr` (the module doc comment above lists the
 * machine-local files that live elsewhere and why they are exempt). Piggybacking the stamp on those
 * four writers, instead of
 * calling it separately at each of `init`, `build --apply`, `export-ir`, `baseline accept`/`prune`,
 * and `check`'s move-transfer path, makes the coverage argument STRUCTURAL rather than
 * enumerative: a new command that writes an `.align/` artifact has to call one of these functions
 * (or add a fifth writer here, which should call this too) — there is no way to write an artifact
 * through this module without also stamping. This is the pattern `withVersionSkew`
 * (`version-skew.ts`) and `refuseIfRunErrored`/`refuseIfRunIncomplete` (`errored-run.ts`) already
 * establish: one shared function, never a copy re-inlined at a new call site.
 *
 * Deliberately never touches `baselineReconciledBy` — see `recordBaselineReconciled` below for why that
 * field has exactly one writer (`init`) plus, later, `align upgrade`.
 *
 * Deliberately NOT wired into `writeTelemetryState`/`appendTelemetryLine`, nor into
 * `writeLastScanRecord` (ADR 029): all three are opt-in-or-derived, machine-local, gitignored, and
 * explicitly not portable artifacts (see those functions' own doc comments) — they are outside the
 * ".align/ artifact" set ADR 022 stamps. The structural argument above is therefore "every writer of
 * a COMMITTED artifact stamps", not "every writer in this file stamps"; a new writer has to place
 * itself in one of the two sets deliberately.
 *
 * A read-only `align check` never calls any of the four writers above (the only stamping writer
 * `check` ever touches is `writeBaseline`, and only on the move-transfer path —
 * `persistMovedBaseline`, `commands/check.ts`), so this function is never reached on a plain check —
 * `.align/version.json` is correctly never created by a check that doesn't mutate anything. Since
 * ADR 029 a plain check DOES write `.align/last-scan.json`, which is why that writer is in the
 * exempt set: a check that changed nothing must not start claiming a version stamp it didn't earn.
 */
export function stampAlignVersion(rootDir: string): void {
  withVersionFileLock(rootDir, () => {
    const current = readVersionFile(rootDir);
    writeVersionFile(rootDir, { ...current, alignVersion: ALIGN_VERSION });
  });
}

/** `.align/version.json`'s read-modify-write, under `baseline.json`'s lock (LEDGER D031 — full
 * reasoning there and in ADR 030's amendment). A lock and NO token, unlike `writeBaseline`: its token
 * exists because the read happens in the caller a full scan earlier, whereas these two statements are
 * adjacent, so the lock closes the window and a token would guard an impossible race [S-06].
 * Re-entrant by construction — `stampAlignVersion` runs inside `writeBaseline`'s lock, and
 * `withAlignDirLock` recognises one this process already holds. */
export function withVersionFileLock(rootDir: string, fn: () => void): void {
  ensureAlignDir(rootDir);
  withAlignDirLock(alignDirPath(rootDir), 'writeVersionFile', fn);
}

/**
 * Records that `.align/baseline.json` has been deliberately reconciled against a check under the
 * RUNNING align version (ADR 022) — the operation both writers below share, which is why this
 * function (originally named `seedVersionStamp`, for `init`'s sole use) was renamed once `align
 * upgrade` became its second caller: "seed" no longer described what `upgrade` does to an
 * already-`.align/`-having repo. Not `check`, not `accept`, not `prune`: those write through
 * `stampAlignVersion` above, which deliberately never touches this field. `baselineReconciledBy`
 * answers "has this baseline been reconciled under the running version?", not "who last wrote
 * baseline.json" — an incidental writer (a move-transfer, a scoped accept) must not be able to
 * advance it, which is the entire point of restricting it to these two call sites.
 *
 * **`align init`** calls this unconditionally at the end of every run — including a re-run against
 * a repo that already has `.align/` — because every `init` run re-establishes the baseline from a
 * fresh check (`runInit` always ends by writing `.align/baseline.json`, seeded or empty); that IS
 * the "deliberate reconciliation" this field exists to record.
 *
 * **`align upgrade`** (`commands/upgrade.ts`) calls this LAST — after explicit consent AND after
 * the reconciliation (prune + re-accept + any transforms) has actually completed — never before,
 * and never on a partial consent (ADR 022's three rules for this field; see `runUpgrade`'s own doc
 * comment for how it enforces the ordering and the partial-consent case).
 */
export function recordBaselineReconciled(rootDir: string): void {
  withVersionFileLock(rootDir, () => {
    const current = readVersionFile(rootDir);
    writeVersionFile(rootDir, { ...current, alignVersion: ALIGN_VERSION, baselineReconciledBy: ALIGN_VERSION });
  });
}
