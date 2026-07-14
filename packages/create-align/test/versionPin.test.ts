import { describe, expect, it } from 'vitest';
import { buildPinnedDevDependencySpecs } from '../src/versionPin.js';

describe('buildPinnedDevDependencySpecs', () => {
  it('pins align-cli and align-core to the given (create-align\'s own) version', () => {
    expect(buildPinnedDevDependencySpecs('0.1.0')).toEqual(['@spikedpunch/align-cli@0.1.0', '@spikedpunch/align-core@0.1.0']);
  });

  it('reflects a later version exactly — lockstep, no hardcoding', () => {
    expect(buildPinnedDevDependencySpecs('1.4.2')).toEqual(['@spikedpunch/align-cli@1.4.2', '@spikedpunch/align-core@1.4.2']);
  });
});
