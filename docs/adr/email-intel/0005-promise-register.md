# ADR 0005 — Promise register

**Status:** Accepted (Task #943, Tier 2.2)
**Date:** 2026-05-01
**Owners:** Email Intelligence working group

## Context

Reps make time-bound commitments in outbound mail all day ("I'll have a quote by EOD Thursday", "first thing Monday morning"). When they miss those promises, the customer notices. There is currently no system anywhere that captures a rep promise and tracks whether it was kept.

## Decision

Add `email_promises` — one row per `(message_id, promise_text)` — populated by a heuristic detector that runs on outbound rep mail. Each row carries:

* `rep_user_id` — derived from the message owner via `email_messages.fromEmail` → users mapping.
* `promise_text` — the verbatim phrase that triggered the row.
* `promise_due_at` — parsed from relative-date phrasing (reuses the helpers from `quoteEmailIngestion`).
* `status` ∈ `open | kept | broken | cancelled`.
* `resolved_at` / `resolved_by_message_id` — populated when a follow-up message lands.

The detector recognizes patterns like:

* "I'll … by (tomorrow|EOD|end of day|end of week|<weekday>)".
* "Get back to you (today|by …)".
* "Send (the|a) (quote|rate|update) (today|by …)".
* "Call you (back )?(today|tomorrow|by …)".

## Idempotency / dedup strategy

Unique on `(message_id, promise_text)`. Replays produce the same row.

## Downstream consumers

* `EmailFactsAdapter.getPromisesForRep(orgId, repUserId, status)` and `.getPromisesForAccount(orgId, accountId)` for the coaching dashboard.
* The coaching aggregator surfaces per-rep `promiseKeptRate` and `promiseBrokenCount` in the existing manager view.

## Outcome feedback (status flips)

* When a rep sends another outbound message on the same thread BEFORE `promise_due_at`, the open promise flips to `kept`. (Best-effort: we treat any meaningful rep follow-up as "kept" — false positives here are not catastrophic.)
* When `promise_due_at` passes with no rep follow-up, the daily sweep flips the promise to `broken`.
* When the customer cancels the underlying request (closed-lost), the promise flips to `cancelled`.

## Non-goals

* Detecting promises in calls or chat. v1.5 is email-only.
* Coaching the rep in real-time. The promise table is read by the coaching view; it does not block sends.
