/**
 * Imperative shell around `@spikedpunch/align-core`'s pure `BaselineStore` (CODING_BEST_PRACTICES.md §15/16:
 * functional core, imperative shell) — all filesystem I/O for `.align/` lives here, not in core.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { z } from 'zod';
import {
  baselineFileSchema,
  exportedRulesetSchema,
  generatedRulesFileSchema,
  rulesLockSchema,
  type BaselineEntry,
  type ExportedRuleset,
  type GeneratedRulesFile,
  type RulesLock,
  type TelemetryState,
} from '@spikedpunch/align-core';
import { ALIGN_VERSION } from './telemetry/process-context.js';
import { versionFileSchema, type VersionFile } from './version-file.js';

export const ALIGN_DIR = '.align';
const BASELINE_FILENAME = 'baseline.json';
const GENERATED_RULES_FILENAME = 'generated-rules.json';
const RULES_LOCK_FILENAME = 'rules.lock.json';
const LAST_BUILD_REPORT_FILENAME = 'last-build-report.md';
const VERSION_FILENAME = 'version.json';
// Default location for `align export-ir`'s output / `align check --untrusted`'s input (ADR 014).
// Overridable per-invocation via `align export-ir --out <path>` / `align check --ir <path>`.
const RULESET_IR_FILENAME = 'ruleset-ir.json';
// Telemetry (IMPLEMENTATION_PLAN.md's telemetry Design Reserve entry, ADR 015): append-only, opt-in,
// local-file-only. Both are gitignored by default (align's own .gitignore, and `align init` adds
// the same two entries to the target repo's) — neither is a portable artifact meant to be committed.
const TELEMETRY_JSONL_FILENAME = 'telemetry.jsonl';
const TELEMETRY_STATE_FILENAME = 'telemetry-state.json';

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
function parseArtifact<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, parsed: unknown, file: string, shapeDescription: string): T {
  const result = schema.safeParse(parsed);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `  ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`${file} does not match the expected shape (${shapeDescription}):\n${issues}`);
}

function baselinePath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), BASELINE_FILENAME);
}

export function generatedRulesPath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), GENERATED_RULES_FILENAME);
}

export function rulesLockPath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), RULES_LOCK_FILENAME);
}

export function lastBuildReportPath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), LAST_BUILD_REPORT_FILENAME);
}

export function ensureAlignDir(rootDir: string): void {
  fs.mkdirSync(alignDirPath(rootDir), { recursive: true });
}

function versionFilePath(rootDir: string): string {
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

function writeVersionFile(rootDir: string, data: VersionFile): void {
  ensureAlignDir(rootDir);
  fs.writeFileSync(versionFilePath(rootDir), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * The single choke point for `alignVersion` stamping (ADR 022's write discipline). Called from
 * every `.align/` artifact writer in THIS file — `writeBaseline`, `writeGeneratedRules`,
 * `writeRulesLock`, `writeRulesetIr` — which are already the only places under `.align/` any
 * command in this codebase writes to (this module's own doc comment: "all filesystem I/O for
 * .align/ lives here, not in core"). Piggybacking the stamp on those four writers, instead of
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
 * Deliberately NOT wired into `writeTelemetryState`/`appendTelemetryLine`: telemetry is opt-in,
 * local-only, gitignored by default, and explicitly not a portable artifact (see those two
 * functions' own doc comments below) — it is outside the ".align/ artifact" set ADR 022 stamps.
 *
 * A read-only `align check` never calls any of the four writers above (the ONLY writer `check`
 * ever touches is `writeBaseline`, and only on the move-transfer path — `persistMovedBaseline`,
 * `commands/check.ts`), so this function is never reached on a plain check — `.align/version.json`
 * is correctly never created by a check that doesn't mutate anything.
 */
function stampAlignVersion(rootDir: string): void {
  const current = readVersionFile(rootDir);
  writeVersionFile(rootDir, { ...current, alignVersion: ALIGN_VERSION });
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
  const current = readVersionFile(rootDir);
  writeVersionFile(rootDir, { ...current, alignVersion: ALIGN_VERSION, baselineReconciledBy: ALIGN_VERSION });
}

