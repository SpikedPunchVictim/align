# Architecture Rules

## API Isolation

- **Rule**: `api` must not depend on `ui`.

## No Cycles

```align
{"kind":"arch.no-cycles","scope":"repo"}
```

## Module Size

We generally want modules to stay small and focused, though there's no hard rule yet.
