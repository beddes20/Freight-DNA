# ADR 0003 — Email attachment classifications

**Status:** Accepted (Task #943, Tier 1.3)
**Date:** 2026-05-01
**Owners:** Email Intelligence working group

## Context

Attachments are gold for fact crystallization: rate confirmations carry the actual awarded rate, PODs prove delivery, COIs prove insurance. Today only the rate-con extractor (`server/services/rateConExtractor.ts`) and the truck-list parser look at attachments, and they each make their own classification decisions. We need a single, durable record of what every attachment was, whether it was routed somewhere downstream, and what landed there.

## Decision

Add `email_attachment_classifications` — one row per `(message_id, attachment_name)` — populated by a router that runs after the message is processed for signals. The router classifies into:

* `pod`, `rate_con`, `bol`, `coi`, `msa`, `rfp_workbook` — high-value flows.
* `spreadsheet`, `image`, `document`, `generic` — fallback bins.

Routing decisions:

* `rate_con` → enqueue `extractRateCon` and write the resulting `rate_con_extraction.id` into `routed_ref_id`.
* `pod` / `bol` / `coi` / `msa` → log + persist the classification, no downstream call yet (`routed_to: "stub"`). These exist so future tasks have a canonical place to attach handlers.
* `rfp_workbook` → log + persist (RFP intake is owned by another task).
* `spreadsheet` / `image` / `document` / `generic` → log + persist.

The router is heuristic-first (filename regex + content-type), with confidence in the 60–95 range. We intentionally do not block on confidence — every attachment lands a classification row, even if `kind: "generic"` and `confidence: 30`.

## Idempotency / dedup strategy

Unique on `(message_id, attachment_name)`. The router runs once per message via the scheduler; replayed runs upsert into the same row. Rate-con extraction itself is idempotent on `(org_id, provider_message_id, attachment_name)` inside the existing extractor.

## Downstream consumers

* `EmailFactsAdapter.getAttachmentsForMessage(messageId)` returns the classifications for the inbox message detail card.
* `EmailFactsAdapter.getRateConsForLane(orgId, laneId)` joins `email_attachment_classifications` (`kind = 'rate_con'`) with `rate_con_extractions` to give the lane cockpit a "recent awarded rates from email" panel.

## Outcome feedback

The rate-con extractor's existing `applyRateConToLaneEvidence` flow is extended (Step 5 in the slot extractor) so awarded rates from email contribute to `lane_rate_history` evidence with `source: "rate_con_email"`. Pricing then learns from email-borne awarded rates without a schema change.

## Non-goals

* Replacing the rate-con extractor. We invoke it; we don't reimplement it.
* Implementing POD / BOL / COI flows in v1.5. Those are stubs that future tasks pick up.
