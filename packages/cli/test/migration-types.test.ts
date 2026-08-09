import { describe, expect, it } from 'vitest';
import { allValidatorsForEntry } from '../src/migrations/types.js';
import type { Transform, Validator, VersionRegistryEntry } from '../src/migrations/types.js';

// `allValidatorsForEntry`: ADR 022's "always run" rule applies to every validator, paired or not
// — a transform's precondition validator must run even when the transform itself won't (no
// consent given, or a future `--notes`-only invocation).

function makeValidator(id: string): Validator {
  return { id, description: id, run: () => [] };
}

function makeTransform(id: string): Transform {
  return { id, description: id, idempotent: true, preview: () => ({ description: id, filesAffected: [] }), apply: () => {} };
}

describe('allValidatorsForEntry', () => {
  it('returns only the entry-level validators when there are no transforms', () => {
    const entry: VersionRegistryEntry = {
      version: '0.1.4',
      notes: [],
      validators: [makeValidator('a'), makeValidator('b')],
      transforms: [],
    };
    expect(allValidatorsForEntry(entry).map((v) => v.id)).toEqual(['a', 'b']);
  });

  it('includes every paired transform validator alongside the entry-level ones', () => {
    const entry: VersionRegistryEntry = {
      version: '0.1.4',
      notes: [],
      validators: [makeValidator('standalone')],
      transforms: [{ validator: makeValidator('precondition-1'), transform: makeTransform('t1') }],
    };
    expect(allValidatorsForEntry(entry).map((v) => v.id)).toEqual(['standalone', 'precondition-1']);
  });

  it('returns an empty array for an entry with no validators and no transforms', () => {
    const entry: VersionRegistryEntry = { version: '0.1.4', notes: [], validators: [], transforms: [] };
    expect(allValidatorsForEntry(entry)).toEqual([]);
  });
});
