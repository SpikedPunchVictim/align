// Bare (non-`node:`-prefixed) builtin specifier — must resolve to the SAME external node id as
// `node:child_process` in a.ts (`external:node:child_process`), proving id normalization is
// specifier-form-independent.
import { execFileSync } from 'child_process';

export function runSync(): void {
  void execFileSync;
}
