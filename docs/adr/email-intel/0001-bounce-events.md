# ADR 0001 — Email bounce / DSN / OOO events

**Status:** Accepted (Task #943, Tier 1.1)
**Date:** 2026-05-01
**Owners:** Email Intelligence working group

## Context

The v1 pipeline classifies inbound mail into 23 intents but treats SMTP bounce notifications, mailer-daemon DSNs, and Microsoft Exchange auto-replies as plain `email_messages` rows. Downstream NBA generators happily fire follow-ups at addresses we already know are dead, and reps end up wasting cycles chasing contacts who are on PTO. We need a first-class fact that says "this address is bad / on leave" so consumers can suppress automation without scraping JSONB.

## Decision

Add a dedicated `email_bounce_events` table populated by a deterministic classifier that runs in the email ingestion pipeline. Each row records:

* `message_id` + `contact_email` — unique key. Replayed webhooks dedupe naturally.
* `bounce_type` ∈ `hard_bounce | soft_bounce | auto_reply_ooo | auto_reply_other`.
* `diagnostic_code` — extracted from the DSN body (e.g. `5.1.1` for unknown user).
* `ooo_until` — parsed from common Out-of-Office reply phrasing.
* `alternate_contact_email` / `alternate_contact_name` — captured from OOO bodies that name a covering contact.
* `raw_headers` — for forensic review.

The classifier is heuristic and pure — no LLM call. It looks at:

1. From-address prefixes (`mailer-daemon@`, `postmaster@`, `microsoftexchange...`).
2. Subject keywords (`undeliverable`, `delivery status notification`, `out of office`, `automatic reply`).
3. DSN body markers (`5.x.x` / `4.x.x` SMTP status codes, `Status:` line in RFC 3464 envelopes).
4. OOO body markers (`out of (the )?office`, `i'?m? (currently )?(out|away)`, `until`).

## Idempotency / dedup strategy

Unique on `(message_id, contact_email)`. The classifier writes one row per affected recipient. Because the upstream `email_messages` insert is itself idempotent on `(org_id, provider_message_id)`, replayed Graph webhook deliveries cannot produce duplicate bounce rows.

## Downstream consumers

* `EmailFactsAdapter.isContactSuppressed(orgId, email)` returns true when there is an active hard bounce or an unexpired OOO. NBA generators (`generateNbasFromEmailSignals`, `generateAccountEmailNbas`) call this and short-circuit suppressed contacts with a `skipped_reason: "bounce_suppressed"` log line.
* The shared inbox surfaces a "DEAD INBOX" / "OOO until …" tag on the participant row inside the message detail card.
* Manual rep sends are NEVER blocked. The grader/coach surfaces a soft warning on the compose modal.

## Outcome feedback

When the same address subsequently sends an inbound message that is *not* a bounce / DSN / OOO, the classifier marks the most recent row as `cleared` (we treat the address as live again — the contact returned from PTO or the address came back online).

## Non-goals

* Reputation scoring across organizations (bounces stay org-scoped).
* Modifying the SMTP send pipeline. v1.5 only reads inbound mail.
