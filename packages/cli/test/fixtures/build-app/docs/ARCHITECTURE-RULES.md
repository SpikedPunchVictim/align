# Architecture Rules

## API Isolation

- **Rule**: `api` must not depend on `ui`.

## No Cycles

```align
{"kind":"arch.no-cycles","scope":"repo"}
```
