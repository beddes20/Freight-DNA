# ADR 0007 — Outbound quality scores

**Status:** Accepted (Task #943, Tier 2.4) — diagnostic only
**Date:** 2026-05-01
**Owners:** Email Intelligence working group

## Context

Email quality (clarity, tone, value-add, objection-handling) is the single biggest difference between high-performing reps and the rest. Today there is no objective measurement of outbound mail quality — managers eyeball threads in the shared inbox and make qualitative calls.

## Decision

Add `email_outbound_quality_scores` — one row per outbound rep message — populated by a heuristic-first grader. Each row carries:

* `clarity_score` 0–100: based on length, sentence count, hedge-word density, ask explicitness.
* `tone_score` 0–100: greeting + close + politeness markers + absence of all-caps / multiple `!`.
* `value_add_score` 0–100: presence of rate / lane data / capacity insight / offer of help.
* `objection_handling_score` 0–100: presence of acknowledgment + reframe markers when the prior inbound carries objection / pricing-pushback intent.
* `overall_score` — weighted blend (`0.3·clarity + 0.2·tone + 0.3·value_add + 0.2·objection_handling`).
* `features` — JSONB diagnostic dump (the matched markers).
* `grader_version` — bumped when the heuristic changes; old rows stay queryable.

The grader is **diagnostic only**. It NEVER blocks sends or modifies drafts. Coaching reads roll-ups through the adapter; the rep's compose modal does not display the score.

## Idempotency / dedup strategy

Unique on `(message_id)`. One score per outbound message; re-grading replaces the previous row (the row id stays stable, only the scoring columns change).

## Downstream consumers

* `EmailFactsAdapter.getQualityScoresForRep(orgId, repUserId, sinceDays)` returns the score series for the manager view.
* `EmailFactsAdapter.getQualityScoresForAccount(orgId, accountId, sinceDays)` returns the per-account series for the account review.
* Coaching surfaces per-rep `medianOverallScore`, `valueAddTrend`, and `objectionHandlingTrend` widgets.

## Outcome feedback

We deliberately do not back-propagate "won = good email, lost = bad email" — the signal-to-noise ratio is too low. Future revisions can add a calibrated learning loop; v1.5 ships the score, not the loop.

## Non-goals

* Real-time grading on the compose path.
* LLM-only grading (we want deterministic, cheap, fast scoring; LLM is a future revision under a new `grader_version`).
* Blocking or auto-rewriting rep drafts.
