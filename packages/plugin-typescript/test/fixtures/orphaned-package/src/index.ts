// This package has a package.json but is not listed in any pnpm-workspace.yaml glob
// (there is no pnpm-workspace.yaml in this fixture at all) — proves path-prefix component
// selectors classify files independent of workspace membership (ADR 003).
export const value = 42;
