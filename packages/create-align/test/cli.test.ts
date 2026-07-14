import { describe, expect, it } from 'vitest';
import { parseCreateAlignArgs } from '../src/cli.js';

describe('parseCreateAlignArgs', () => {
  it('defaults to non-yes, no pm override, empty passthrough on an empty argv', () => {
    const result = parseCreateAlignArgs([]);
    expect(result).toEqual({ ok: true, args: { yes: false, passthrough: [] } });
  });

  it('recognizes --yes and forwards it (align init has its own --yes for the script offer)', () => {
    const result = parseCreateAlignArgs(['--yes']);
    expect(result).toEqual({ ok: true, args: { yes: true, passthrough: ['--yes'] } });
  });

  it('recognizes -y the same as --yes', () => {
    const result = parseCreateAlignArgs(['-y']);
    expect(result).toEqual({ ok: true, args: { yes: true, passthrough: ['-y'] } });
  });

  it('parses --pm <value> as a separate token and does not forward it', () => {
    const result = parseCreateAlignArgs(['--pm', 'yarn']);
    expect(result).toEqual({ ok: true, args: { yes: false, pm: 'yarn', passthrough: [] } });
  });

  it('parses --pm=<value> form', () => {
    const result = parseCreateAlignArgs(['--pm=npm']);
    expect(result).toEqual({ ok: true, args: { yes: false, pm: 'npm', passthrough: [] } });
  });

  it('rejects an invalid --pm value', () => {
    const result = parseCreateAlignArgs(['--pm', 'bun']);
    expect(result.ok).toBe(false);
  });

  it('rejects --pm with a missing value', () => {
    const result = parseCreateAlignArgs(['--pm']);
    expect(result.ok).toBe(false);
  });

  it('forwards unrecognized flags verbatim (init pass-through: --greenfield, --accept-existing)', () => {
    const result = parseCreateAlignArgs(['--greenfield', '--accept-existing']);
    expect(result).toEqual({ ok: true, args: { yes: false, passthrough: ['--greenfield', '--accept-existing'] } });
  });

  it('combines create-align-only flags with pass-through flags in one invocation', () => {
    const result = parseCreateAlignArgs(['--yes', '--greenfield', '--pm', 'pnpm']);
    expect(result).toEqual({ ok: true, args: { yes: true, pm: 'pnpm', passthrough: ['--yes', '--greenfield'] } });
  });
});
