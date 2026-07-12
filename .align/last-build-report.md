# align build report

Doc: `docs/ARCHITECTURE-RULES.md` (b5204f866bbf7d9e)
Built: 2026-07-12T08:16:30.126Z

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

## Diff vs. previous generated-rules.json

- + added `arch.no-cycles:repo`
- + added `arch.no-dependency:core->pluginTypescript`
- + added `arch.no-dependency:core->cli`

