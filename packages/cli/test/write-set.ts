import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * ADR 026 ("A command may only touch what it declares") fast-path helper: the same whole-tree
 * snapshot-and-diff invariant the Docker integration harness applies (`integration/lib/capture.mjs`
 * is a NAMED allowlist and therefore can't see this class of defect — this module is deliberately
 * NOT that; see the ADR's "why the existing controls do not cover the class"), applied to the
 * existing tmpdir unit-test fixtures so it runs on every PR in seconds, no Docker required.
 *
 * `snapshotTree` walks every path under a directory (hash + mode; symlinks are recorded by their
 * link target, never followed, so a fixture's `node_modules/@spikedpunch/align-core` symlink
 * (`init-incomplete-baseline.test.ts`'s `linkAlignCore`) doesn't drag an entire sibling package
 * into the snapshot). `expectOnlyWrote` computes the delta between a before/after pair and asserts
 * it is a subset of the caller-declared write-set — fail-closed: an empty write-set means nothing
 * may change, exactly as the ADR requires of a new scenario that hasn't declared one yet.
 *
 * `expectMarkerRegionUnchanged` is the ADR's separate content-aware clause: declaring
 * `align.config.ts`/`CLAUDE.md` writable licenses only the region between align's own START/END
 * markers (`init/marker-block.ts`) — this is BUG #10 (`docs/adr/026-declared-write-sets.md`)
 * expressed as a property. It is intentionally its own function with its own failure message
 * (not folded into `expectOnlyWrote`) — a whole-file hash match tells you the file changed, not
 * WHERE, and BUG #10's damage was entirely inside a file that was already a declared, expected
 * write.
 */

/** One path's recorded state. Directories carry no content hash (their membership IS the tree,
 * already reflected by their children's own entries) — only `kind`/`mode` matter for a directory. */
export interface TreeEntry {
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly mode: number;
  readonly hash: string;
}

/** Keyed by POSIX-style path relative to the snapshotted root — stable across the before/after
 * pair regardless of the platform's own separator. */
export type TreeSnapshot = ReadonlyMap<string, TreeEntry>;

// `.git/` is excluded from the snapshot, mirroring the ADR's own stated gap for the integration
// harness (a `git`-backed fixture — e.g. the migration-transform tests' dirty/clean-tree fixtures —
// would otherwise see `.git/index`'s churn as an undeclared write on every commit/checkout).
const ALWAYS_EXCLUDED = new Set(['.git']);

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function toPosix(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function walk(root: string, current: string, excluded: ReadonlySet<string>, out: Map<string, TreeEntry>): void {
  for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
    if (excluded.has(dirent.name)) continue;
    const abs = path.join(current, dirent.name);
    const rel = toPosix(path.relative(root, abs));
    const lst = fs.lstatSync(abs);
    if (lst.isSymbolicLink()) {
      out.set(rel, { kind: 'symlink', mode: lst.mode, hash: sha256(fs.readlinkSync(abs)) });
      continue; // never traverse through it — the link target is its own, unrelated tree.
    }
    if (lst.isDirectory()) {
      out.set(rel, { kind: 'dir', mode: lst.mode, hash: '' });
      walk(root, abs, excluded, out);
      continue;
    }
    out.set(rel, { kind: 'file', mode: lst.mode, hash: sha256(fs.readFileSync(abs)) });
  }
}

/**
 * Snapshots every path under `dir` — path (POSIX-relative to `dir`) to content-hash + mode.
 * `extraExcludes` names top-level-anywhere directory segments to skip entirely (never descended
 * into), for a fixture with its own genuinely volatile subtree beyond the built-in `.git`
 * exclusion; treat every addition here as a reviewable event (ADR 026's "Consequences" — a
 * volatile-set entry that hides a real diff is itself a defect), which is why this defaults to
 * nothing beyond `.git`.
 */
export function snapshotTree(dir: string, extraExcludes: readonly string[] = []): TreeSnapshot {
  const excluded = new Set([...ALWAYS_EXCLUDED, ...extraExcludes]);
  const out = new Map<string, TreeEntry>();
  walk(dir, dir, excluded, out);
  return out;
}

interface TreeDelta {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
}

function diffTrees(before: TreeSnapshot, after: TreeSnapshot): TreeDelta {
  const added: string[] = [];
  const modified: string[] = [];
  for (const [relPath, entry] of after) {
    const prior = before.get(relPath);
    if (prior === undefined) added.push(relPath);
    else if (prior.kind !== entry.kind || prior.hash !== entry.hash || prior.mode !== entry.mode) modified.push(relPath);
  }
  const deleted = [...before.keys()].filter((relPath) => !after.has(relPath));
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

/**
 * A directory path is implicitly licensed by any declared write-set entry underneath it — a
 * command that creates `.align/baseline.json` necessarily creates the `.align` directory too, and
 * requiring every scenario to spell out every ancestor directory as well would make the write-set
 * noisy without adding any real coverage (the directory entry carries no content of its own to
 * corrupt; its children's own entries are what `expectOnlyWrote` actually checks).
 */
function isLicensed(touchedPath: string, declared: ReadonlySet<string>): boolean {
  if (declared.has(touchedPath)) return true;
  const prefix = `${touchedPath}/`;
  for (const entry of declared) {
    if (entry.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Asserts that whatever changed under `dir` between `before` and now is a subset of `writeSet` —
 * the ADR 026 invariant, applied at the unit-test tier. Fails closed: `writeSet: []` means the
 * command must have left `dir` byte-for-byte identical. On failure, names every offending path and
 * whether it was unexpectedly added, modified, or deleted, so the assertion failure points straight
 * at the undeclared write rather than requiring a manual diff.
 */
export function expectOnlyWrote(before: TreeSnapshot, dir: string, writeSet: readonly string[]): void {
  const after = snapshotTree(dir);
  const { added, modified, deleted } = diffTrees(before, after);
  const declared = new Set(writeSet);
  const offenders: string[] = [];
  for (const relPath of added) if (!isLicensed(relPath, declared)) offenders.push(`  + added    ${relPath}`);
  for (const relPath of modified) if (!isLicensed(relPath, declared)) offenders.push(`  ~ modified ${relPath}`);
  for (const relPath of deleted) if (!isLicensed(relPath, declared)) offenders.push(`  - deleted  ${relPath}`);
  if (offenders.length > 0) {
    throw new Error(
      `expectOnlyWrote: ${dir} was touched outside its declared write-set (ADR 026):\n` +
        `${offenders.join('\n')}\n` +
        `Declared write-set: ${writeSet.length > 0 ? writeSet.join(', ') : '(empty — nothing was licensed to change)'}`,
    );
  }
}

/**
 * The ADR's content-aware clause for marker-owned files (BUG #10): asserts the region OUTSIDE
 * align's own `startMarker`…`endMarker` pair is byte-identical between `before` and `after`.
 * Declaring `align.config.ts`/`CLAUDE.md` writable in a `writeSet` only licenses the marked block —
 * this is the separate, explicit check that property requires; a whole-file hash comparison
 * (`expectOnlyWrote`) cannot express "changed, but only where it was allowed to."
 *
 * Deliberately requires exactly one well-formed marker pair in BOTH snapshots — it verifies a
 * splice-in-place re-run (the shape every real re-run of `align init`/`align build --apply` takes
 * once the block already exists), not a first-ever append (where there is no prior marked region to
 * compare against; that case's "human content survives" property is instead a simple
 * `after.startsWith`/`toContain` check at the call site, same as the existing marker-splice tests
 * in `test/init.test.ts` already use).
 */
export function expectMarkerRegionUnchanged(before: string, after: string, filePath: string, startMarker: string, endMarker: string): void {
  const outside = (content: string, which: 'before' | 'after'): string => {
    const start = content.indexOf(startMarker);
    const end = content.indexOf(endMarker);
    if (start === -1 || end === -1 || end < start) {
      throw new Error(
        `expectMarkerRegionUnchanged: ${filePath}'s "${which}" snapshot has no well-formed ` +
          `${startMarker} ... ${endMarker} pair. This helper compares the region OUTSIDE an ` +
          `EXISTING pair (a splice-in-place re-run) — it does not apply to a first-ever append.`,
      );
    }
    return content.slice(0, start) + content.slice(end + endMarker.length);
  };
  const beforeOutside = outside(before, 'before');
  const afterOutside = outside(after, 'after');
  if (beforeOutside !== afterOutside) {
    let firstDiff = 0;
    const shortest = Math.min(beforeOutside.length, afterOutside.length);
    while (firstDiff < shortest && beforeOutside[firstDiff] === afterOutside[firstDiff]) firstDiff += 1;
    const window = (s: string): string => JSON.stringify(s.slice(Math.max(0, firstDiff - 30), firstDiff + 30));
    throw new Error(
      `expectMarkerRegionUnchanged: ${filePath}'s content OUTSIDE the ${startMarker} ... ${endMarker} ` +
        `markers changed — declaring this file writable licenses only the marked block (ADR 026, BUG #10).\n` +
        `  first difference near offset ${firstDiff}:\n` +
        `    before: ${window(beforeOutside)}\n` +
        `    after:  ${window(afterOutside)}`,
    );
  }
}
