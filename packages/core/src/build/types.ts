import type { RepoRelativePath, RuleId } from '../types/branded.js';
import type { RuleIR } from '../types/ir.js';
import type { SourceRange } from '../types/violation.js';

/** Why a candidate rule was NOT written — ADR 011: "ungroundable -> flagged proposal, never
 * silently written." Every reason is surfaced to the human/agent, never silently dropped. */
export type FlaggedReason =
  | 'ungroundable-selector' // a component name in the fragment doesn't exist in the registry
  | 'unparsed-bullet' // a `- **Rule**:` line didn't match the tier-2 grammar
  | 'invalid-fragment' // a tier-1 ```align block failed JSON parse or zod validation
  | 'conflicting-rule-id'; // two proposals share a semantic id but disagree on content

export interface FlaggedProposal {
  readonly section: string; // section anchor
  readonly sourceFile: RepoRelativePath;
  readonly sourceLineRange: SourceRange;
  readonly sourceQuote: string;
  readonly reason: FlaggedReason;
  readonly detail: string;
}

export type SectionTier = 'verbatim' | 'bullet' | 'prose' | 'empty';

export interface SectionClassification {
  readonly anchor: string;
  readonly headingText: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentHash: string;
  readonly tier: SectionTier;
  /** Rule ids produced from this section, post-dedup — empty for 'prose'/'empty' sections. */
  readonly ruleIds: readonly RuleId[];
}

/** Pass-1 scaffold for a prose section (ADR 011 two-pass clarification, Stage 3 MCP spec): align
 * never invents concerns — `concerns` is deliberately empty here, for the connected client agent
 * to fill in pass 2. */
export interface ProseSectionScaffold {
  readonly anchor: string;
  readonly headingText: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly concerns: readonly string[];
}

export interface BuildProposal {
  readonly sections: readonly SectionClassification[];
  readonly rules: readonly RuleIR[]; // deduped, content-addressed ids, ready to write verbatim
  readonly flagged: readonly FlaggedProposal[];
  readonly proseSections: readonly ProseSectionScaffold[];
}
