# DPDP Technical Readiness Report

> VibeDoctor DPDP output is a technical readiness / engineering-risk assessment. It is not legal advice and not a DPDP compliance certification.

## Scores (technical readiness — not legal compliance)

| Metric | Value |
| --- | --- |
| DPDP technical posture (not legal compliance) | 49/100 |
| Evidence completeness (technical observability) | 39% |

## Control status counts

- Verified: 2
- Violated: 4
- Partial: 7
- Unresolved: 15
- Needs context: 4
- Not observed: 19
- Not applicable: 2
- Skipped: 0
- Human-review: 4

## Personal-data map summary

- Categories: email (1), llm_prompt_embedding (4), other_personal (2)
- Stores: 0
- External recipients: llm, llm, llm, llm, llm, llm, llm, llm, llm, analytics, llm, analytics, analytics, analytics, analytics, analytics, analytics, analytics, analytics, llm, analytics, llm, analytics, llm, analytics, llm, analytics, analytics, analytics, analytics
- Graph: 243 nodes, 16 edges

## Fix next

### DPDP-SEC-002 — PII in LLM prompts or embeddings

- Severity: critical
- Remediation: Minimise/redact PII before model calls; document processor terms for AI vendors.

### DPDP-CHILD-002 — Guardian / parental consent flow

- Severity: critical
- Remediation: Implement verifiable parental/guardian consent before processing children's data.

### DPDP-SEC-001 — PII in application logs

- Severity: high
- Remediation: Redact or structure-log with allowlists; never log raw identifiers.

### DPDP-SEC-007 — Hardcoded production personal data or sensitive fixtures

- Severity: high
- Remediation: Replace with clearly synthetic fixtures; never commit production personal data.

### DPDP-CHILD-001 — Children's data processing signals

- Severity: high
- Remediation: Implement verifiable age assurance and restrict tracking/ads for children as required.

### DPDP-CONSENT-001 — Consent capture implementation

- Severity: medium
- Remediation: Implement explicit consent capture with purpose binding before processing.

### DPDP-WITHDRAW-001 — Consent withdrawal path

- Severity: medium
- Remediation: Provide a withdrawal API/UI that is as easy as giving consent and propagates to processors.

### DPDP-ERA-001 — Erasure / account deletion path

- Severity: medium
- Remediation: Implement verified erasure including backups/processors within stated timelines.

### DPDP-CONSENT-002 — Consent metadata completeness

- Severity: low
- Remediation: Store consent_given_at, purpose_id, and notice_version with each consent record.

### DPDP-XBR-001 — Cross-border or external-service technical signals

- Severity: low
- Remediation: Document transfer destinations and align with permitted geographies / conditions.

## Review queue

- **DPDP-REQ-001** (developer): How is Data Principal identity verified for rights requests?
- **DPDP-APP-002** (legal): Is the organisation a Data Fiduciary under DPDP for this processing?
- **DPDP-PROC-002** (legal): Do contracts bind processors to fiduciary instructions and security?
- **DPDP-SDF-001** (legal): Has the organisation been notified/designated as a Significant Data Fiduciary?
- **DPDP-XBR-001** (legal): Which jurisdictions receive personal data in production?
- **DPDP-ERA-001** (operations): How are backups and processor copies erased after a request?
- **DPDP-CHILD-001** (product): Does the service knowingly process children's personal data?
- **DPDP-CONSENT-001** (product): Is consent free, specific, informed, unconditional and unambiguous?
- **DPDP-CONSENT-002** (product): Who is the system of record for consent proofs?
- **DPDP-NOTICE-002** (product): Does notice describe purposes, rights, and grievance contact clearly?
- **DPDP-WITHDRAW-001** (product): Can a Data Principal withdraw consent as easily as they gave it?

Legal source version: 2025.2-final-corrigendum

