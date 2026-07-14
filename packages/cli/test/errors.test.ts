import { describe, expect, it } from 'vitest';
import { AlignCoreMissingError, toAlignCoreMissingError } from '../src/errors.js';

function moduleNotFoundError(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

describe('toAlignCoreMissingError', () => {
  it('maps a synthetic ERR_MODULE_NOT_FOUND naming @spikedpunch/align-core to a friendly typed error', () => {
    const err = moduleNotFoundError("Cannot find package '@spikedpunch/align-core' imported from /repo/align.config.ts");
    const mapped = toAlignCoreMissingError(err);
    expect(mapped).toBeInstanceOf(AlignCoreMissingError);
    expect(mapped?.message).toContain('pnpm create @spikedpunch/align');
    expect(mapped?.message).toContain('pnpm add -D @spikedpunch/align-core');
  });

  it('returns undefined for an ERR_MODULE_NOT_FOUND naming an unrelated package (never swallows it)', () => {
    const err = moduleNotFoundError("Cannot find package 'some-other-package' imported from /repo/align.config.ts");
    expect(toAlignCoreMissingError(err)).toBeUndefined();
  });

  it('returns undefined for an error with a different code entirely', () => {
    const err = new Error('align.config.ts:3 Unexpected token') as NodeJS.ErrnoException;
    err.code = 'ERR_UNKNOWN';
    expect(toAlignCoreMissingError(err)).toBeUndefined();
  });

  it('returns undefined for a non-Error thrown value', () => {
    expect(toAlignCoreMissingError('not an error')).toBeUndefined();
    expect(toAlignCoreMissingError(undefined)).toBeUndefined();
  });
});
