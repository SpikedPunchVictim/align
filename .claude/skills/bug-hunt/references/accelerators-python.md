# Accelerator Pack: Python

Candidates only — classify in Step 4. Use `glob="**/*.py"`, exclude `venv`, `.venv`,
`site-packages`, test dirs.

## Lens 1 — Assumptions

```
Grep pattern="\[0\]|\.pop\(\)|\.pop\(0\)"          # non-empty assumptions
Grep pattern="\w+\[['\"]\w+['\"]\]"                # dict[key] on external data (vs .get)
Grep pattern="os\.environ\["                       # env assumed present (vs .get)
Grep pattern="json\.loads\(" 
Grep pattern="def \w+\([^)]*=\s*(\[\]|\{\})"       # mutable default args
Grep pattern="assert "                             # stripped under -O; not a prod guard
Grep pattern="\.split\([^)]*\)\[\d"
```

## Lens 2 — State Machines

```
Grep pattern="self\.(is_|_state|status)"
Grep pattern="Enum\)|StrEnum\)"                    # map the transition set; find dead-end members
Grep pattern="asyncio\.CancelledError"             # find what does NOT handle cancellation
```

## Lens 3 — Boundaries

```
Grep pattern="\[-1\]|\[len\("                      # index arithmetic; empty-sequence IndexError
Grep pattern="range\(.*-\s*1"
Grep pattern="int\(|float\("                       # ValueError on unvalidated input
Grep pattern="struct\.(un)?pack"                   # fixed-width reads on variable-width data
Grep pattern="re\.sub\(r?['\"]\[\^"                # allowlist strips — can yield empty string
Grep pattern="recursion|sys\.setrecursionlimit"
```

## Lens 4 — Data Lifecycle

```
Grep pattern="\.delete\(|DELETE FROM|\.drop\("
Grep pattern="\.add\(|\.save\(|INSERT INTO|bulk_"
Grep pattern="session\.commit|atomic|begin\(\)"    # multi-statement writes without a transaction
Grep pattern="ilike|like\(|LIKE '%"                # see SQL pack
```

## Lens 5 — Error Paths

```
Grep pattern="except.*:\s*pass"                    # swallowed exceptions
Grep pattern="except Exception|except:" -A 3       # over-broad catches; log-only handlers
Grep pattern="asyncio\.create_task\("              # fire-and-forget: task exceptions vanish unless
                                                   # a reference is kept and awaited/inspected
Grep pattern="\.result\(\)|\.exception\(\)"        # futures never inspected
Grep pattern="finally:" -A 3                       # cleanup that can itself raise
```

## Lens 6 — Time & Concurrency

```
Grep pattern="datetime\.now\(\)|datetime\.utcnow"  # naive datetimes; utcnow deprecated & naive
Grep pattern="strftime|strptime"                   # locale/format assumptions
Grep pattern="time\.time\(\)"                      # wall clock where monotonic is meant
Grep pattern="exists\(" -A 5                       # TOCTOU: check-then-insert without ON CONFLICT
Grep pattern="\.lower\(\)|casefold\(\)"            # inventory for Lens 9; lower() vs casefold() mismatch
Grep pattern="threading\.|Lock\(\)|GIL"            # shared state without a lock
```

## Lens 7 — Environment Divergence

```
Grep pattern="sys\.platform|os\.name|platform\."
Grep pattern="os\.environ"                         # semantics that change per deploy
Grep pattern="locale\.|getpreferredencoding"
Grep pattern="sys\.version_info"                   # incomplete else branches
```

## Lens 8 — Cross-Implementation Divergence

```
Grep pattern="class \w+\(\w*(Base|Abstract|Protocol|Interface)\w*\)"   # implementors per contract
Grep pattern="def <method_name>\("                 # every override of a shared method →
                                                   # build the guard matrix (impl × guard-at-file:line)
```
Also compare: client SDK vs server for the same operation; sync and async variants of the same class.

## Lens 9 — Write/Read Asymmetry

```
Grep pattern="\.lower\(\)|\.strip\(\)|casefold\(|unicodedata\.normalize"   # canonicalization inventory
Grep pattern="filter\(|filter_by\(|where\("        # read sites per field — is normalization applied?
Grep pattern="<field>\s*=" -B 2 -A 2               # write sites per field
Grep pattern="cache_key|f['\"].*\{"                # derived keys built from the field
```

## Empirical harness

```bash
python3 -c 'import re; pat=re.compile(r"^PATTERN$"); [print(repr(s), bool(pat.match(s))) for s in ["","a","=="]]'
python3 -c 'print("I".lower(), "İ".lower(), "ß".casefold())'
python3 -c 'from datetime import datetime; print(datetime.now().tzinfo)'   # None = naive
python3 -c 'import struct; struct.unpack(">Q", b"\x00"*7)'                 # boundary: short buffer
```
