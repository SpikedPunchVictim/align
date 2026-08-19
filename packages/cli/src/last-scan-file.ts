import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanObservationRecordSchema, type ScanObservationRecord } from '@spikedpunch/align-core';
import { alignDirPath, ensureAlignDir } from './align-dir.js';
import { writeFileAtomic } from './fs-atomic.js';

// Scan-observation history (ADR 029): machine-local, gitignored for identity rather than churn —
// a record written on one machine is not evidence about another machine's checkout.
const LAST_SCAN_FILENAME = 'last-scan.json';

export function lastScanPath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), LAST_SCAN_FILENAME);
}

/**
 * `.align/last-scan.json` (ADR 029) — what the previous scan of this repository, on this machine,
 * by this version of align, observed.
 *
 * **A read failure of ANY kind returns `undefined`, and that is the opposite of `readBaseline`'s
 * rule** (`align-dir.ts` — a different module since this file was extracted from it; the two used to
 * sit two functions apart, which is what made the contrast obvious at a glance).** The difference is not an inconsistency; it is the whole reason both
 * comments are this long. `baseline.json` holds irreplaceable human consent, an empty read there is
 * followed by a full-snapshot overwrite, and BUG #1 is what happens when those combine. This file is
 * a gitignored machine-local cache align rewrites on its own schedule, holding nothing a human
 * authored, and an absent read yields `known: false` from every `ScanHistoryProbe` question — which
 * ADR 029 §5 defines as exactly today's behaviour. Throwing here would fail every `align check` in
 * the repository over a file the user cannot even see in `git status`. ADR 030 §4 records this
 * project making the same misapplication one day earlier, about `.align/.lock`, and bricking a
 * repository with it.
 *
 * The warning prints at most once per corruption in practice, because the same `check` that reads it
 * replaces it at the end of the run. Silence would be wrong regardless: a mechanism that is
 * inert because a file is unreadable must say so, or the next reader concludes it is working.
 *
 * **Measured, with the throwing version in place** (2026-08-18, integration scenario against real
 * binaries): the truncated record stays truncated *forever*. Every read throws,
 * `persistScanObservation`'s catch swallows it, the replacement write never happens, and nothing is
 * printed — the mechanism is silently dead and the user has no way to know. That is today's blast
 * radius; once the §6 consumers build a probe from this record BEFORE the scan, the throw stops
 * being contained at all.
 */
export function readLastScanRecord(rootDir: string): ScanObservationRecord | undefined {
  const file = lastScanPath(rootDir);
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return unusableScanRecord(file, err instanceof Error ? err.message : String(err));
  }
  const result = scanObservationRecordSchema.safeParse(parsed);
  if (!result.success) return unusableScanRecord(file, result.error.issues[0]?.message ?? 'unexpected shape');
  // The schema's inferred fields are plain strings; `ScanObservationRecord` brands the path/id ones.
  // Same boundary cast as `readBaseline`'s, and the same reason: `as` alone does not satisfy TS's
  // overlap check across a branded intersection.
  return result.data as unknown as ScanObservationRecord;
}

function unusableScanRecord(file: string, detail: string): undefined {
  console.error(
    `align: ignoring ${file} — ${detail}. Scan history is unavailable for this run, so align behaves ` +
      'as it did before it had any; the next successful check replaces the file.',
  );
  return undefined;
}

/**
 * Replaces `.align/last-scan.json`. Atomic (a half-written record must never be readable), but
 * deliberately **without the lock and the read token `writeBaseline` takes**.
 *
 * ADR 030's closing section scopes the expensive guarantee to the irreplaceable file, and this is
 * the case it had in mind: two aligns racing here cost the loser's observation record, which the
 * next check regenerates. Taking the lock would serialize two commands over a cache, and taking a
 * token would give this write a failure mode — a refusal a caller must handle — in exchange for
 * protecting nothing.
 */
export function writeLastScanRecord(rootDir: string, record: ScanObservationRecord): void {
  ensureAlignDir(rootDir);
  writeFileAtomic(lastScanPath(rootDir), `${JSON.stringify(record, null, 2)}\n`);
}
