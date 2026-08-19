// Capture — ADR 025 §2 "rich artifacts, not a pass/fail bit". Every step captures full
// stdout/stderr/exit (via lib/exec.mjs) plus the contents of `.align/*`, `align.config.ts`, and
// the CLAUDE.md align block, before and after. This module captures the "file state" half.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readTextOrUndefined } from './fs-utils.mjs';
import { normalizeJson, normalizeText, makeNormalizeContext } from './normalize.mjs';

// `last-scan.json` (ADR 029) is here so a scenario can `assert` against it like any other `.align/`
// artifact. It is the first MACHINE-LOCAL file in this list — telemetry deliberately is not, being
// opt-in and off in every scenario that does not enable it — and its `observedAt` is normalized in
// `normalize.mjs`'s `VOLATILE_JSON_KEYS` for the same reason `scannedAt` is: without that, two runs
// of one scenario produce different `normalized.json` and the determinism diff reports noise.
const ALIGN_DIR_FILES = ['baseline.json', 'generated-rules.json', 'rules.lock.json', 'ruleset-ir.json', 'version.json', 'last-scan.json'];
const CLAUDE_START = '<!-- align:start -->';
const CLAUDE_END = '<!-- align:end -->';

function extractClaudeBlock(text) {
  if (text === undefined) return undefined;
  const startIdx = text.indexOf(CLAUDE_START);
  const endIdx = text.indexOf(CLAUDE_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return undefined;
  return text.slice(startIdx, endIdx + CLAUDE_END.length);
}

function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Captures the full on-disk align-relevant state of `workingDir`: every recognized `.align/*`
 * artifact (raw + normalized), `align.config.ts` (raw + normalized), and the CLAUDE.md align
 * block (raw + normalized, `undefined` if the file or the block doesn't exist yet). Raw bytes are
 * kept alongside the normalized view — normalized for comparison, raw for a human/agent to read
 * when diagnosing a failure (ADR 025 §2: "enough to diagnose a failure without re-running").
 */
export function captureState(workingDir, options = {}) {
  const ctx = makeNormalizeContext(workingDir, realpathOrSelf(workingDir), options.keepVersion ?? false);
  const alignDir = path.join(workingDir, '.align');

  const alignFiles = {};
  for (const name of ALIGN_DIR_FILES) {
    const filePath = path.join(alignDir, name);
    if (!fs.existsSync(filePath)) {
      alignFiles[name] = { present: false };
      continue;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A malformed artifact is itself a fact worth capturing (a scenario may deliberately
      // corrupt one) — captured as raw text, normalized textually, rather than thrown.
      alignFiles[name] = { present: true, raw, normalized: normalizeText(raw, ctx), parseError: true };
      continue;
    }
    alignFiles[name] = { present: true, raw, normalized: JSON.stringify(normalizeJson(parsed, ctx), null, 2) };
  }

  const configRaw = readTextOrUndefined(path.join(workingDir, 'align.config.ts'));
  const claudeRaw = readTextOrUndefined(path.join(workingDir, 'CLAUDE.md'));
  const claudeBlockRaw = extractClaudeBlock(claudeRaw);

  return {
    capturedAt: new Date().toISOString(),
    alignFiles,
    alignConfig: configRaw === undefined ? { present: false } : { present: true, raw: configRaw, normalized: normalizeText(configRaw, ctx) },
    claudeMdBlock:
      claudeBlockRaw === undefined
        ? { present: false }
        : { present: true, raw: claudeBlockRaw, normalized: normalizeText(claudeBlockRaw, ctx) },
    // ADR 026's named gap (docs/adr/026-2026-08-11-declared-write-sets.md:36-43): `claudeMdBlock` above keeps
    // ONLY the region between align's markers — "the human content of CLAUDE.md outside the
    // markers... is discarded before comparison. The harness as built would not have caught the
    // incident that motivates this ADR." `claudeMdFull` is the fix: the WHOLE file's raw bytes,
    // additive (nothing above reads it, so this cannot change any existing comparison's meaning) —
    // it exists so `lib/write-set.mjs`'s `checkMarkerOwnedRegion` has the full CLAUDE.md text
    // needed to verify the region OUTSIDE the markers stayed byte-identical, not just the region
    // inside them.
    claudeMdFull: claudeRaw === undefined ? { present: false } : { present: true, raw: claudeRaw },
  };
}

/** Normalizes a captured CLI result (lib/exec.mjs's return shape) for comparison/storage —
 * stdout/stderr text normalized, everything else (exitCode, command, durationMs) kept as data
 * (durationMs is diagnostic-only, never compared). */
export function normalizeRunResult(runResult, workingDir, options = {}) {
  const ctx = makeNormalizeContext(workingDir, realpathOrSelf(workingDir), options.keepVersion ?? false);
  return {
    command: runResult.command,
    exitCode: runResult.exitCode,
    signal: runResult.signal,
    durationMs: runResult.durationMs,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    stdoutNormalized: normalizeText(runResult.stdout, ctx),
    stderrNormalized: normalizeText(runResult.stderr, ctx),
  };
}
