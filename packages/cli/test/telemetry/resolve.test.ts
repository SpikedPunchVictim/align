import { describe, expect, it } from 'vitest';
import { resolveTelemetryEnabled, resolveTelemetryPreConfig } from '../../src/telemetry/resolve.js';

describe('resolveTelemetryPreConfig', () => {
  it('defers to config when no flag/env is set', () => {
    expect(resolveTelemetryPreConfig({ telemetry: undefined }, {})).toBeUndefined();
  });

  it('--telemetry forces true', () => {
    expect(resolveTelemetryPreConfig({ telemetry: true }, {})).toBe(true);
  });

  it('ALIGN_TELEMETRY=1 enables when no flag is passed', () => {
    expect(resolveTelemetryPreConfig({ telemetry: undefined }, { ALIGN_TELEMETRY: '1' })).toBe(true);
  });

  it('an unrecognized ALIGN_TELEMETRY value does not enable', () => {
    expect(resolveTelemetryPreConfig({ telemetry: undefined }, { ALIGN_TELEMETRY: 'true' })).toBeUndefined();
    expect(resolveTelemetryPreConfig({ telemetry: undefined }, { ALIGN_TELEMETRY: '0' })).toBeUndefined();
  });

  it('--no-telemetry (telemetry: false) overrides ALIGN_TELEMETRY=1', () => {
    expect(resolveTelemetryPreConfig({ telemetry: false }, { ALIGN_TELEMETRY: '1' })).toBe(false);
  });

  it('--no-telemetry overrides --telemetry if both were somehow set (defensive — commander merges these to one property)', () => {
    // Commander's negatable-option pairing collapses `--telemetry --no-telemetry` down to a single
    // boolean before this function ever sees it; this test only documents that `false` always wins
    // when it is the value this function receives, regardless of how it got there.
    expect(resolveTelemetryPreConfig({ telemetry: false }, {})).toBe(false);
  });
});

describe('resolveTelemetryEnabled', () => {
  it('uses preConfig when decided (true)', () => {
    expect(resolveTelemetryEnabled(true, false)).toBe(true);
  });

  it('uses preConfig when decided (false), even if config says true', () => {
    expect(resolveTelemetryEnabled(false, true)).toBe(false);
  });

  it('falls back to config.telemetry when preConfig is undefined', () => {
    expect(resolveTelemetryEnabled(undefined, true)).toBe(true);
    expect(resolveTelemetryEnabled(undefined, false)).toBe(false);
    expect(resolveTelemetryEnabled(undefined, undefined)).toBe(false);
  });

  it('OFF by default: no flag, no env, no config all resolve to false', () => {
    const preConfig = resolveTelemetryPreConfig({ telemetry: undefined }, {});
    expect(resolveTelemetryEnabled(preConfig, undefined)).toBe(false);
  });
});
