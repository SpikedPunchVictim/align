# align IR Schema — `irVersion: "1"`

Scope: this document specifies the v1 rule kinds only (`components`, `arch.no-dependency`,
`arch.no-cycles`, `arch.layers`, `custom.host`, `arch.metric`, `security.manifest.source-hygiene`,
`security.manifest.new-dependency`), plus the provenance metadata block every rule carries
regardless of kind. Growth-path rule kinds (`arch.naming`, `lint.tool`, `format.tool`, `types.tool`,
`tests.tool`, `security.tool`, the `ts.*` namespace) are **reserved discriminants only** — listed by
name at the end, not specified, per `ARCHITECTURE.md` §4 and `IMPLEMENTATION_PLAN.md`. `arch.naming`
and `arch.metric` were both demoted to reserve at sign-off review: neither was exercised by the
spike (both repos were evaluated only against `no-dependency`/`no-cycles`). **`arch.metric` (max-LOC
only) was promoted back to v1 on 2026-07-12**, user-approved, on evidence from the kluster ruleset
exercise — two 2,100+-line files structurally invisible to all 19 dependency/cycle rules
(`test-apps/kluster/RULESET_REPORT.md` §6.2, `IMPLEMENTATION_PLAN.md`'s Promotion log). The
promotion is scoped to the `loc` metric only — `fan-in`/`fan-out`/`instability` remain reserved
discriminants pending their own evidence, and `arch.naming` remains in reserve unchanged.
**`security.manifest.source-hygiene` and `security.manifest.new-dependency` were promoted 2026-07-12**,
user-approved, on evidence from `docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md`'s manifest-security probe — see
ADR 013 and the two kinds' own sections below. `security.secrets` was reserved-only prior to this
promotion and remains reserved (a different, unrelated rule shape — content scanning for leaked
credentials, not manifest/lockfile inspection); it is now listed separately from `security.tool` in
the reserved section below to avoid implying either is specified by this promotion.

Runtime validation of this shape is zod (ADR 002); the JSON Schema below is the portable, tool-agnostic
description of the same contract — the substrate for the cache hash, the `align_explain_rule` payload, and
the baseline contract (locked decision #1, `IMPLEMENTATION_PLAN.md`).

## Top-level shape

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://align.dev/schema/ir-v1.json",
  "title": "align RulesetIR v1",
  "type": "object",
  "required": ["irVersion", "components", "rules"],
  "additionalProperties": false,
  "properties": {
    "irVersion": { "const": "1" },
    "components": {
      "type": "object",
      "additionalProperties": { "$ref": "#/$defs/componentDefinition" }
    },
    "rules": {
      "type": "array",
      "items": { "$ref": "#/$defs/ruleIR" }
    }
  },
  "$defs": {
    "componentName": {
      "type": "string",
      "pattern": "^[A-Za-z][A-Za-z0-9_-]*$",
      "description": "Branded ComponentName at the TS layer; a plain validated string on the wire."
    },
    "fileSelector": {
      "oneOf": [
        {
          "type": "object",
          "required": ["kind", "patterns"],
          "additionalProperties": false,
          "properties": {
            "kind": { "const": "glob" },
            "patterns": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
          }
        },
        {
          "type": "object",
          "required": ["kind", "packageNames"],
          "additionalProperties": false,
          "properties": {
            "kind": { "const": "package" },
            "packageNames": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
          }
        }
      ]
    },
    "componentDefinition": {
      "type": "object",
      "required": ["name", "selector", "empty"],
      "additionalProperties": false,
      "properties": {
        "name": { "$ref": "#/$defs/componentName" },
        "selector": { "$ref": "#/$defs/fileSelector" },
        "empty": {
          "enum": ["fail", "allow", "until-populated"],
          "default": "fail",
          "description": "Empty-selector policy (ADR 003 + its greenfield-mode amendment; replaces the boolean allowEmpty as of the greenfield-mode change — the DSL's `allowEmpty: true` remains a deprecated alias for 'allow', dsl/index.ts). 'fail' (default): a component matching zero files is a load-time error, unchanged empty-selector-fails-by-default safety. 'allow': empty tolerated permanently, surfaced as an `ungrounded-component` in `CheckRun.ungroundedComponents` (ADR 008 amendment) instead of silently. 'until-populated': same surfacing while empty, but self-heals — once the component has >=1 classified file the empty-check simply stops firing (no separate armed state) and its rules evaluate normally."
        }
      }
    },
    "componentRef": {
      "$ref": "#/$defs/componentName",
      "description": "Rules reference components by name, never raw globs (ADR 003)."
    },
    "sourceLineRange": {
      "type": "object",
      "required": ["startLine", "endLine"],
      "additionalProperties": false,
      "properties": {
        "startLine": { "type": "integer", "minimum": 1 },
        "endLine": { "type": "integer", "minimum": 1 }
      }
    },
    "ruleProvenance": {
      "type": "object",
      "additionalProperties": false,
      "description": "One field per provenance concern; because() and doc-build provenance share this block (ADR 002, ADR 011).",
      "properties": {
        "because": { "type": "string", "description": "Hoisted from .because() at the DSL layer." },
        "sourceFile": { "type": "string", "description": "Repo-relative path; set only for align-build-generated rules." },
        "sourceLineRange": { "$ref": "#/$defs/sourceLineRange" },
        "sourceQuote": { "type": "string", "description": "Verbatim doc text a violation may quote (ADR 011)." }
      }
    },
    "ruleId": { "type": "string", "description": "Branded RuleId at the TS layer." },
    "ruleIR": {
      "oneOf": [
        { "$ref": "#/$defs/archNoDependency" },
        { "$ref": "#/$defs/archNoCycles" },
        { "$ref": "#/$defs/archLayers" },
        { "$ref": "#/$defs/customHost" },
        { "$ref": "#/$defs/archMetric" },
        { "$ref": "#/$defs/securityManifestSourceHygiene" },
        { "$ref": "#/$defs/securityManifestNewDependency" }
      ]
    },
    "archNoDependency": {
      "type": "object",
      "required": ["kind", "id", "from", "to", "provenance"],
      "additionalProperties": false,
      "properties": {
        "kind": { "const": "arch.no-dependency" },
        "id": { "$ref": "#/$defs/ruleId" },
        "from": { "$ref": "#/$defs/componentRef" },
        "to": { "$ref": "#/$defs/componentRef" },
        "provenance": { "$ref": "#/$defs/ruleProvenance" }
      }
    },
    "archNoCycles": {
      "type": "object",
      "required": ["kind", "id", "scope", "includeTypeOnly", "provenance"],
      "additionalProperties": false,
      "properties": {
        "kind": { "const": "arch.no-cycles" },
        "id": { "$ref": "#/$defs/ruleId" },
        "scope": {
          "oneOf": [{ "const": "repo" }, { "$ref": "#/$defs/componentRef" }]
        },
        "includeTypeOnly": {
          "type": "boolean",
          "description": "Default false — type-only edges excluded from cycle default (ADR 004, probe 5a)."
        },
        "provenance": { "$ref": "#/$defs/ruleProvenance" }
      }
    },
    "archLayers": {
      "type": "object",
      "required": ["kind", "id", "layers", "provenance"],
      "additionalProperties": false,
      "properties": {
        "kind": { "const": "arch.layers" },
        "id": { "$ref": "#/$defs/ruleId" },
        "layers": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "required": ["layer", "canDependOn"],
            "additionalProperties": false,
            "properties": {
              "layer": { "$ref": "#/$defs/componentRef" },
              "canDependOn": { "type": "array", "items": { "$ref": "#/$defs/componentRef" } }
            }
          }
        },
        "provenance": { "$ref": "#/$defs/ruleProvenance" }
      }
    },
    "customHost": {
      "type": "object",
      "required": ["kind", "id", "hostRuleName", "portable", "provenance"],
      "additionalProperties": false,
      "properties": {
        "kind": { "const": "custom.host" },
        "id": { "$ref": "#/$defs/ruleId" },
        "hostRuleName": { "type": "string" },
        "portable": { "const": false },
        "provenance": { "$ref": "#/$defs/ruleProvenance" }
      }
    },
    "archMetric": {
      "type": "object",
      "required": ["kind", "id", "target", "metric", "max", "provenance"],
      "additionalProperties": false,
      "properties": {
        "kind": { "const": "arch.metric" },
        "id": { "$ref": "#/$defs/ruleId" },
        "target": { "$ref": "#/$defs/componentRef" },
        "metric": {
          "const": "loc",
          "description": "Growable discriminant: `loc` is the only promoted metric (2026-07-12, kluster ruleset evidence). fan-in/fan-out/instability remain reserved — this becomes a `oneOf` of literals when the next one is promoted, never a retrofit of this shape."
        },
        "max": { "type": "integer", "minimum": 1 },
        "provenance": { "$ref": "#/$defs/ruleProvenance" }
      }
    },
    "securityManifestSourceHygiene": {
      "type": "object",
      "required": ["kind", "id", "provenance"],
      "additionalProperties": false,
      "properties": {
        "kind": { "const": "security.manifest.source-hygiene" },
        "id": { "$ref": "#/$defs/ruleId" },
        "provenance": { "$ref": "#/$defs/ruleProvenance" }
      }
    },
    "securityManifestNewDependency": {
      "type": "object",
      "required": ["kind", "id", "provenance"],
      "additionalProperties": false,
      "properties": {
        "kind": { "const": "security.manifest.new-dependency" },
        "id": { "$ref": "#/$defs/ruleId" },
        "provenance": { "$ref": "#/$defs/ruleProvenance" }
      }
    }
  }
}
```

Both `security.manifest.*` kinds are repo-wide — no `target`/`from`/`to` field, no `ComponentRef` at
all (same no-selector shape as `customHost` minus `hostRuleName`) — because the manifest scan domain
(root + workspace `package.json` + `pnpm-lock.yaml`, ADR 013) has no notion of align's
file-classified components.

## Prose per kind

### `components` map

A `ComponentDefinition` binds a stable `ComponentName` to a `FileSelector` (`glob` or `package`).
**Path-prefix globs are the load-bearing selector kind**; `package` selectors are a complement, validated
against the resolved workspace inventory at load time (ADR 003 — spike: 13 workspace-orphaned packages a
package-name-only model would have missed, plus one dead tsconfig alias). **Empty-selector behavior**: a
component whose selector resolves to zero files is a load-time error pointing at the component definition,
unless `empty: 'allow'` or `empty: 'until-populated'` is set (greenfield mode, ADR 003 amendment; the
DSL's `allowEmpty: true` is a deprecated alias for `empty: 'allow'`) — either opt-out is then surfaced as
an `ungrounded-component` entry in `CheckRun.ungroundedComponents` rather than silently, and
`'until-populated'` additionally self-heals once the component has real files (ADR 008 amendment). Rules
never reference raw globs — every selector in a `RuleIR` is a `ComponentRef` (a `ComponentName`) resolved
through this map.

### `arch.no-dependency`

Forbids any edge from files in component `from` to files in component `to`. **Evaluation**: for every edge
in the `DependencyGraph` whose source file resolves to `from` and target file resolves to `to`, emit one
`Violation` (kind `no-dependency`) unless the specific edge is baselined. Direction matters — `from`/`to` is
strictly one-way; a bidirectional prohibition is two rules or an `isIsolated()`-shaped `layers` statement.

### `arch.no-cycles`

Detects strongly-connected components (Tarjan SCC) within `scope` (whole repo or a single component's file
set). **`includeTypeOnly` defaults to `false`**: excluding type-only edges from the default cycle scan is
confirmed correct by measurement — including them on kluster added exactly 2 benign type-reference loops
with no runtime failure mode (probe 5a). Each violation carries the full cycle chain as per-edge detail
(`{from, to, specifier, line}` per hop, see `docs/core-interfaces.md`), not just file names — a chain
without edge lines forces an agent to grep every file in it (spike Q4).

### `arch.layers`

A macro expanding to a set of `arch.no-dependency` constraints: each entry says "this layer may depend only
on these layers," and everything outside that allowlist is forbidden. This is the DSL's
`.canOnlyDependOn(...)` verb (ADR 002) at the IR level, and the shape `align init` generates for its starter
ruleset (~3 layer statements rather than the 49 pairwise rules a full component-pair enumeration would
produce — probe 5b).

### `custom.host`

The escape hatch for host-defined logic the IR doesn't model as a first-class kind yet. Always
`portable: false` — it is never silently treated as portable, and it is not a dumping ground for kinds that
should really be promoted to a first-class `arch.*`/`ts.*` discriminant; see ADR 002.

**Registration surface, promoted 2026-07-12** (docs/proposals/rule-expansion-evaluation.md §B.0, user-approved):
the IR shape above was always a schema slot, but through commit `064edaf` there was nothing to register a
predicate *against* — every `custom.host` rule hard-errored at check time (`UnknownHostRuleError`) and was
refused at grounding time (`unregistered-host-rule`), defensively, not functionally. This promotion is
infrastructure, not a new rule kind: `align.config.ts` gains a sibling named export, `hostRules: Record<string,
HostPredicate>` (never passed through `defineProject` — `RulesetIR` is portable JSON, and predicate functions
can't survive that parse boundary), and the DSL gains `c.custom.host('name')` to reference an entry in it.
`HostPredicate = (ctx: HostRuleContext) => readonly HostViolation[]` is a pure function (no I/O) over
`{ graph, componentOf, files }` — the same already-scanned `DependencyGraph` every other evaluator sees.
`GateOrchestrator`'s constructor takes the registered-predicate map (built by the CLI composition root from
`align.config.ts`'s `hostRules` export) and:
1. Passes its key set to `validateHostRules` (the check-time guard, unchanged mechanism, now fed a real set
   instead of always-empty) — an unregistered name still hard-errors, exactly as before.
2. Dispatches `custom.host` rules to `evaluateCustomHost`, which normalizes each `HostViolation` into a full
   `Violation` (`kind: 'custom'`, fingerprinted, baseline-able, `fixHint: { code: 'manual-review' }` by
   default) — the same machinery every portable rule kind gets.
3. Catches a predicate that throws and re-raises `HostPredicateExecutionError`, which the orchestrator turns
   into gate `error` (never a silent pass) — the reference-validity invariant's sibling (ADR 008 amendment).

A registered name is now groundable at propose/build time too (`ground.ts`'s `custom.host` case checks the
same registered-predicate set); `export-ir`/`align build` continue marking these rules `portable: false`
regardless — registration makes a rule *evaluatable*, not portable. See `docs/core-interfaces.md`'s "Host
predicate registration surface" section for the full type shapes, and ADR 002's amendment for the design
rationale (why a sibling export instead of a `defineProject` field).

### `arch.metric` (max-LOC only)

**Promoted 2026-07-12** (user-approved) from the reserved-discriminants list below, on evidence from the
kluster ruleset exercise: `application/api/src/services/spec/build-worker.ts` (2,109 lines) and a routes
file (2,220 lines) were structurally invisible to every one of that ruleset's 19 dependency/cycle rules —
file size is orthogonal to import direction, and nothing else in `irVersion: "1"` could flag it
(`test-apps/kluster/RULESET_REPORT.md` §6.2). Forbids any file classified to component `target` from
exceeding `max` lines of the given `metric`.

**Scope of this promotion — `loc` only**: `metric` is a single literal (`"loc"`) today, deliberately
written as a growable discriminant (a `const` now, a `oneOf` of literals later) rather than a bare string,
so promoting `fan-in`/`fan-out`/`instability` is additive — a new literal option plus new evaluator logic,
never a retrofit of this shape. Those three remain reserved discriminants (below) pending their own
evidence; this promotion does not carry them along.

**Evaluation**: for every file in the `DependencyGraph` whose node resolves to component `target` with
`loc > max`, emit one `Violation` (kind `metric`, category `architecture`) naming the file, its actual
line count, and `max`. `loc` was already captured on every `DependencyGraphNode` (no new scanning); the
required `Violation.snippet` field is the file's first line (`DependencyGraphNode.snippet`, captured at
scan time for the same reason `DependencyGraphEdge.snippet` exists — see `docs/core-interfaces.md`'s
deviation note). `fixHint` is `{ code: 'split-file', file }`.

### `security.manifest.source-hygiene`

**Promoted 2026-07-12** (user-approved, ADR 013) on evidence from `docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md`
Rule 1: 3/3 hand-verified real, zero false positives, caught on n8n (the probe's own stress test) —
SheetJS's `xlsx` pinned to its own CDN tarball (`https://cdn.sheetjs.com/...`, stopped publishing to
npm past 0.18) and `wa-sqlite` pinned to an unreleased git commit (`github:rhashimoto/wa-sqlite#...`).
Flags any dependency specifier resolving to a `git`/`git+`/`github:`/`gitlab:`/`bitbucket:`/`http(s):`
/`file:`/`link:` source — never a registry version range, `workspace:` protocol reference, or an
`npm:` alias (an alias still resolves through the registry under a different name). **Evaluation**:
for every dependency across every scanned manifest (root + workspace members) whose effective
specifier (lockfile-resolved when `pnpm-lock.yaml` is present, so a `catalog:`-managed dependency's
real specifier is visible — otherwise the raw `package.json` value) matches one of those prefixes,
emit one `Violation` (kind `manifest-source-hygiene`, category `security`) naming the declaring
manifest (`file`), the dependency name, its specifier, and a `sourceType` classification
(`git`/`http`/`file`/`link`). `fixHint` is `{ code: 'manual-review' }` — there is no structural fix
align can propose for a non-registry source; a human decides whether it's an accepted deviation
(as both n8n cases are) or a real signal to remove. **Fingerprint is name-level** (declaring
manifest path + dependency name only — never the specifier value or a line number), so a git-ref
bump or a manifest reformatting doesn't reset baseline consent for an already-reviewed dependency.