/**
 * Reads and zod-validates `.align/baseline.json`. A missing file returns `[]` (nothing has been
 * accepted yet), but a file that exists and fails to parse as JSON or fails schema validation
 * throws — a corrupted baseline is never treated as empty (bug hunt 2026-08-03, BUG #1): silently
 * reading it as `[]` would make `align check` report every previously-accepted violation as new
 * with no warning, and the next `align baseline accept` (bare or `--rule`-scoped) would rebuild
 * the store from that empty read and overwrite the file via `writeBaseline`, permanently
 * destroying every entry not visible in that scan. Mirrors `readRulesetIr`'s discipline, not
 * `readTelemetryState`'s — this file holds irreplaceable human consent decisions, not a
 * regenerable cache.
 */
export function readBaseline(rootDir: string): BaselineEntry[] {
  const file = baselinePath(rootDir);
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        'A corrupted baseline is never treated as empty — that would silently discard accepted ' +
        'debt, and the next `align baseline accept` would overwrite the file. Most likely cause: ' +
        'an unresolved git merge conflict. Resolve it, or restore the file from git.',
    );
  }
  // `baselineFileSchema`'s inferred element type is plain strings (fingerprint/ruleId/file); `BaselineEntry`
  // brands those same fields (`ViolationId`/`RuleId`/`RepoRelativePath`). `as BaselineEntry[]` alone doesn't
  // satisfy TS's overlap check across a branded intersection type — the boundary cast goes through `unknown`,
  // same as every other brand-construction site (`types/branded.ts`'s `toXxx` helpers).
  return parseArtifact(
    baselineFileSchema,
    parsed,
    file,
    'an array of baseline entries (fingerprint, ruleId, file, acceptedAt, acceptedBy)',
  ) as unknown as BaselineEntry[];
}

export function writeBaseline(rootDir: string, entries: readonly BaselineEntry[]): void {
  ensureAlignDir(rootDir);
  const sorted = [...entries].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  fs.writeFileSync(baselinePath(rootDir), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  stampAlignVersion(rootDir);
}

/** Raw on-disk bytes of `.align/generated-rules.json`, or `undefined` if absent — used to `.parse()`
 * the file (below). NOT what divergence detection hashes verbatim (a doc comment here asserted that
 * until the 2026-08-12 ADR 011 amendment; it was false — `sha256Hex(rawWritten)` folded
 * `generatedAt: Date.now()` into the hash, so two builds of byte-identical rules produced different
 * hashes, defeating "rebuild and compare." The primary hash (`reproducibleGeneratedRulesHash`,
 * `commands/build-verify.ts`) reconstructs `{ irVersion, docPath, rules }` from the PARSED file
 * instead. These raw bytes now serve only `.parse()` above and, temporarily, the legacy raw-bytes
 * fallback comparison in `checkGeneratedRulesDivergence` (`commands/build-verify.ts`) for
 * lockfiles predating that change — see its doc comment for the removal condition. */
export function readGeneratedRulesRaw(rootDir: string): string | undefined {
  const file = generatedRulesPath(rootDir);
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, 'utf8');
}

/** Parses and zod-validates `.align/generated-rules.json` (ADR 002 parse-don't-validate) — throws
 * a descriptive error on a corrupted/hand-mangled file rather than silently ignoring it, since
 * silently dropping generated rules would be a false-green (a doc-built rule stops being
 * enforced with no signal). */
