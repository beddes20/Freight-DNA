# Email Ingestion Contract

The `processUserMailboxEmail` helper has specific logic for `PERSIST-UNKNOWN` and `TOMBSTONE-DROP` emails.

**Do NOT reintroduce `DROP-GATE` behavior** — silently dropping inbound emails from unknown senders is forbidden. Unknown senders must be persisted with null account / carrier links so they remain discoverable; they are not the same thing as noise.

Related guardrails: Sections 1094 / 1095 of `tests/code-quality-guardrails.test.ts`.
