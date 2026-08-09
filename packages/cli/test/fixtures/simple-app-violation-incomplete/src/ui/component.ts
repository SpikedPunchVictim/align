// An external package that is never installed in this fixture — its specifier resolves to
// 'unresolved' (plugin-typescript/src/scanner.ts), which the scan reports as an
// 'unresolvable-specifier' uncertainty marker and `buildUncertaintyAdvisories` (core) collapses
// into a `missing-dependencies` advisory. That's what makes this fixture's runs `complete: false`
// (the ADR 023 tier-2 axis) while still evaluating the real `api`/`ui` rules normally — unlike the
// sibling `errored` fixture (`simple-app-violation` + a shadowed component), this scan does not
// error at all.
import { totallyMissingHelper } from 'this-package-is-never-installed';

export function render(): string {
  return totallyMissingHelper();
}
