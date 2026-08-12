// ADR 026: "A command may only touch what it declares." Two complementary, universally-applied
// checks (wired into lib/scenario-runner.mjs, never opted into per scenario — ADR 026's Decision:
// "Universal, not per-feature... independent guarding is how a defect class reaches five copies"):
//
//   1. checkWriteSet — a whole-project-tree, before/after delta (every path, not lib/capture.mjs's
//      five-file `.align/*` allowlist) must be a SUBSET of the scenario's declared `writeSet`. A
//      scenario with no `writeSet` gets the empty one — fail CLOSED (docs/adr/026-declared-write-
//      sets.md, Decision: "A scenario that declares no write-set gets the empty one: nothing may
//      change"). This is the ADR's primary mechanism, and closes the exact gap the ADR names:
//      "Everything else in the project tree is invisible to every scenario"
//      (docs/adr/026-declared-write-sets.md:36-43, citing capture.mjs:36-73).
//
//   2. checkMarkerOwnedRegion — BUG #10 expressed as a property. `align.config.ts` and `CLAUDE.md`
//      each wrap ONE align-owned region between a START/END marker pair; declaring the file
//      writable in a write-set licenses ONLY that region — the surrounding (human-owned, or at
//      least not-marker-splice-owned) content must stay byte-identical. This is deliberately a
//      SEPARATE, narrower check layered on top of (1): (1) alone would happily permit a marker-
//      splice bug to overwrite a human's `components`/`rules` the moment the scenario author
//      (correctly) declares `align.config.ts` writable at all — which is exactly BUG #10's shape
//      (docs/adr/026-declared-write-sets.md:13-28: two runs of `align init` against a config whose
//      note block lost its END marker deleted the whole ruleset).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Directories excluded from the whole-tree snapshot entirely — kept minimal and justified per
 * entry, since ADR 026 treats every addition to a volatile set as a reviewable event (Decision:
 * "Treat every addition to the volatile set as a reviewable event, exactly as ADR 025 says of
 * normalization rules").
 *
 *   - '.git'         — git's own object/ref database, reconstructed by lib/project.mjs's shallow
 *                       clone-by-sha for EVERY scenario's working copy and never written to by any
 *                       align command. ADR 026's own Consequences section names this exclusion
 *                       explicitly: "`.git/` is excluded from the snapshot, which makes `align
 *                       agent run` ... a knowing gap" — `agent` is out of harness scope anyway
 *                       (ADR 025 §7: "requires a live model").
 *   - 'node_modules'  — dependency trees. Every scenario's `install` step is a REAL `npm install`
 *                       (lib/version-install.mjs) that legitimately rewrites large parts of this
 *                       directory by design (align's own tarballs, transitive deps); it is neither
 *                       align's concern nor stable across two runs of an identical scenario (npm's
 *                       own bookkeeping, optional-dependency platform variance). ADR 026 names this
 *                       exclusion alongside `.git/` in the same breath (Decision, first bullet).
 */
const VOLATILE_DIR_NAMES = new Set(['.git', 'node_modules']);

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walk(rootDir, dir, result) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A directory that fails to read (removed mid-walk by some concurrent process, a permissions
    // fluke) is not a case this invariant should swallow into a silently-incomplete snapshot that
    // LOOKS complete — a partial snapshot could hide a real unauthorized write in the very
    // directory that vanished. Fail loudly instead (CODING_BEST_PRACTICES.md §24: never swallow).
    throw new Error(`write-set snapshot: failed to read directory '${dir}': ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const entry of entries) {
    if (entry.isDirectory() && VOLATILE_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(rootDir, full, result);
      continue;
    }
    const rel = path.relative(rootDir, full).split(path.sep).join('/');
    if (entry.isSymbolicLink()) {
      // Hashed by the link TARGET STRING, never followed — align does not create symlinks anywhere
      // in its own write surface (ADR 026's Evidence: 22 fs-mutation call sites, none symlink-
      // producing), and following one risks a cycle this module has no reason to have to handle.
      const target = fs.readlinkSync(full);
      result.set(rel, { hash: crypto.createHash('sha256').update(target).digest('hex'), mode: 'symlink' });
      continue;
    }
    if (!entry.isFile()) continue; // sockets/fifos/devices: not producible by any align write path
    const stat = fs.statSync(full);
    result.set(rel, { hash: sha256File(full), mode: stat.mode & 0o777 });
  }
}

/**
 * Walks `rootDir`, skipping `VOLATILE_DIR_NAMES` at any depth, returning
 * `repo-relative-posix-path -> { hash, mode }` for every regular file and symlink. Directories
 * themselves are not recorded — an emptied directory is already visible as its files' deletions,
 * and a directory with no files has no state left to protect.
 */
export function snapshotTree(rootDir) {
  const result = new Map();
  walk(rootDir, rootDir, result);
  return result;
}

/** Diffs two snapshots (this module's own `snapshotTree` output) into sorted added/modified/
 * deleted relative-path lists — sorted so a failure message is stable and diffable across runs. */
export function diffTreeSnapshots(before, after) {
  const added = [];
  const modified = [];
  for (const [rel, afterEntry] of after) {
    const beforeEntry = before.get(rel);
    if (beforeEntry === undefined) added.push(rel);
    else if (beforeEntry.hash !== afterEntry.hash || beforeEntry.mode !== afterEntry.mode) modified.push(rel);
  }
  const deleted = [];
  for (const rel of before.keys()) {
    if (!after.has(rel)) deleted.push(rel);
  }
  added.sort();
  modified.sort();
  deleted.sort();
  return { added, modified, deleted };
}

