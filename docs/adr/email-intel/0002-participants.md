# ADR 0002 — Email participants + stakeholder graph

**Status:** Accepted (Task #943, Tier 1.2)
**Date:** 2026-05-01
**Owners:** Email Intelligence working group

## Context

`email_messages.fromEmail / toEmail / ccEmail` are flat strings. Reps want to know "who at Acme Foods has talked to us this quarter, who has gone silent, and who is new." Today that question requires expensive `LIKE` queries across the body and recipient strings of every message in a thread, with no role information (sender vs. cc) preserved.

## Decision

Add `email_participants` — one row per `(message_id, email_address, role)` — populated synchronously when an email message lands. Role is one of `from | to | cc | bcc | reply_to`. We persist:

* `display_name` from the parsed RFC 5322 address ("Jane Doe <jane@acme.com>").
* `is_internal` — true when the address ends in an org-managed domain.
* `contact_id` / `company_id` — best-effort entity resolution at insert time.
* `message_sent_at` — copied from the message so per-thread queries don't need a join to bucket activity.

A backfill helper `backfillEmailParticipants(orgId, sinceDays)` re-derives rows from existing `email_messages`. Backfill batches in 500-row chunks and is idempotent.

## Idempotency / dedup strategy

Unique on `(message_id, email_address, role)`. The same address appearing in both the `to` and `cc` of the same message yields two rows (one per role) — that is intentional; reps reading a thread care which role someone played.

## Downstream consumers

* `EmailFactsAdapter.getParticipantsForThread(orgId, threadId)` returns the deduped roster for the message detail card.
* `EmailFactsAdapter.getStakeholderGraphForAccount(orgId, companyId)` rolls up by `email_address` with last-seen, message count, and active/silent/churned status:
  * `active` — message in the last 30 days.
  * `silent` — last message 30–90 days ago.
  * `churned` — last message > 90 days ago.
* `accountContactCaptureService` already creates staged `account_contact_suggestions` for new addresses; the new graph helps it prioritize suggestions whose addresses appear in `from` or `to` (not just `cc`).

## Outcome feedback

When a participant graduates from a staged suggestion to a confirmed contact, the participants table gets its `contact_id` linked via a one-shot reconcile that runs in the suggestion accept path — no schema change, no overwrite of curated contact data.

## Non-goals

* Replacing `email_messages.toEmail` etc. The flat strings stay for legacy compatibility.
* Cross-message identity resolution (e.g. recognizing `jane@acme.com` and `j.doe@acme.com` as the same person). That belongs to the `account_contact_suggestions` flow.
