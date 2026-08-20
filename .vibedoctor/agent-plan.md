# VibeDoctor Agent Plan

Goal: Recover incomplete checks before changing code, then improve validated findings.

Target: generic

## Workflow

1. scan
2. validate completeness
3. recover tools
4. plan
5. safe fix
6. edit carefully
7. verify
8. scan again
9. summarize

## Recover before editing

- vitest: `vibedoctor tool retry vitest`
  Success: vitest completes with status ok.
  If it fails: Keep the scan partial, disclose missing vitest coverage, and request human review before risky changes.
- biome: `vibedoctor setup --include recommended`
  Success: biome is installed and completes on the next scan.
  If it fails: Install with: npm install -D @biomejs/biome, then rerun the scan; otherwise disclose missing biome coverage.
- jscpd: `vibedoctor setup --include recommended`
  Success: jscpd is installed and completes on the next scan.
  If it fails: Install with: npm install -D jscpd, then rerun the scan; otherwise disclose missing jscpd coverage.
- knip: `vibedoctor setup --include recommended`
  Success: knip is installed and completes on the next scan.
  If it fails: Install with: npm install -D knip, then rerun the scan; otherwise disclose missing knip coverage.
- lizard: `vibedoctor setup --include recommended`
  Success: lizard is installed and completes on the next scan.
  If it fails: Install Lizard with: pipx install lizard, uv tool install lizard, or your OS package manager, then rerun the scan; otherwise disclose missing lizard coverage.
- presidio: `vibedoctor setup --include recommended`
  Success: presidio is installed and completes on the next scan.
  If it fails: Install Presidio in the project environment: python -m pip install presidio-analyzer, then rerun the scan; otherwise disclose missing presidio coverage.
- semgrep: `vibedoctor setup --include recommended`
  Success: semgrep is installed and completes on the next scan.
  If it fails: Install Semgrep with: pipx install semgrep, uv tool install semgrep, or your OS package manager, then rerun the scan; otherwise disclose missing semgrep coverage.

## Allowed actions

- edit source files
- add tests
- run safe fixes

## Forbidden actions

- disable tests
- lower thresholds
- delete low-confidence dead code
- upgrade dependencies
- change public APIs without approval

## Rules

- Fix blockers before cleanup work.
- Do not delete low-confidence dead code.
- Do not refactor large files without tests.
- Do not lower test, lint, security, or coverage thresholds.

## What not to trust blindly

- Do not assume biome was fully checked because the tool was skipped.
- Do not assume jscpd was fully checked because the tool was skipped.
- Do not assume knip was fully checked because the tool was skipped.
- Do not assume lizard was fully checked because the tool was skipped.
- Do not assume presidio was fully checked because the tool was skipped.
- Do not assume semgrep was fully checked because the tool was skipped.
- Do not treat the health score as complete because vitest failed.

## Task 1: GHSA-28wg-ghj8-5hjv

Instructions:
1. nanoid@3.3.15 (transitive dependency): nanoid: non-secure generators can loop indefinitely with negative size Fixed in 3.3.16.
2. Upgrade nanoid to 3.3.16 or later, then rerun tests.
3. Do not change public behavior unless required.

Do not touch:
- Do not change public APIs without approval.

Verify:
- pnpm test
- vibedoctor scan --changed --report json

## Task 2: GHSA-2v37-7h3g-55p8

Instructions:
1. nanoid@3.3.15 (transitive dependency): nanoid: custom generators can loop indefinitely when size is zero Fixed in 3.3.18.
2. Upgrade nanoid to 3.3.18 or later, then rerun tests.
3. Do not change public behavior unless required.

Do not touch:
- Do not change public APIs without approval.

Verify:
- pnpm test
- vibedoctor scan --changed --report json

## Task 3: GHSA-7p8r-x3mc-p8w7

Instructions:
1. fast-uri@3.1.3 (transitive dependency): fast-uri vulnerable to host confusion via backslash authority introducer Fixed in 2.4.4.
2. Upgrade fast-uri to 2.4.4 or later, then rerun tests.
3. Do not change public behavior unless required.

Do not touch:
- Do not change public APIs without approval.

Verify:
- pnpm test
- vibedoctor scan --changed --report json

## Task 4: GHSA-fx2h-pf6j-xcff

Instructions:
1. vite@5.4.21 (transitive dependency): vite: `server.fs.deny` bypass on Windows alternate paths Fixed in 8.0.16.
2. Upgrade vite to 8.0.16 or later, then rerun tests.
3. Do not change public behavior unless required.

Do not touch:
- Do not change public APIs without approval.

Verify:
- pnpm test
- vibedoctor scan --changed --report json

## Task 5: GHSA-mwp4-54f8-5fhr

Instructions:
1. ip-address@10.2.0 (transitive dependency): ip-address: Address4 decodes leading-zero octets as decimal while resolvers decode them as octal, allowing SSRF and trust-boundary bypass Fixed in 10.3.1.
2. Upgrade ip-address to 10.3.1 or later, then rerun tests.
3. Do not change public behavior unless required.

Do not touch:
- Do not change public APIs without approval.

Verify:
- pnpm test
- vibedoctor scan --changed --report json