### `security.manifest.new-dependency`

**Promoted 2026-07-12** (user-approved, ADR 013) on evidence from `docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md`
Rule 7 — the probe's strongest result: a real historical catch on align's own history
(`@anthropic-ai/sdk` entering the tree when `packages/agent` was built), plus mechanism-proof
simulations on kluster and n8n, zero false positives across all three. **Re-expressed through
align's existing baseline-consent machinery (ADR 006) rather than a git-history diff**: the
evaluator is stateless and has no notion of "since when" — every current runtime (`dependencies`) and
dev (`devDependencies`) dependency, name-level, per declaring manifest, is fingerprinted and emitted
as a candidate `Violation` on every run. Baseline consent (`align init` / `baseline accept`) is what
turns "every dependency in the repo today" into "nothing" on adoption; a dependency added after that
point has a fingerprint the baseline has never seen, so it — and only it — shows red.
`optionalDependencies`/`peerDependencies` are excluded (runtime + dev only; an optional dependency's
absence/presence is a different risk shape, out of scope for this promotion). **Name-level only,
deliberately**: version-level gating (flagging every version bump, not just new names) was
considered and rejected — it would fire on every routine dependency-update PR (Renovate/Dependabot),
which the probe's own noise-assessment doctrine treats as an unacceptable false-positive rate;
documented as a follow-up, not built. `fixHint` is `{ code: 'manual-review' }`.

