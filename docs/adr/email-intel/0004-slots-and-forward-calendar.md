# ADR 0004 — Email extracted slots + forward calendar events

**Status:** Accepted (Task #943, Tier 2.1)
**Date:** 2026-05-01
**Owners:** Email Intelligence working group

## Context

The intent classifier already detects categories like `pricing_request` and `objection`, but it stuffs the actual values into a JSONB grab-bag (`extractedData.targetRate`, `extractedData.competitorName`, etc.). Pricing engines, competitive watch, and forward-pipeline NBAs all need first-class, queryable values, not JSONB scraping.

## Decision

Two tables:

1. `email_extracted_slots` — one row per `(message_id, slot_name)`. Slot names are a closed enum: `target_rate`, `incumbent`, `incumbent_rate`, `competitor_name`, `rfp_date`, `contract_end_date`, `equipment`, `commodity`, `weight`, `temperature`, `transit_days`. Each row carries one of `slot_value` (text), `slot_value_numeric` (decimal), or `slot_value_date` (timestamp), plus a confidence and an evidence snippet.

2. `forward_calendar_events` — one row per `(message_id, event_type)`. Event types: `rfp`, `contract_end`, `renewal`, `follow_up_at`. Each row anchors to a `linked_account_id` / `linked_lane_id` and carries an `event_date`, status, and optional `nba_card_id` once an NBA is generated for the event.

The slot extractor runs alongside the intent classifier. It is heuristic-first (regex + canonical-rate detection from `quoteEmailIngestion`) with optional LLM fall-back for ambiguous cases. We deliberately keep slot extraction additive — the intent classifier is unchanged.

## Idempotency / dedup strategy

* `email_extracted_slots`: unique on `(message_id, slot_name)`. A second run produces the same row.
* `forward_calendar_events`: unique on `(message_id, event_type)`. Same dedup story.

## Downstream consumers

* `EmailFactsAdapter.getSlotsForThread(orgId, threadId)` returns the latest slot value per `slot_name` for the thread (most recent message wins).
* `EmailFactsAdapter.getUpcomingForwardCalendar(orgId, withinDays)` returns RFP / contract-end events the rep should prep for.
* The slot extractor writes a `competitive_signals` row whenever a `competitor_name` or `incumbent` slot lands — replacing the previously stubbed wiring.
* Won/lost outcome handlers extend `lane_rate_history` evidence with the captured competitor + rate (channel `email_competitive`).
* The scheduler queues an NBA card per upcoming `forward_calendar_event` ≤ 14 days out; the card links back to the event so subsequent dedup is trivial.

## Outcome feedback

When a forward calendar event passes (the RFP date or contract end-date), the row is flipped to `status: "passed"` and the linked NBA is closed. Won/lost outcomes flow into `lane_rate_history` so pricing learns the realized awarded rate vs. the captured target rate.

## Non-goals

* Replacing the rate band / lane scoring engine. We feed it; we don't replace it.
* Cross-account lane competitor de-duplication.
