import { describe, expect, it } from 'vitest';
import { fixProposalSchema } from '../../src/fix/schema.js';

describe('fixProposalSchema', () => {
  it('parses a minimal valid proposal', () => {
    const parsed = fixProposalSchema.parse({
      files: [{ path: 'src/a.ts', edits: [{ search: 'x', replace: 'y' }] }],
      rationale: 'fix it',
    });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.suppressions).toBeUndefined();
  });

  it('rejects a proposal with zero files', () => {
    expect(() => fixProposalSchema.parse({ files: [], rationale: 'x' })).toThrow();
  });

  it('rejects an edit block with an empty search string', () => {
    expect(() =>
      fixProposalSchema.parse({
        files: [{ path: 'a.ts', edits: [{ search: '', replace: 'y' }] }],
        rationale: 'x',
      }),
    ).toThrow();
  });

  it('accepts an edit with empty replace (deletion) and forViolations/nearLine', () => {
    const parsed = fixProposalSchema.parse({
      files: [
        {
          path: 'a.ts',
          edits: [{ search: 'import x;', replace: '', nearLine: 3, forViolations: ['v1'] }],
        },
      ],
      rationale: 'remove unused import',
    });
    expect(parsed.files[0]?.edits[0]?.replace).toBe('');
  });

  it('parses declared suppressions (schema accepts them — activation policy lives in the agent)', () => {
    const parsed = fixProposalSchema.parse({
      files: [{ path: 'a.ts', edits: [{ search: 'x', replace: 'y' }] }],
      suppressions: [{ ruleId: 'lint.no-console', file: 'a.ts', line: 5 }],
      rationale: 'suppress',
    });
    expect(parsed.suppressions).toHaveLength(1);
  });

  it('rejects a missing rationale', () => {
    expect(() =>
      fixProposalSchema.parse({ files: [{ path: 'a.ts', edits: [{ search: 'x', replace: 'y' }] }] }),
    ).toThrow();
  });
});
