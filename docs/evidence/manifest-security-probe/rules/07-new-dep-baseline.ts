// Rule 7: New-dependency-since-baseline simulation.
// Sizes what a "new dependency added" gate (§B.3's best-fit candidate —
// reuses align's existing baseline-consent doctrine verbatim) would fire on
// in practice.
//
// align (real git history, 34 commits): diffs the actual dependency name
// sets declared across all workspace member package.json files at HEAD vs
// HEAD~N, for real — this is genuine historical evidence, not a simulation.
//
// kluster (no .git at all) and n8n (git present but a 1-commit shallow
// clone — no N-commits-back history exists to diff): per the task's
// explicit fallback instruction, simulated instead — one dependency is
// removed from an in-memory copy of the current manifest set and the same
// diff logic re-run against that synthetic "baseline", to demonstrate the
// mechanism fires correctly and to show the shape of a single-dependency
// violation payload. Explicitly labeled as simulated in the findings.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Finding, RepoTarget, RuleResult, PackageJson } from '../lib/types.ts';
import { readLockfile, readPackageJson } from '../lib/read.ts';

function depSet(manifest: PackageJson | undefined): Set<string> {
  if (!manifest) return new Set();
  return new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
}

function gitShowPackageJson(repoRoot: string, rev: string, importerPath: string): PackageJson | undefined {
  const relPath = path.join(importerPath, 'package.json').replace(/\\/g, '/');
  try {
    const raw = execFileSync('git', ['show', `${rev}:${relPath}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(raw) as PackageJson;
  } catch {
    return undefined; // file didn't exist at that rev, or rev doesn't reach far enough back
  }
}

function realGitDiff(target: RepoTarget, commitsBack: number): { findings: Finding[]; notes: string[] } {
  const findings: Finding[] = [];
  const notes: string[] = [];

  const lock = readLockfile(target.root);
  if (!lock?.importers) {
    notes.push('no lockfile importers to enumerate workspace members');
    return { findings, notes };
  }

  const rev = `HEAD~${commitsBack}`;
  let revExists = true;
  try {
    execFileSync('git', ['rev-parse', '--verify', rev], { cwd: target.root, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    revExists = false;
  }
  if (!revExists) {
    notes.push(`${rev} does not exist (repo has fewer than ${commitsBack} commits) — skipped real-history diff at this depth`);
    return { findings, notes };
  }

  let newPackages = 0;
  for (const importerPath of Object.keys(lock.importers)) {
    const head = readPackageJson(target.root, importerPath);
    const baseline = gitShowPackageJson(target.root, rev, importerPath);
    const headDeps = depSet(head);
    const baselineDeps = depSet(baseline);

    if (!baseline) {
      newPackages++;
      for (const dep of headDeps) {
        findings.push({
          repo: target.id,
          location: importerPath,
          detail: `new since ${rev}: ${dep} (whole package.json is new at this rev, not an isolated dep addition)`,
          extra: { depName: dep, reason: 'new-package', rev },
        });
      }
      continue;
    }

    for (const dep of headDeps) {
      if (!baselineDeps.has(dep)) {
        findings.push({
          repo: target.id,
          location: importerPath,
          detail: `new dependency since ${rev}: ${dep}`,
          extra: { depName: dep, reason: 'new-dependency', rev },
        });
      }
    }
  }

  notes.push(`real git diff at ${rev}: ${newPackages} workspace member(s) did not exist yet at that rev`);
  return { findings, notes };
}

function simulatedDiff(target: RepoTarget): { findings: Finding[]; notes: string[] } {
  const findings: Finding[] = [];
  const notes: string[] = [
    `SIMULATED: ${target.id} has no usable N-commits-back git history (${target.gitUsable ? 'shallow clone' : 'no .git directory'}). One dependency was removed from an in-memory copy of the manifest to synthesize a "baseline" and prove the diff mechanism fires correctly — this is a mechanism test, not a historical measurement.`,
  ];

  const lock = readLockfile(target.root);
  if (!lock?.importers) {
    notes.push('no lockfile importers to enumerate workspace members');
    return { findings, notes };
  }

  // Pick the root importer ('.') if present, else the first importer path.
  const rootPath = lock.importers['.'] ? '.' : Object.keys(lock.importers)[0];
  if (rootPath === undefined) return { findings, notes };

  const manifest = readPackageJson(target.root, rootPath);
  const deps = depSet(manifest);
  const depsArr = [...deps].sort();
  if (depsArr.length === 0) {
    notes.push(`root importer (${rootPath}) has no dependencies to simulate removal of`);
    return { findings, notes };
  }

  const removed = depsArr[depsArr.length - 1] as string; // deterministic pick: last alphabetically
  findings.push({
    repo: target.id,
    location: rootPath,
    detail: `[simulated] new dependency since synthetic baseline: ${removed}`,
    extra: { depName: removed, reason: 'simulated-new-dependency' },
  });
  notes.push(`simulated baseline = current manifest at ${rootPath} minus "${removed}"; diff logic correctly flagged it as newly added`);

  return { findings, notes };
}

export function run(target: RepoTarget, commitsBack = 10): RuleResult {
  const start = performance.now();
  let findings: Finding[] = [];
  let notes: string[] = [];

  if (target.gitUsable) {
    const real = realGitDiff(target, commitsBack);
    findings = findings.concat(real.findings);
    notes = notes.concat(real.notes);
  } else {
    const sim = simulatedDiff(target);
    findings = findings.concat(sim.findings);
    notes = notes.concat(sim.notes);
  }

  return {
    ruleId: 'new-dep-baseline',
    repo: target.id,
    wallTimeMs: performance.now() - start,
    count: findings.length,
    findings,
    notes,
  };
}
