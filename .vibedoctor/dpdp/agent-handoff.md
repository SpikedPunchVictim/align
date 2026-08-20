# DPDP Agent Handoff

VibeDoctor DPDP output is a technical readiness / engineering-risk assessment. It is not legal advice and not a DPDP compliance certification.

## Deterministic artifacts (source of truth)

- `.vibedoctor/dpdp/data-map.json`
- `.vibedoctor/dpdp/control-matrix.json`
- `.vibedoctor/dpdp/evidence-ledger.json`
- `.vibedoctor/dpdp/review-queue.md`

## Scores

- Technical posture (not legal compliance): 49/100
- Evidence completeness: 39%

## Rules for the agent

1. Consume deterministic artifacts; do not re-implement a compliance engine.
2. Do not mark DETERMINISTIC controls as passed without matching control-matrix status.
3. Do not invent evidence.
4. Do not claim legal certification.
5. Do not calculate a separate compliance percentage.
6. Prefer the minimum human questions from the review queue, grouped by audience.
7. After code changes, re-run `vibedoctor dpdp verify`.
8. Treat legal source version `2025.2-final-corrigendum` as an offline baseline. Before interpreting current law, use the DPDP readiness-review skill to verify the latest official primary sources.
9. If current official sources cannot be verified, report `CURRENT_LEGAL_SOURCES_NOT_VERIFIED`; if they differ, report `LEGAL_SOURCE_DRIFT`. Never silently change deterministic statuses.

## Fix next (code/config first)

- **DPDP-SEC-002** [critical]: Minimise/redact PII before model calls; document processor terms for AI vendors.
- **DPDP-CHILD-002** [critical]: Implement verifiable parental/guardian consent before processing children's data.
- **DPDP-SEC-001** [high]: Redact or structure-log with allowlists; never log raw identifiers.
- **DPDP-SEC-007** [high]: Replace with clearly synthetic fixtures; never commit production personal data.
- **DPDP-CHILD-001** [high]: Implement verifiable age assurance and restrict tracking/ads for children as required.
- **DPDP-CONSENT-001** [medium]: Implement explicit consent capture with purpose binding before processing.
- **DPDP-WITHDRAW-001** [medium]: Provide a withdrawal API/UI that is as easy as giving consent and propagates to processors.
- **DPDP-ERA-001** [medium]: Implement verified erasure including backups/processors within stated timelines.
- **DPDP-CONSENT-002** [low]: Store consent_given_at, purpose_id, and notice_version with each consent record.
- **DPDP-XBR-001** [low]: Document transfer destinations and align with permitted geographies / conditions.

## Human review by audience

### developer
- DPDP-REQ-001: How is Data Principal identity verified for rights requests?

### legal
- DPDP-APP-002: Is the organisation a Data Fiduciary under DPDP for this processing?
- DPDP-PROC-002: Do contracts bind processors to fiduciary instructions and security?
- DPDP-SDF-001: Has the organisation been notified/designated as a Significant Data Fiduciary?
- DPDP-XBR-001: Which jurisdictions receive personal data in production?

### operations
- DPDP-ERA-001: How are backups and processor copies erased after a request?

### product
- DPDP-CHILD-001: Does the service knowingly process children's personal data?
- DPDP-CONSENT-001: Is consent free, specific, informed, unconditional and unambiguous?
- DPDP-CONSENT-002: Who is the system of record for consent proofs?
- DPDP-NOTICE-002: Does notice describe purposes, rights, and grievance contact clearly?
- DPDP-WITHDRAW-001: Can a Data Principal withdraw consent as easily as they gave it?

## Suggested commands

```bash
vibedoctor dpdp scan --full
vibedoctor dpdp review-queue
vibedoctor dpdp verify
```

