import type { RepoRelativePath } from './branded.js';

/**
 * "Is this path present in the working tree right now?" — ADR 028's SECOND mechanism, and the one
 * that covers causes nobody has enumerated.
 *
 * Mechanism 1 (`ScanBlindSpot`, `types/graph.ts`) records why the walk declined to look at a path.
 * It is exactly as complete as our enumeration of the ways a scan can be narrower than the
 * repository — and ADR 028 exists because the previous enumeration (ADR 027) covered one cause and
 * missed five. This probe is the guard against the sixth: before any destructive inference, an
 * orphan whose file is absent from the scan is checked against the filesystem, and if the file is
 * still there then the scan had a blind spot of SOME kind, whatever its cause, and the entry is
 * retained rather than deleted or transferred.
 *
 * INJECTED, NEVER CONSTRUCTED HERE. `packages/core` imports `node:fs` nowhere — verified by grep
 * as part of every stage that touches this, not assumed — and that stays true. The CLI supplies the
 * one real `fs`-backed implementation (`cli/src/file-existence.ts`); core tests supply a fake and
 * never touch a filesystem. This is the same dependency-injection seam the store already uses for
 * its other collaborators.
 *
 * NEITHER MECHANISM SUBSUMES THE OTHER, and the measurement is why both exist:
 *
 * ```
 * plain.ts        -> true    normal file
 * link.ts         -> true    symlink (followed)     retained by this probe
 * broken.ts       -> false   broken symlink         correctly "gone"
 * locked/file.ts  -> false   inside chmod 000 dir   WRONG — this probe alone fails here
 * gone.ts         -> false   genuinely deleted      correct
 * ```
 *
 * `fs.existsSync` swallows the `EACCES` and reports a file inside an unreadable directory as
 * ABSENT, so the probe alone does not close ADR 028's mechanism #5 — one of the two reproduced
 * severity-zeros. The walk knows that directory was unreadable; the probe knows nothing of causes
 * but catches blind spots nobody has enumerated. Together they are conservative in the safe
 * direction: retain and report, never delete on an unproven inference. If you are about to
 * "simplify" one of them away, re-read this table first.
 *
 * CONTRACT. Must not throw — a probe that throws mid-reconciliation would turn a safety check into
 * a crash on a path align was only asking about. An implementation that cannot answer must return
 * `false`, which is the pre-ADR-028 behaviour for that path (eligible for deletion/transfer) rather
 * than a silent retention leak; `false` is the honest answer to "I could not confirm this exists",
 * and mechanism 1 is what covers the cases where that answer is wrong.
 */
export type FileExistenceProbe = (file: RepoRelativePath) => boolean;
