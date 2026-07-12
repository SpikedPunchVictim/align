# align IR Schema — `irVersion: "1"`

Scope: this document specifies the v1 rule kinds only (`components`, `arch.no-dependency`,
`arch.no-cycles`, `arch.layers`, `custom.host`, `arch.metric`), plus the provenance metadata block
every rule carries regardless of kind. Growth-path rule kinds (`arch.naming`, `lint.tool`,
`format.tool`, `types.tool`, `tests.tool`, `security.secrets`, `security.tool`, the `ts.*` namespace)
are **reserved discriminants only** — listed by name at the end, not specified, per `ARCHITECTURE.md`
§4 and `IMPLEMENTATION_PLAN.md`. `arch.naming` and `arch.metric` were both demoted to reserve at
sign-off review: neither was exercised by the spike (both repos were evaluated only against
`no-dependency`/`no-cycles`). **`arch.metric` (max-LOC only) was promoted back to v1 on 2026-07-12**,
user-approved, on evidence from the kluster ruleset exercise — two 2,100+-line files structurally
invisible to all 19 dependency/cycle rules (`test-apps/kluster/RULESET_REPORT.md` §6.2,
`IMPLEMENTATION_PLAN.md`'s Promotion log). The promotion is scoped to the `loc` metric only —
`fan-in`/`fan-out`/`instability` remain reserved discriminants pending their own evidence, and
`arch.naming` remains in reserve unchanged.

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
      "required": ["name", "selector", "allowEmpty"],
      "additionalProperties": false,
      "properties": {
        "name": { "$ref": "#/$defs/componentName" },
        "selector": { "$ref": "#/$defs/fileSelector" },
        "allowEmpty": {
          "type": "boolean",
          "description": "Opt-out of empty-selector-fails-by-default (ADR 003)."
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
        { "$ref": "#/$defs/archMetric" }
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
    }
  }
}
```

## Prose per kind

### `components` map

A `ComponentDefinition` binds a stable `ComponentName` to a `FileSelector` (`glob` or `package`).
**Path-prefix globs are the load-bearing selector kind**; `package` selectors are a complement, validated
against the resolved workspace inventory at load time (ADR 003 — spike: 13 workspace-orphaned packages a
package-name-only model would have missed, plus one dead tsconfig alias). **Empty-selector behavior**: a
component whose selector resolves to zero files is a load-time error pointing at the component definition,
unless `allowEmpty: true` is set. Rules never reference raw globs — every selector in a `RuleIR` is a
`ComponentRef` (a `ComponentName`) resolved through this map.

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

### Provenance block (all kinds)

`because` is the DSL's hoisted `.because(text)` call. `sourceFile`/`sourceLineRange`/`sourceQuote` are
populated only for rules produced by `align build` (ADR 011, Stage 4) — DSL-authored v1 rules leave them
`undefined`. All four fields feed the same terminal-output/IDE-hover/fix-prompt rendering path; none is
duplicated elsewhere in the IR.

## Reserved discriminants (growth path — name only, not specified here)

`arch.naming` (demoted at sign-off review — not spike-exercised; promoted when a real repo demands it) ·
`arch.metric`'s `fan-in`/`fan-out`/`instability` metrics (the `loc` metric was promoted 2026-07-12 — see
`arch.metric` above; these three still carry the same promotion-on-evidence burden) · `lint.tool` ·
`format.tool` · `types.tool` · `tests.tool` · `security.secrets` · `security.tool` · the `ts.*` namespace
(flagged non-portable, `portable: false`, per ADR 002). Full design for each lives in
`IMPLEMENTATION_PLAN.md`; they are not part of `irVersion: "1"`'s v1 rule-kind surface and adding one is
an `irVersion` bump or an additive union member, not a retrofit of the shapes above.