/**
 * ADR 026's fail-closed invariant: every added/modified/deleted path between `before` and `after`
 * must be a member of `writeSet` (an array of EXACT, repo-relative POSIX paths — literal, never
 * globs, so each entry is independently greppable/reviewable, matching the ADR's "every addition
 * [is] a reviewable event"). `writeSet` defaults to `[]` — a scenario that declares none permits
 * NOTHING to change, which is this function refusing to special-case `undefined` into "permit
 * everything" rather than a separate opt-in path a scenario author could forget.
 *
 * Every failure names every offending path, split by add/modify/delete — "the failure message
 * must name the offending paths, not just say 'tree changed'" (task brief, echoing ADR 026's own
 * "so it covers files nobody thought about").
 */
export function checkWriteSet(before, after, writeSet) {
  const allowed = new Set(writeSet ?? []);
  const { added, modified, deleted } = diffTreeSnapshots(before, after);
  const unauthorized = [
    ...added.filter((p) => !allowed.has(p)).map((p) => `${p} (added)`),
    ...modified.filter((p) => !allowed.has(p)).map((p) => `${p} (modified)`),
    ...deleted.filter((p) => !allowed.has(p)).map((p) => `${p} (deleted)`),
  ];
  if (unauthorized.length === 0) return { pass: true, failures: [], added, modified, deleted };
  return {
    pass: false,
    failures: [
      `write-set violation (ADR 026): ${unauthorized.length} path(s) changed outside the declared write-set ` +
        `[${[...allowed].sort().join(', ') || '(empty)'}]: ${unauthorized.join(', ')}`,
    ],
    added,
    modified,
    deleted,
  };
}

/**
 * Files whose declared writability (a scenario's `writeSet`) is narrowed by ADR 026's content-
 * aware clause to ONLY the region between the given markers. Both pairs are the exact literal
 * strings align's own marker-splice code searches for (`packages/cli/src/init/marker-block.ts`'s
 * `locateBlock`, called from `claude-md.ts`/`config-comment.ts`) — kept as a text anchor,
 * deliberately not imported from `packages/` (this harness has no runtime dependency on align's own
 * source, only on its BUILT OUTPUT, per ADR 025 §1's "no environment-specific branches" spirit and
 * this repo's DO-NOT-TOUCH boundary between `integration/` and `packages/`).
 */
export const MARKER_OWNED_FILES = {
  'align.config.ts': { start: '// align:generated-rules-note:start', end: '// align:generated-rules-note:end' },
  'CLAUDE.md': { start: '<!-- align:start -->', end: '<!-- align:end -->' },
};

function countOccurrences(text, marker) {
  return text.split(marker).length - 1;
}

/**
 * Strips exactly one well-formed START…END region (inclusive) out of `text`. Returns `text`
 * UNCHANGED when the markers aren't a single well-formed pair (zero, or any malformed arrangement —
 * an orphan marker, END before START, more than one pair) — the conservative direction: BUG #10's
 * own reproduction ("a note block that had lost its END marker") is exactly a malformed-marker
 * state, and treating "can't safely identify the align-owned region" as "nothing to protect" would
 * make this check blind to the precise failure it exists to catch.
 */
function stripMarkerRegion(text, start, end) {
  if (countOccurrences(text, start) !== 1 || countOccurrences(text, end) !== 1) return text;
  const startIdx = text.indexOf(start);
  const endIdx = text.indexOf(end);
  if (endIdx < startIdx) return text;
  return text.slice(0, startIdx) + text.slice(endIdx + end.length);
}

/**
 * Evaluates ADR 026's content-aware clause for ONE marker-owned file at ONE point in a scenario
 * (scenario-runner.mjs calls this per-step, using that step's own before/after raw capture — see
 * that file for why per-step granularity matters here specifically: BUG #10's reproduction is TWO
 * runs of `align init` within the SAME scenario, so only per-command comparison — not a single
 * whole-scenario bracket — can catch a later command corrupting content an earlier command in the
 * SAME scenario already established).
 *
 * `rawBefore`/`rawAfter` are `undefined` when the file didn't exist at that point — a fresh
 * creation (`undefined` -> text) has nothing to protect yet and is not a violation; deletion
 * (text -> `undefined`) is left to `checkWriteSet` (it already treats a delete as a change that
 * must be declared) rather than re-litigated here.
 */
export function checkMarkerOwnedRegion(relPath, rawBefore, rawAfter) {
  const markers = MARKER_OWNED_FILES[relPath];
  if (markers === undefined) return { pass: true, failures: [] };
  if (rawBefore === undefined || rawAfter === undefined) return { pass: true, failures: [] };
  const outsideBefore = stripMarkerRegion(rawBefore, markers.start, markers.end);
  const outsideAfter = stripMarkerRegion(rawAfter, markers.start, markers.end);
  if (outsideBefore === outsideAfter) return { pass: true, failures: [] };
  return {
    pass: false,
    failures: [
      `marker-owned content violation (ADR 026, BUG #10): '${relPath}' changed OUTSIDE align's own ` +
        `${markers.start} … ${markers.end} block. Declaring '${relPath}' writable licenses only the marked ` +
        `region — the surrounding content must stay byte-identical.`,
    ],
  };
}
