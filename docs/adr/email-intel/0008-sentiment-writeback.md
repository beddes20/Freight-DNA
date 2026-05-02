# ADR 0008 — Sentiment writeback

**Status:** Accepted (Task #943, Tier 2.5)
**Date:** 2026-05-01
**Owners:** Email Intelligence working group

## Context

`contact_sentiment_tracking` exists in the schema but is largely unpopulated — historical sentiment work left it stubbed. v1.5 turns the relationship signals carried in inbound mail into a smoothed, queryable per-contact sentiment score so coaching, account reviews, and at-risk alerts can read the trend without scraping JSONB.

## Decision

Reuse the existing `contact_sentiment_tracking` table; do not introduce a new one. The writeback service:

1. Computes a per-message sentiment score 0–100 using a deterministic positive/negative lexicon with intensifier handling. (No LLM for v1.5 — deterministic + cheap is good enough for trend detection.)
2. On insert of a new inbound message linked to a `contact_id`, upserts the contact's sentiment row. The smoothed score is `0.7 · existing + 0.3 · new` once at least 3 historical messages exist; the first 3 messages average naively.
3. `sentiment_trend` is computed from the slope of the last 5 scores — `improving | stable | declining`.
4. The `signals` JSONB on the row records the most recent message id + score for evidence.

## Idempotency / dedup strategy

The writeback uses `analysis_date` to detect "already processed for this message" — the upsert key is `(org_id, contact_id)` with the latest analysis_date acting as the high-water mark. Replayed message ingestion that re-runs the writeback for an already-processed message is a no-op.

## Downstream consumers

* `EmailFactsAdapter.getSentimentForContact(orgId, contactId)` returns the smoothed score + trend.
* `EmailFactsAdapter.getSentimentTrendForAccount(orgId, companyId)` aggregates contact sentiment for the account banner.
* The relationship-coaching engine reads declining trends as an at-risk signal.

## Outcome feedback

* Closed-lost outcomes back-stamp the responsible contact's `signals.lossLanguage` for evidence.
* Closed-won outcomes back-stamp `signals.winLanguage` similarly.

## Non-goals

* LLM-based sentiment (a future revision can wire one in behind a `analyzer_version` field).
* Cross-channel sentiment (calls, chat). v1.5 is email-only.
* Modifying the existing schema; we only write into existing columns.
