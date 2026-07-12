# align build report

Doc: `docs/ARCHITECTURE-RULES.md` (f8e0fbacf2bb9c85)
Built: 2026-07-12T17:23:52.773Z

## Impact

- Adds 0 new violation(s)
- Masks 0 previously-baselined violation(s)

## Rules

### `arch.no-cycles:repo`

- Source: `docs/ARCHITECTURE-RULES.md:14`
- Quote: "{"kind":"arch.no-cycles","scope":"repo"}"
- IR: `{"kind":"arch.no-cycles","scope":"repo","includeTypeOnly":false}`

### `arch.no-dependency:core->pluginTypescript`

- Source: `docs/ARCHITECTURE-RULES.md:19`
- Quote: "- **Rule**: `core` must not depend on `pluginTypescript`."
- IR: `{"kind":"arch.no-dependency","from":"core","to":"pluginTypescript"}`

### `arch.no-dependency:core->cli`

- Source: `docs/ARCHITECTURE-RULES.md:23`
- Quote: "- **Rule**: `core` must not depend on `cli`."
- IR: `{"kind":"arch.no-dependency","from":"core","to":"cli"}`

### `arch.metric:loc:cli`

- Source: `docs/ARCHITECTURE-RULES.md:36`
- Quote: "- **Rule**: files in `cli` must stay under 500 lines."
- IR: `{"kind":"arch.metric","target":"cli","metric":"loc","max":500}`

## Diff vs. previous generated-rules.json

- + added `arch.metric:loc:cli`