### Provenance block (all kinds)

`because` is the DSL's hoisted `.because(text)` call. `sourceFile`/`sourceLineRange`/`sourceQuote` are
populated only for rules produced by `align build` (ADR 011, Stage 4) — DSL-authored v1 rules leave them
`undefined`. All four fields feed the same terminal-output/IDE-hover/fix-prompt rendering path; none is
duplicated elsewhere in the IR.

## Security: `.align/ruleset-ir.json` — the untrusted-mode artifact (ADR 014)

`align check --untrusted` (alias `--ir-only`) never dynamically imports `align.config.ts` and never invokes a
`hostRules` predicate — it loads the ruleset from a committed JSON artifact instead, written once in a trusted
context by `align export-ir`. This is possible with no new IR shape because the ruleset was already portable
(ADR 002, locked decision #1): `align export-ir` simply wraps the existing `RulesetIR` (`components` + `rules`,
above) with the scan-time metadata an untrusted scan additionally needs:

```ts
interface ExportedRuleset {
  irVersion: '1';
  exportedAt: number;    // epoch ms, Date.now() at export time — a snapshot marker, not a cache key
  excludes: string[];    // scan-time excludes (align.config.ts's separate `excludes` named export,
                          // same ADR 002 deviation as this doc's "components map" note above — plain
                          // string data, not code, safe to carry across the trust boundary)
  ruleset: RulesetIR;    // exactly the schema above — no new fields, no relaxed validation
}
```

