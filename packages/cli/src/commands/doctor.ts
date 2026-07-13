import { buildUncertaintyAdvisories, toComponentName, type Advisory, type UncertaintyMarker } from '@align/core';
import { TypeScriptPlugin, UNMAPPED_COMPONENT, findDeadAliases, findOrphanedPackages } from '@align/plugin-typescript';
import { loadConfig } from '../config.js';

const UNMAPPED_EXAMPLES = 5;
/** Stage 2 live-probe DX finding, carried into Stage 3: the agent had to script against the
 * scanner API to get per-specifier uncertainty detail — `buildUncertaintyAdvisories` only
 * produces grouped counts. `--json` exposes the raw markers directly, capped so a repo with
 * thousands of uncertain specifiers can't blow up the payload (ADR 007 discipline extended to
 * doctor's own output). */
const UNCERTAINTY_DETAIL_CAP = 50;
/** Stage 5 polish, evidence: `RULESET_REPORT.md` (kluster ruleset exercise) logged 47
 * orphaned-package advisories and 34 dead-alias hits as DX friction in the human-readable
 * `align doctor` output — a wall of near-identical lines with no way to see "how many kinds of
 * problem do I have" at a glance. Human output now shows the first N per kind + a "and M more"
 * pointer to `--json`, which stays complete (uncapped except for the pre-existing per-specifier
 * uncertainty detail cap above). */
const DOCTOR_HUMAN_DISPLAY_CAP = 10;

export interface DoctorOptions {
  readonly json: boolean;
}

export interface DoctorJsonPayload {
  readonly advisories: readonly Advisory[];
  readonly uncertainty: {
    readonly total: number;
    readonly detail: readonly UncertaintyMarker[]; // capped at UNCERTAINTY_DETAIL_CAP
  };
}

interface DoctorReport {
  readonly advisories: readonly Advisory[];
  readonly uncertain: readonly UncertaintyMarker[];
}

async function collectDoctorReport(rootDir: string): Promise<DoctorReport> {
  const advisories: Advisory[] = [];
  let uncertain: readonly UncertaintyMarker[] = [];

  const loaded = await loadConfig(rootDir).catch((err: unknown) => {
    advisories.push({
      kind: 'config-error',
      message: `Could not load align.config.ts: ${err instanceof Error ? err.message : String(err)}`,
    });
    return undefined;
  });
  const excludes = loaded?.excludes ?? [];

  if (loaded !== undefined) {
    const { ruleset, excludes: loadedExcludes } = loaded;
    const plugin = new TypeScriptPlugin();
    const graph = await plugin.scanner.scan({ rootDir, components: ruleset.components, excludes: loadedExcludes }).catch((err: unknown) => {
      advisories.push({ kind: 'scan-error', message: err instanceof Error ? err.message : String(err) });
      return undefined;
    });

    if (graph !== undefined) {
      uncertain = graph.uncertain;
      advisories.push(...buildUncertaintyAdvisories(graph.uncertain));

      const unmapped = graph.nodes.filter((n) => n.component === UNMAPPED_COMPONENT);
      if (unmapped.length > 0) {
        const examples = unmapped.slice(0, UNMAPPED_EXAMPLES).map((n) => n.file);
        const more = unmapped.length > UNMAPPED_EXAMPLES ? `, +${unmapped.length - UNMAPPED_EXAMPLES} more` : '';
        advisories.push({
          kind: 'unmapped-files',
          message: `${unmapped.length} file(s) matched no component selector: ${examples.join(', ')}${more}.`,
        });
      }

      const seenComponents = new Set(graph.nodes.map((n) => n.component));
      const emptyComponents = Object.keys(ruleset.components).filter(
        (name) => !seenComponents.has(toComponentName(name)),
      );
      if (emptyComponents.length > 0) {
        advisories.push({
          kind: 'empty-component',
          message: `${emptyComponents.length} component(s) matched zero files (allowEmpty): ${emptyComponents.join(', ')}.`,
        });
      }
    }
  }

  for (const alias of findDeadAliases(rootDir, excludes)) {
    advisories.push({
      kind: 'dead-alias',
      message: `${alias.tsconfig}: alias '${alias.alias}' -> '${alias.target}' does not resolve to an existing path.`,
    });
  }

  for (const pkg of findOrphanedPackages(rootDir, excludes)) {
    advisories.push({
      kind: 'workspace-orphaned-package',
      message: `${pkg.dir} (package '${pkg.name}') is on disk but not covered by any pnpm-workspace.yaml glob.`,
    });
  }

  return { advisories, uncertain };
}

/**
 * `align doctor` — read-only advisory survey (Stage 2; `--json` per-specifier uncertainty detail
 * added Stage 3). Unlike `align check`, doctor never fails a build: it's a diagnostic tool for the
 * humans/agents configuring align on a repo, not a gate. Exit code is always 0; every failure mode
 * downgrades to an advisory instead of throwing, since a misconfigured repo is exactly the case
 * doctor exists to help someone understand.
 */
export async function runDoctor(rootDir: string, options: DoctorOptions = { json: false }): Promise<number> {
  const { advisories, uncertain } = await collectDoctorReport(rootDir);

  if (options.json) {
    const payload: DoctorJsonPayload = {
      advisories,
      uncertainty: { total: uncertain.length, detail: uncertain.slice(0, UNCERTAINTY_DETAIL_CAP) },
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  printReport(advisories);
  return 0; // advisory tool — never fails the build
}

function printReport(advisories: readonly Advisory[]): void {
  if (advisories.length === 0) {
    console.log('align doctor: no advisories.');
    return;
  }
  console.log(`align doctor: ${advisories.length} advisory(ies)\n`);
  const byKind = new Map<string, Advisory[]>();
  for (const a of advisories) {
    const list = byKind.get(a.kind);
    if (list === undefined) byKind.set(a.kind, [a]);
    else list.push(a);
  }
  for (const [kind, list] of byKind) {
    console.log(`  ${kind} (${list.length}):`);
    for (const a of list.slice(0, DOCTOR_HUMAN_DISPLAY_CAP)) console.log(`    - ${a.message}`);
    if (list.length > DOCTOR_HUMAN_DISPLAY_CAP) {
      console.log(`    ... and ${list.length - DOCTOR_HUMAN_DISPLAY_CAP} more (use --json for all)`);
    }
  }
}
