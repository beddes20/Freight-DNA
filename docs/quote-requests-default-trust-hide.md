# Quote Requests Default-Trust Hide (2026-05-08)

The `/quote-requests` table default-hides rows whose `customerName === "Unknown — needs review"` (`UNKNOWN_CUSTOMER_NAME`).

## Implementation
- CLIENT-SIDE post-filter in `client/src/pages/quote-requests.tsx` (state `showUnknownSenders`, chip `data-testid="toggle-show-unknown-senders"`).
- The server `applyFilters` chokepoint (CQ-2 / CQ-5) is intentionally **untouched** so audit / Account-Owner-fallback callers still see those rows.

## Interaction rules
- The chip is mutually exclusive with `toggle-free-email` (which narrows TO the unknown bucket).
- The chip is forced ON when a `?drilldown=<id>` is active so KPI ↔ list parity holds.
- The `HiddenCountsDisclosure` header surfaces a `Hidden — unknown sender` bucket so reps know the chip is what's narrowing the view.

## Customer Quotes contracts touched
**NONE.**