export function readGeneratedRules(rootDir: string): GeneratedRulesFile | undefined {
  const raw = readGeneratedRulesRaw(rootDir);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${generatedRulesPath(rootDir)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseArtifact<GeneratedRulesFile>(
    generatedRulesFileSchema,
    parsed,
    generatedRulesPath(rootDir),
    '{ irVersion, docPath, generatedAt, rules[] }',
  );
}

/** Returns the exact raw bytes written, so callers can content-hash the same string that will be
 * read back later (`readGeneratedRulesRaw`) — the divergence-detection hash must be computed over
 * identical serialization on both sides of the round-trip. */
export function writeGeneratedRules(rootDir: string, file: GeneratedRulesFile): string {
  ensureAlignDir(rootDir);
  const raw = `${JSON.stringify(file, null, 2)}\n`;
  fs.writeFileSync(generatedRulesPath(rootDir), raw, 'utf8');
  stampAlignVersion(rootDir);
  return raw;
}

export function readRulesLock(rootDir: string): RulesLock | undefined {
  const file = rulesLockPath(rootDir);
  if (!fs.existsSync(file)) return undefined;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  return rulesLockSchema.parse(raw);
}

export function writeRulesLock(rootDir: string, lock: RulesLock): void {
  ensureAlignDir(rootDir);
  fs.writeFileSync(rulesLockPath(rootDir), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  stampAlignVersion(rootDir);
}

export function writeLastBuildReport(rootDir: string, markdown: string): void {
  ensureAlignDir(rootDir);
  fs.writeFileSync(lastBuildReportPath(rootDir), markdown, 'utf8');
}

/** ADR 014's untrusted-mode artifact. Defaults to `.align/ruleset-ir.json`; `align export-ir
 * --out`/`align check --ir` both take an explicit override path (absolute or repo-root-relative)
 * for repos that want to commit it somewhere else or keep more than one exported snapshot. */
export function rulesetIrPath(rootDir: string, override?: string): string {
  if (override !== undefined) return path.isAbsolute(override) ? override : path.join(rootDir, override);
  return path.join(alignDirPath(rootDir), RULESET_IR_FILENAME);
}

/**
 * Reads and zod-validates the exported ruleset (`.align/ruleset-ir.json` by default). Returns
 * `undefined` only when the file doesn't exist — `align check --untrusted`'s caller turns that
 * into a hard refuse-don't-fallback message (ADR 014), never a silent switch to executing
 * align.config.ts. A file that exists but fails to parse as JSON or fails schema validation
 * throws — a corrupted or hand-mangled artifact must never be treated as "absent" (that would
 * silently drop rules, the same false-green class `readGeneratedRules` already guards against).
 */
export function readRulesetIr(rootDir: string, override?: string): ExportedRuleset | undefined {
  const file = rulesetIrPath(rootDir, override);
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseArtifact<ExportedRuleset>(exportedRulesetSchema, parsed, file, '{ irVersion, exportedAt, excludes[], ruleset }');
}

export function writeRulesetIr(rootDir: string, data: ExportedRuleset, override?: string): string {
  const file = rulesetIrPath(rootDir, override);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  // Only stamp when the write actually landed inside THIS repo's `.align/` — `--out` can point
  // anywhere on disk (ADR 021: "a ruleset-ir.json moved out of .align/ via --out carries no
  // provenance", accepted knowingly), including outside this repo entirely. Stamping
  // unconditionally would create/touch `.align/version.json` for a repo whose `.align/` this
  // invocation never actually wrote to.
  if (file.startsWith(`${alignDirPath(rootDir)}${path.sep}`) || file === alignDirPath(rootDir)) {
    stampAlignVersion(rootDir);
  }
  return file;
}

export function telemetryJsonlPath(rootDir: string, override?: string): string {
  if (override !== undefined) return path.isAbsolute(override) ? override : path.join(rootDir, override);
  return path.join(alignDirPath(rootDir), TELEMETRY_JSONL_FILENAME);
}

function telemetryStatePath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), TELEMETRY_STATE_FILENAME);
}

/** Appends one already-serialized JSON line (`serializeTelemetryEvent`, `@spikedpunch/align-core`) to
 * `.align/telemetry.jsonl` — the only fs-append call in this codebase's telemetry surface. Callers
 * are expected to have already checked telemetry is enabled; this function does no gating itself
 * so it stays a single, easily-audited "yes, this really does write to disk" primitive. */
export function appendTelemetryLine(rootDir: string, line: string, override?: string): void {
  const file = telemetryJsonlPath(rootDir, override);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`, 'utf8');
}

/** Reads `.align/telemetry-state.json` (the previous check's violation-fingerprint set, used for
 * appear/resolve diffing). A missing OR corrupt file is treated identically — the empty state —
 * deliberately different from `readGeneratedRules`'/`readRulesetIr`'s "corrupted is never treated
 * as absent" discipline above: this file is a soft, regenerable cache of the last-seen violation
 * set (IMPLEMENTATION_PLAN.md's telemetry spec: "cheap and robust to a missing/corrupt state
 * file"), not a portable ruleset artifact whose silent loss would under-enforce a rule. Worst case
 * on corruption: one check's worth of appear/resolve events look like everything just appeared. */
export function readTelemetryState(rootDir: string): TelemetryState {
  const file = telemetryStatePath(rootDir);
  if (!fs.existsSync(file)) return { violations: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { violations?: unknown }).violations)) {
      return raw as TelemetryState;
    }
    return { violations: [] };
  } catch {
    return { violations: [] };
  }
}

export function writeTelemetryState(rootDir: string, state: TelemetryState): void {
  ensureAlignDir(rootDir);
  fs.writeFileSync(telemetryStatePath(rootDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
