import { describe, expect, it } from 'vitest';
import { alignInitArgv } from '../src/alignCli.js';

describe('alignInitArgv', () => {
  // Regression: create-align 0.1.0 ran bare `align <flags>` (subcommand missing), so init never
  // executed and forwarded flags parsed as unknown top-level options. The `init` subcommand must
  // always come first.
  it('always invokes the init subcommand first, with no forwarded flags', () => {
    expect(alignInitArgv([])).toEqual(['init']);
  });

  it('prepends init before forwarded flags, preserving their order', () => {
    expect(alignInitArgv(['--accept-existing'])).toEqual(['init', '--accept-existing']);
    expect(alignInitArgv(['--greenfield', '--yes'])).toEqual(['init', '--greenfield', '--yes']);
  });
});
