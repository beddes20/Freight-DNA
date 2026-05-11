# Customers Tab — Product One-Pager

**Authored:** 2026-05-11. Product intent only — no implementation plan.

---

## 1. Tab purpose

**Who it's for:** sales reps (primary), sales managers and directors (secondary), national account managers and admins (oversight).

**What job it does in the Freight-DNA OS:** the Customers tab is the rep's *book-of-business view*. It answers, in one screen: "what accounts are mine, what's the state of each one, and what should I do next?" Every other tab — Quote Requests, Top Opportunities, Tasks, Touchpoints, AI Hub — is downstream of the trust this tab establishes.

**How it's different from a generic CRM customer list:**
- It's filtered by **ownership** by default, not by recent activity. A rep sees their book — not "every company in the database."
- It excludes **email-derived stub companies** by default so the list reflects real customers, not noise from inbound email parsing.
- It's wired into Freight-DNA's freight signals (RFP, lane, financial uploads) — a row isn't just a name and a phone number, it's a customer with shipping behavior attached.
- Ownership and lifecycle are **honest**: soft-deleted contacts hide, the right rep is shown, and "Unknown user" is a real fallback when attribution is genuinely lost — never a silent guess.

---

## 2. Core workflows

A rep should be able to do all of these from the Customers tab without going elsewhere:

- **See my book** — open the tab, instantly see only the accounts I own, sorted in a way that surfaces the ones that matter today.
- **Open a customer profile** — one click into a profile that shows contacts, recent touchpoints, recent quotes, freight history, and the safety / freshness pills from Task #1109.
- **Add or edit a contact** — through the UI (never SQL), with soft-delete that's reversible.
- **Promote an email-derived stub** — when a real customer accidentally got auto-created from an inbound email, the rep can flip it to a real customer (or merge) without admin help.
- **Hand off / transfer ownership** — when a customer moves between reps, ownership changes through a real, audited write path that updates everything downstream (quotes attribution, NBA, leaderboards).

**Never behaviors** — things this tab should not become:
- A dump of every company anyone in the org has ever emailed.
- A place where a rep silently sees another rep's accounts.
- A list that hides data by accident (e.g. soft-deleted contacts that look like the customer has no contacts at all).
- A surface that shows "Unknown user" when the actual rep is known and reachable.
- A bulk-edit power tool — destructive ownership changes belong in admin surfaces, not here.

---

## 3. Trust & guardrails

**Ownership** (per the CQ stability contract + Task #1126 lifecycle work): every company has an `ownerRepId`. A rep sees their book by joining the Customers list against `ownerRepId = me`. Managers / directors / national account managers can see across reps, but the *default* view is always scoped — never "everyone's customers." When the owner has been soft-deleted, the surface honestly says "Unknown user" rather than guessing — that's the Task #1126 / #1140 attribution-honesty rule, and it matters because a misleading rep name on a row erodes trust faster than an honest blank.

**Email-derived companies** (Task #1095): the inbound email pipeline auto-creates `companies` rows when a quote arrives from an unknown sender. Those rows get `is_email_derived = true`, an `email_derived_at` timestamp, and a `email_derived_seed_message_id`. The default `GET /api/companies` filter **excludes** them — the Customers tab uses `data-testid="toggle-show-email-derived"` to opt back in when admins need to triage. This separation is what keeps the list a "real customers" list instead of an "everyone who ever emailed us" list.

**Why mis-display bugs matter:** when a rep opens this tab and sees the wrong owner, a missing contact, a duplicated quote, or a stub company posing as a real customer, they stop trusting the entire app — not just this tab. They go back to spreadsheets. That's the failure mode that triggered the 2026-05 incident: pre-restore, accounts like Armstrong World Industries and MASONITE MEXICO were attributed to the wrong rep, and reps lost confidence in the entire customer surface. The Customers tab is the system's trust anchor; if it lies, nothing else gets used.

---

## 4. Definition of GREEN

I'll call this tab GREEN when **all** of the following are true at the same time:

**Functional (workflows):**
- I can open the tab and see my book — no other rep's accounts mixed in.
- I can open any customer profile and see contacts, recent touchpoints, recent quotes, and freight signals without a single "loading forever" or "data unavailable" surface.
- I can add a contact, edit a contact, soft-delete a contact, and restore one — all from the UI.
- I can promote or merge an email-derived stub without filing a ticket.
- Ownership transfer through the UI updates everything downstream (quotes, NBA, leaderboards) in one shot.

**Trustworthy (ownership, email-derived):**
- The default list excludes email-derived stubs and matches what `is_email_derived = true` says in the DB — no heuristic-mode crutch needed (Phase 2 backfill done).
- Every row's owner column shows the right rep, or honestly shows "Unknown user" — never the prior-bug wrong rep, never an empty cell.
- Soft-deleted contacts never appear in active lists, and restored contacts come back with the right attribution.
- Zero duplicate-row regressions in the underlying quote pipeline over the last 7 days (i.e. the `7f577c98` race fix is sustained).

**Ready to demo to another brokerage:**
- I can hand the laptop to a broker I've never met, point at this tab, and have them grasp "this is your book, here's what to do next" within 30 seconds.
- Nothing on screen requires a verbal disclaimer ("ignore the orange pill, that's a bug") — every label is honest about what it knows.
- A rep at the demo brokerage could log in, see only their book, and recognize their own customers — not a sea of stubs and someone else's accounts.

When all three blocks are true, Customers is GREEN. Until then, it's the gate that keeps everything downstream from being trusted.
