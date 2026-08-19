import { describe, expect, it, vi } from 'vitest';
import { noScanHistory, toComponentName, recalled, UNKNOWN, type CheckRun, type ScanHistoryProbe } from '@spikedpunch/align-core';
import { refuseIfRunIncomplete } from '../src/errored-run.js';
import type { ScanHistory } from '../src/scan-history.js';

/**
 * ADR 029 §6's two REPORTING consumers, wired 2026-08-19 — the grounding report (LEDGER D011) and the
 * scope-change note (D009).
 *
 * The refusal itself is untouched: it is decided by `isRunComplete`, exactly as §6 says ("the ADR 023
 * tier-2 refusal itself is unchanged; only its message improves"). These tests are therefore about a
 * SENTENCE, and they are worth having because the sentence is the whole product of the consumer — a
 * user who cannot tell "this selector never matched anything" from "this selector matched twelve files
 * yesterday" has to go and find out, and those two have different fixes.
 */

function ungroundedRun(): CheckRun {
  return {
    verdict: 'red',
    gates: [],
    advisories: [],
    scannedAt: 1_755_000_000_000,
    ungroundedComponents: [{ name: toComponentName('api'), selector: 'src/api/**', policy: 'allow' }],
    blindSpots: [],
    observedFiles: { source: new Set(), manifest: new Set() },
    observedViolations: [],
    componentMatchCounts: new Map(),
  };
}

function history(probe: ScanHistoryProbe, scopeIdentity = 'scope-now'): ScanHistory {
  return {
    probe,
    context: { alignVersion: '0.2.0', scopeIdentity, ruleDefinitions: new Map(), componentSelectorIdentities: new Map() },
    previous: undefined,
  };
}

function refuse(h: ScanHistory): string {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  expect(refuseIfRunIncomplete('align baseline prune', ungroundedRun(), 3, false, h)).toBe(1);
  vi.restoreAllMocks();
  return errors.join('\n');
}

describe('the tier-2 refusal names WHY a component is ungrounded', () => {
  it('reports the previous match count when the component used to match files', () => {
    const message = refuse(
      history({ ...noScanHistory(), observedMatchCount: () => recalled(12) }),
    );

    expect(message).toContain("api → 'src/api/**' — matched 12 file(s) on the previous scan and 0 now");
  });

  it('says nothing when there is no history — the message degrades to what it always said', () => {
    // The property that lets the parameter be required without making a no-history caller lie: an
    // absent record subtracts a clause, it does not add a wrong one.
    const message = refuse(history(noScanHistory()));

    expect(message).toContain("api → 'src/api/**'");
    expect(message).not.toContain('previous scan');
  });

  it('says nothing when the component matched nothing last scan either', () => {
    // A selector that has ALWAYS been wrong is the other diagnosis, and "(matched 0 files last scan)"
    // on every ungrounded component is noise in the sentence this consumer exists to sharpen.
    const message = refuse(history({ ...noScanHistory(), observedMatchCount: () => recalled(0) }));

    expect(message).not.toContain('previous scan');
  });
});

describe('the tier-2 refusal notes a scan-scope change, without claiming a direction', () => {
  it('notes it when the previous scope identity differs', () => {
    const message = refuse(history({ ...noScanHistory(), previousScopeIdentity: () => recalled('scope-before') }));

    expect(message).toContain('the scan scope changed since the previous run');
  });

  it('stays silent when the scope is unchanged, and when the record cannot say', () => {
    expect(refuse(history({ ...noScanHistory(), previousScopeIdentity: () => recalled('scope-now') }))).not.toContain('scan scope changed');
    expect(refuse(history({ ...noScanHistory(), previousScopeIdentity: () => UNKNOWN }))).not.toContain('scan scope changed');
  });

  it('does NOT claim narrower or wider — `scopeIdentity` is a hash and cannot support a direction', () => {
    // ADR 029 §6 asks for "the narrowing direction only". The record carries a hash of the sorted
    // excludes, so same-or-different is all it can answer; a direction would need the scope's contents
    // in every repository, the trade D032 declined for the observed-file list after measuring it.
    const message = refuse(history({ ...noScanHistory(), previousScopeIdentity: () => recalled('scope-before') }));

    expect(message).not.toMatch(/narrow|wider|widened/i);
  });
});

describe('the refusal itself is unchanged by any of this', () => {
  it('still proceeds on a complete run, whatever the history says', () => {
    const complete = { ...ungroundedRun(), ungroundedComponents: [] };
    const h = history({ ...noScanHistory(), observedMatchCount: () => recalled(12) });

    expect(refuseIfRunIncomplete('align baseline prune', complete, 3, false, h)).toBeUndefined();
  });

  it('still proceeds when nothing is at risk, and when the override is passed', () => {
    const h = history({ ...noScanHistory(), observedMatchCount: () => recalled(12) });
    expect(refuseIfRunIncomplete('align baseline prune', ungroundedRun(), 0, false, h)).toBeUndefined();
    expect(refuseIfRunIncomplete('align baseline prune', ungroundedRun(), 3, true, h)).toBeUndefined();
  });
});
