# AI Surface Consolidation — Decision Doc

**Task:** #702 — AI Surface Consolidation
**Engagement window:** last 30 days (queried 2026-04-27)
**Source:** `ai_engagement_events` (Task #700 — AI Engagement Instrumentation)

---

## 1. How we decided

We pulled per-surface 30-day numbers from `ai_engagement_events` and combined
them with structural reality (some "surfaces" are sub-features that live
inside another surface, so engagement on the parent already represents them).

### Thresholds

| Bucket  | Rule |
| ------- | ---- |
| **Keep**   | Has any structural justification: it is the rep's primary entry to a workflow, OR a contextual sub-surface that fires from another surface, OR has measurable engagement (≥ 1 impression / week per active rep). No behavior change; add a `<WhyThisSuggestion>` affordance. |
| **Merge**  | Substantively duplicates another surface that reps already use, AND the architecture supports relocating it (or the relocation is already partly done via redirect). The standalone route is collapsed; the content lives inside its new home. |
| **Retire** | Zero impressions for ≥ 30 days **and** structurally redundant (no unique workflow that other surfaces don't already cover). Background producer, route, page, components, sidebar entry, and tests are all removed. |

### Caveats on the data

The instrumentation pipeline (Task #700) shipped recently, and the org we
queried has only 16 events across 4 surfaces (all from a single user, all on
the same day) — far short of a meaningful sample. We therefore lean on
**structural evidence** for most decisions and explicitly call out the
surfaces where we deferred a hard "retire" call until real engagement data
accumulates. None of the kept surfaces are flagged as "definitely useful";
they are flagged as "we cannot responsibly delete this with the data we have
right now". A follow-up review (recommended in 30 days) should re-run this
exercise with real org data.

---

## 2. 30-day data snapshot

```sql
SELECT surface, event_type, COUNT(*) AS cnt, COUNT(DISTINCT user_id) AS users
FROM ai_engagement_events
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY 1, 2 ORDER BY 1, 2;
```

| Surface                | Impr. | Clicks | Accepts | Users |
| ---------------------- | ----: | -----: | ------: | ----: |
| `ai_center`            | 1     | 0      | 0       | 1     |
| `ai_intelligence_hub`  | 7     | 0      | 0       | 1     |
| `daily_priorities`     | 1     | 0      | 0       | 1     |
| `valueiq`              | 7     | 0      | 0       | 1     |
| `nba_card`             | 0     | 0      | 0       | 0     |
| `proactive_nudge`      | 0     | 0      | 0       | 0     |
| `talking_points`       | 0     | 0      | 0       | 0     |
| `health_narrative`     | 0     | 0      | 0       | 0     |
| `touchpoint_summary`   | 0     | 0      | 0       | 0     |
| `meeting_brief`        | 0     | 0      | 0       | 0     |
| `weekly_account_review`| 0     | 0      | 0       | 0     |
| `ai_email_draft`       | 0     | 0      | 0       | 0     |
| `ready_to_act`         | 0     | 0      | 0       | 0     |
| `carrier_recommendation`| 0    | 0      | 0       | 0     |
| `spot_quote_intel`     | 0     | 0      | 0       | 0     |

The zero-engagement rows almost certainly reflect "instrumentation just
shipped" rather than "nobody uses these"; see caveat above.

---

## 3. Per-surface decisions

### Keep (12)

| Surface | Where it lives | Why keep | Action |
| ------- | -------------- | -------- | ------ |
| `daily_priorities` | `client/src/pages/daily-priorities.tsx` (sidebar: AI Workspace ▸ Today's Priorities) | Top-of-sidebar landing page for the rep's NBA queue. Backed by `nba_engine`, a real producer with active workloads. | Keep. Add `<WhyThisSuggestion>` per card. |
| `valueiq` | `client/src/pages/valueiq.tsx` (sidebar: AI Workspace ▸ ValueIQ) | New AI workspace home that already absorbed the AI Intelligence Hub (see Merge). Has Threads + Library which have no equivalent elsewhere. | Keep. Add `<WhyThisSuggestion>` next to each Insights card. |
| `ai_center` | `client/src/pages/ai-center.tsx` (sidebar: AI Workspace ▸ AI Center) | Admin module — only place to manage agents, approvals, pods, adapters, personas. Distinct audience (admin/manager) from the rep-facing surfaces. | Keep. No `<WhyThisSuggestion>` (it's configuration, not a suggestion surface). |
| `nba_card` | `client/src/components/NbaCard.tsx` (rendered by Daily Priorities, Dashboard) | The atomic unit of every NBA surface; every rule-engine output. | Keep. **Already has `<WhyThisSuggestion>`** ✅ |
| `ready_to_act` | `client/src/components/NbaReadyToActPanel.tsx` (rendered inside NBA cards on demand) | Lazy outreach payload — sub-surface of the NBA card. | Keep. Inherits `<WhyThisSuggestion>` from the parent card. |
| `proactive_nudge` | `client/src/components/crm-chatbot.tsx` (persistent chatbot, fires on signal) | Single voluntary surface for proactive signals; can't be merged into a page because it's the chatbot itself. | Keep. Add `<WhyThisSuggestion>` inside the nudge bubble. |
| `talking_points` | `client/src/components/pre-call-planner.tsx` (drawer in company detail) | Contextual: only fires when a rep opens the pre-call drawer for a specific call. Not a candidate for a standalone surface. | Keep as sub-surface of pre-call planner. Add `<WhyThisSuggestion>`. |
| `health_narrative` | `client/src/components/pre-call-planner.tsx` (same drawer) | Sub-section of the pre-call drawer. | Keep. Add `<WhyThisSuggestion>`. |
| `touchpoint_summary` | `client/src/components/pre-call-planner.tsx` (same drawer) | Sub-section of the pre-call drawer. | Keep. Add `<WhyThisSuggestion>`. |
| `meeting_brief` | `client/src/pages/ai-intelligence.tsx` (now embedded inside ValueIQ Insights) | Already structurally absorbed into ValueIQ. The standalone Hub got merged (see Merge below) so this is now a sub-feature. | Keep as sub-surface of ValueIQ Insights. Add `<WhyThisSuggestion>` on the brief card. |
| `weekly_account_review` | `client/src/pages/company-detail/tabs/AccountReviewsTab.tsx` (account-detail tab) | Lives inside the customer record where it's most relevant; not a candidate for its own page. | Keep as sub-surface of the company detail. Add `<WhyThisSuggestion>` on each review row. |
| `ai_email_draft` | `client/src/components/DraftEmailModal.tsx` (modal, fires from many surfaces) | Cross-cutting outbound utility — used from LWQ, outreach, NBA cards, conversations. Can't be a page; can't be retired without removing email AI entirely. | Keep. Add `<WhyThisSuggestion>` next to the draft body explaining what data shaped the draft. |

### Merge (1)

| Surface | Old home | New home | Action |
| ------- | -------- | -------- | ------ |
| `ai_intelligence_hub` | `/ai-intelligence` (page `client/src/pages/ai-intelligence.tsx`) | `/valueiq?tab=insights` (the page is rendered as the Insights tab) | The redirect already exists in `App.tsx`. **The leftover** `/ai-intelligence-legacy` **escape-hatch route bypasses the merge and undermines the consolidation** — retire that route. The page component itself stays (it's imported by `valueiq.tsx`). The instrumentation `surface` string `ai_intelligence_hub` is left in place because it's still the natural label for the embedded view's events. Continue treating it as a sub-surface of `valueiq` for analytics. |

### Retire (1)

| Item | Why retire | Action |
| ---- | ---------- | ------ |
| Route `/ai-intelligence-legacy` (registered in `App.tsx:263`) | The merge to ValueIQ Insights is complete; this back-door route gives admins a way to bypass the merge. Zero impressions in 30d (callers route through ValueIQ). | Remove the `<Route path="/ai-intelligence-legacy" …>` registration. Add a Playwright test that confirms the path 404s. The Hub page **component itself stays** — it's still rendered inside ValueIQ. |

### Deferred — re-evaluate in 30 days

These surfaces showed zero engagement in the window, but the engagement
pipeline is too new to call them dead. They stay in place for now and get a
`<WhyThisSuggestion>` affordance like every other kept surface. A follow-up
audit should re-run this exercise once the org has 30 days of real activity.

- `carrier_recommendation` — produced by `carrierRecommendationEngine`, surfaced inside Carrier Hub & Available Loads. Wait for procurement-rep activity.
- `spot_quote_intel` — registered for spot-quote workflows; engagement instrumentation point may still need to be wired into the spot-quote search UI (not in scope here).

If, in 30 days, both still show zero impressions across all users in any
real org, both should move to **Retire** in a follow-up consolidation pass.

---

## 4. Implementation plan (post-approval)

1. **Retire the `/ai-intelligence-legacy` route.**
   - Delete the `<Route path="/ai-intelligence-legacy" component={AIIntelligencePage} />` line from `client/src/App.tsx`.
   - Update the comment in `client/src/components/app-sidebar.tsx` that mentions the legacy path.
2. **Add `<WhyThisSuggestion>`** to the kept surfaces that don't have one yet:
   - Daily Priorities buckets (one per surfaced NBA card group — already covered by NbaCard, but the bucket headers get a tiny "Why these?" link tied to the rule label).
   - ValueIQ Insights cards (rendered by the embedded `AIIntelligencePage`).
   - Pre-call planner drawer: talking points, health narrative, touchpoint summary.
   - Company-detail Account Reviews tab.
   - DraftEmailModal.
   - CRM chatbot proactive nudge bubble.
3. **Smoke tests (Playwright):**
   - `/daily-priorities`, `/valueiq`, `/ai`, `/admin/ai-engagement` all render their primary heading.
   - `/ai-intelligence` redirects to `/valueiq?tab=insights`.
   - `/ai-agent` redirects to `/ai/admin`.
   - `/ai-intelligence-legacy` returns 404 (or hits the app's NotFound route).
4. **`replit.md`** — add a one-paragraph note under "AI Intelligence Hub" describing the consolidation.
5. **Admin changelog entry** — `docs/ai-surface-consolidation-changelog.md` summarising what was kept / merged / retired (1-page, admin-readable).

## 5. What we are explicitly NOT doing

- Not building any new AI surface.
- Not deleting any background producer (`nbaEngine`, `carrierRecommendationEngine`, `proactiveOpportunityService`, `emailIntelligence`) — none of the surfaces they feed are being retired.
- Not deleting `client/src/pages/ai-intelligence.tsx` — it is still used (embedded in ValueIQ).
- Not deleting `client/src/pages/ai-agent.tsx` — it is still used (rendered as the Admin tab inside AI Center).
- Not changing LLM prompts or model selection.
- Not removing the engagement instrumentation; it's the data we'll need for the next consolidation pass in 30 days.
