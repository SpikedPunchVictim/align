/**
 * Branded primitives (CODING_BEST_PRACTICES.md §11): confusion between these string kinds is
 * expensive (wrong file targeted, wrong rule cited, baseline entry applied to the wrong
 * violation), so they are branded rather than left as plain `string`.
 *
 * Constructors live at the trusted boundary (scanner output, DSL component registration, zod
 * `.parse()`); everywhere else these are trusted, not re-validated (parse-don't-validate,
 * CODING_BEST_PRACTICES.md §12).
 */

export type RepoRelativePath = string & { readonly __brand: 'RepoRelativePath' };
export type ComponentName = string & { readonly __brand: 'ComponentName' };
export type RuleId = string & { readonly __brand: 'RuleId' };
export type ViolationId = string & { readonly __brand: 'ViolationId' };

export function toRepoRelativePath(raw: string): RepoRelativePath {
  // Normalize to forward slashes so brand construction is also the one place path separators
  // get canonicalized (Windows dev boxes, mixed-separator inputs).
  return raw.split('\\').join('/') as RepoRelativePath;
}

export function toComponentName(raw: string): ComponentName {
  return raw as ComponentName;
}

export function toRuleId(raw: string): RuleId {
  return raw as RuleId;
}

export function toViolationId(raw: string): ViolationId {
  return raw as ViolationId;
}
