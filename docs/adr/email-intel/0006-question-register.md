# ADR 0006 — Question register

**Status:** Accepted (Task #943, Tier 2.3)
**Date:** 2026-05-01
**Owners:** Email Intelligence working group

## Context

Customers ask explicit questions in inbound mail ("can you do drop trailers?", "what's your rate to Phoenix?"). Some go unanswered for days while reps focus on other accounts. There is no system today that catalogs "open customer questions waiting on us."

## Decision

Add `email_questions` — one row per `(message_id, question_text)` — populated by a sentence-level question detector on inbound mail. Each row carries:

* `asked_by_email` — sender of the inbound message.
* `question_text` — verbatim question (pruned of greeting/sign-off boilerplate).
* `status` ∈ `unanswered | answered | stale`.
* `answered_at` / `answered_by_message_id` — populated when a rep reply lands on the same thread.
* `time_to_answer_sec` — computed from the inbound `provider_sent_at` to the outbound reply's `provider_sent_at`.

The detector segments the message into sentences via simple punctuation rules, then keeps any sentence that ends in `?` OR begins with an interrogative lead (`can you`, `could you`, `what is`, `what's`, `do you`, `does …`, `is there`, `are there`, `how do`, `how much`, `when can`, `where can`, `who is`, `why is`).

## Idempotency / dedup strategy

Unique on `(message_id, question_text)`. The same question text inside the same message — vanishingly unlikely — would dedup naturally.

## Downstream consumers

* `EmailFactsAdapter.getUnansweredQuestionsForRep(orgId, repUserId)` powers a "questions waiting on you" panel in the conversations inbox.
* `EmailFactsAdapter.getQuestionsForAccount(orgId, accountId)` powers an account-level "open questions" widget.
* Coaching surfaces per-rep `questionAnswerRate` and `medianTimeToAnswer` aggregates.

## Outcome feedback

* On every outbound rep reply landing on a thread, the question detector marks all open questions on that thread as `answered` and stamps `answered_by_message_id`.
* The daily sweep flips questions older than 7 days to `stale` (still tracked, but excluded from the live "waiting" panels to avoid permanent inbox debt).

## Non-goals

* Determining whether the rep answer actually addressed the question (semantic verification). The simple "rep replied" heuristic is good enough for v1.5.
* Capturing rhetorical questions in rep mail.
