/**
 * Target repo root. The writable copy under test-apps is the default; the original
 * at ~/projects/kluster remains strictly read-only and is not referenced.
 * Override with ALIGN_KLUSTER_ROOT for experiments.
 */
export const KLUSTER_ROOT: string =
  process.env['ALIGN_KLUSTER_ROOT'] ?? '/Users/spikedpunchvictim/projects/align/test-apps/kluster';

export const SCAN_ROOTS: readonly string[] = ['packages', 'application', 'features'];
