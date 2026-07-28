# Accelerator Pack: SQL, Migrations & Schema

Load this pack **in addition to** the language pack whenever the repo has migrations, `.sql` files,
or an ORM schema. It serves two purposes:

1. **Guard source.** Migrations and schemas are the highest-authority guard location in the Step 2
   guard map. A unique constraint, CHECK, NOT NULL, or FK here can refute a finding outright — or
   confirm one (a *case-sensitive* unique on an identity column confirms duplicate-account bugs).
   During Step 5 refutation, grep the migrations for **every column named in a finding** before the
   finding ships.
2. **Bug source.** Schema and query patterns below are findings in their own right.

Search both migration files AND query-builder call sites in application code.

## Query patterns (all lenses)

```
Grep pattern="ilike|ILIKE"                         # `_` and `%` are wildcards: a user-supplied name
                                                   # used with ILIKE matches — and with DELETE,
                                                   # destroys — unrelated rows. If equality was
                                                   # meant, this is a bug even when the char is
                                                   # currently blocked upstream; verify the
                                                   # blocklist actually covers BOTH `_` and `%`.
Grep pattern="LIKE '%|LIKE ?|like\("               # same class; also unindexed scans
Grep pattern="\|\||CONCAT\(|format!|f\"|\$\{|\" \+" # SQL assembled from strings — injection + wildcard
Grep pattern="lower\(|LOWER\("                     # applied on one side of a comparison only?
```

## Lens 4 — Lifecycle / atomicity

```
Grep pattern="DELETE FROM" -B 5 -A 10              # multi-statement deletes: are parent and child
                                                   # rows removed in ONE transaction? Does the child
                                                   # delete use the same predicate as the parent
                                                   # (over-broad parent match orphans children)?
Grep pattern="ON DELETE (CASCADE|SET NULL|RESTRICT)"   # and FKs with NO action specified
Grep pattern="REFERENCES|foreign"                  # tables with no FK at all → app-managed orphans
Grep pattern="transaction|BEGIN|COMMIT"            # writes outside any transaction
```

## Lens 6 — Time / TOCTOU

```
Grep pattern="ON CONFLICT|INSERT OR IGNORE|MERGE|upsert"   # inventory; check-then-insert code that
                                                           # does NOT use these is racy
Grep pattern="timestamp(?!tz)|datetime"            # zone-naive column types (Postgres: prefer timestamptz)
Grep pattern="now\(\)|CURRENT_TIMESTAMP"           # server vs app clock mixing
```

## Lens 9 — Write/read asymmetry at the schema level

```
Grep pattern="unique|UNIQUE"                       # for every unique on an identity-ish column
                                                   # (email, username, name, slug, key):
                                                   #   is it case-sensitive while the app folds case?
                                                   #   is there a functional index on lower(col)?
Grep pattern="lower\(.*\)\)|citext"                # normalized-unique inventory; citext usage
Grep pattern="CHECK\s*\(|check\("                  # value constraints the app may not mirror
Grep pattern="NOT NULL|notNull|nullable"           # app assumes non-null; does the schema enforce it?
Grep pattern="varchar\(\d+\)|maxLength|max_length" # length limits the app may exceed or not mirror
```

## Migration-aware fix checks (Step 6.3)

For any fix that tightens an invariant on stored data, answer in the finding:

1. **Can violating rows already exist?** Write the SELECT that would count them, e.g.
   `SELECT lower(email), count(*) FROM users GROUP BY lower(email) HAVING count(*) > 1;`
2. **Does the normalizing migration collide with an existing constraint?** (Lowercasing into a
   case-sensitive unique collides on existing duplicate pairs → dedup plan required first.)
3. **What enforces the invariant after the fix?** App code alone is not enforcement — the final
   step is a constraint or functional unique index in the schema.
4. **Cross-service:** do other services write this table? A constraint added under them is a
   coordination event — record it in Blast Radius.

## Empirical harness

Against a dev database only (devstack/docker), never production:

```bash
psql "$DEV_DB_URL" -c "SELECT 'prod-data' ILIKE 'prod_data';"        # t — wildcard demo
psql "$DEV_DB_URL" -c "EXPLAIN SELECT * FROM users WHERE lower(email) = 'x';"  # index used?
sqlite3 :memory: "SELECT 'A' = 'a', 'A' LIKE 'a';"                   # 0|1 — collation surprises
```