Zod-validated as `exportedRulesetSchema` (`packages/core/src/build/schema.ts`), parsed once at the
`--untrusted` read boundary (`readRulesetIr`, `packages/cli/src/align-dir.ts`) — same parse-don't-validate
discipline as every other artifact in this document. **Deliberately excludes `hostRules`**: predicate
functions cannot survive a JSON boundary (this was already true of `RulesetIR` itself, ADR 002's amendment),
so `custom.host` rules are structurally unevaluatable under `--untrusted` regardless of what this artifact
contains — see `custom.host`'s entry above and ADR 014 for the refuse-outright (never silently skip) decision.

`align check --untrusted` refuses — never falls back to executing `align.config.ts` — when this file is
missing, fails to parse as JSON, or fails `exportedRulesetSchema` validation. A corrupted artifact is treated
identically to a missing one, never to "zero rules": silently evaluating an empty ruleset would be the same
false-green class the reference-validity invariant (ADR 008's amendment) already forbids for dangling
references, just triggered by artifact corruption instead of a stale rename.

## Reserved discriminants (growth path — name only, not specified here)

`arch.naming` (demoted at sign-off review — not spike-exercised; promoted when a real repo demands it) ·
`arch.metric`'s `fan-in`/`fan-out`/`instability` metrics (the `loc` metric was promoted 2026-07-12 — see
`arch.metric` above; these three still carry the same promotion-on-evidence burden) · `lint.tool` ·
`format.tool` · `types.tool` · `tests.tool` · `security.tool` · the `ts.*` namespace
(flagged non-portable, `portable: false`, per ADR 002). Full design for each lives in
`IMPLEMENTATION_PLAN.md`; they are not part of `irVersion: "1"`'s v1 rule-kind surface and adding one is
an `irVersion` bump or an additive union member, not a retrofit of the shapes above.

**Also still reserved, distinct from the two `security.manifest.*` kinds promoted above (ADR 013):**
`security.secrets` (built-in secrets scanner — AWS keys, private keys, high-entropy tokens; a content-
scanning shape, not a manifest/lockfile-inspection one) and `security.manifest`'s own install-script
exposure sibling (`docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md` Rule 2 — install-dependent, held back pending the
content-pattern classifier rework the probe's own findings demand; see ADR 013's follow-up ladder).
Version-pinning policy and registry-URL allowlisting were evaluated by the same probe and **rejected on
evidence** (zero findings across 5,594 real specifiers; 100% redundant with `source-hygiene`,
respectively) — not reserved, not planned.
