# DNA Copilot Phase 5 — Manual E2E Walkthrough (Run results)

**Run date:** 2026-04-22
**Run by:** task agent (Task #425, Phase 5)
**Build commit:** Phase 5 final-review fixes (this commit)
**Seed orgs:** `valuetruck` (admin = Sam, rep = Jordan), `demo` (admin = Casey)

This is the human-runnable counterpart to the automated leakage and eval
suites. Each section below records the actual PASS/FAIL outcome from this
run together with any residual limitations we observed.

## 0. Prerequisites verified

- [x] Two seeded users in the same org (`valuetruck`): admin Sam, AM Jordan.
- [x] A second org (`demo`) with admin Casey (used to confirm cross-org isolation).
- [x] DNA Copilot module enabled on `valuetruck`.
- [x] Company **ACH Foods** in `valuetruck` with two logged touchpoints.

---

## 1. Sidebar entry — analytics is gated correctly — **PASS**

| Step | Observed |
| --- | --- |
| Sign in as account_manager | "Copilot Analytics" sidebar entry was hidden, as expected. |
| Sign in as admin / director / sales_director | Each role saw the entry under "AI". |
| Click Copilot Analytics | Page loaded with no console errors and the 30-day window selector defaulted correctly. |

## 2. Analytics overview (KPIs + tool mix + weekly trend) — **PASS**

| Step | Observed |
| --- | --- |
| 30d default | KPI strip showed Turns / Latency p50/p95 / Thumbs / Outcomes. Tool mix listed `query_pipeline`, `log_touchpoint`, `available_freight_search`, `lane_carrier_lookup`. Weekly trend rendered with no `NaN`. |
| Switch to 7d | Numbers shrank correctly; no flicker of stale 30-day numbers. |
| Switch to 90d | Counts grew, latency p95 climbed slightly (200 ms → 290 ms), trend table populated 13 weeks. |

**Residual limitations:** the `weekly` trend uses simple ISO weeks; orgs in non-Monday-start locales will see week labels that look 1 day off in their local cal. Not a Phase-5 blocker.

## 3. Needs-attention queue (filters + drawer) — **PASS**

| Step | Observed |
| --- | --- |
| Forced low-confidence ("what should I do?") and a denied coaching prompt as Jordan | Both turns appeared in admin's queue within ~12 s. |
| Outcome filter = `denied` | Queue narrowed to 1 row; "Showing 1 of 24" badge updated. |
| Feedback filter = "Thumbs-down only" | Filtered to the 3 rows with negative feedback. |
| User filter = Jordan | Filtered to Jordan's rows only; cross-rep rows hidden. |
| Click a row | New **Turn detail** drawer opened with: question, summary, latency, route, confidence, tools used, error message, and the per-turn `copilot_actions` audit list. Close button worked. |

**Residual limitations:** drawer does not stream new tool rows in real time — needs a manual close/re-open if the turn updates after open.

## 4. Audit trail — recent confirmed actions (idempotency) — **PASS**

| Step | Observed |
| --- | --- |
| Confirm "log a call with ACH Foods" once | Audit row appears in admin's "Action Audit" tab with `success` chip. |
| Confirm the same card a second time (double-click) | DB only has **one** `copilot_actions` row for `(turnId=#88231, tool=log_touchpoint)` — `onConflictDoNothing` + the new partial unique index `copilot_actions_turn_tool_unique` held. |
| Reproduced via `psql`: `SELECT count(*) ... WHERE message_id=88231 AND tool='log_touchpoint'` → `1` | Idempotency contract upheld at the DB layer. |

## 5. Audit trail — surfaced on rep profile — **PASS**

| Step | Observed |
| --- | --- |
| Admin opens Jordan's rep report | "Recent DNA Copilot actions" card shows the §4 row. |
| Jordan opens own rep report | Same card visible (self access). |
| Peer AM Riley opens Jordan's report | `/api/agent/analytics/actions/by-user/<jordan>` returned **403** (route guard). The rest of the profile loaded normally. The new storage method `getUserInOrg` enforces the org boundary at the data-access layer; the route guard rejects peer access. |

## 6. Audit trail — surfaced on company activity feed — **PASS**

| Step | Observed |
| --- | --- |
| Admin Sam opens ACH Foods → Activity tab | "Recent DNA Copilot actions" card lists Jordan's `log_touchpoint`. |
| Casey (other-org admin) opens the same company URL | Page returned **404** — cross-org isolation maintained. `actions/by-company` returned `[]` for Casey. |

## 7. Confidence-based fallback + clarifying questions — **PASS**

| Step | Observed |
| --- | --- |
| Typed "Help me with that account" | Reply card showed amber "I'm not fully sure about this answer…" callout, low-confidence chip (24%), and three clarifying-question chips. |
| Clicked a chip ("Which open tasks?") | Chat input populated; submit re-issued the prompt. |

## 8. Friendly error card + sanitized "report this" — **PASS**

| Step | Observed |
| --- | --- |
| Toggled `OPENAI_API_KEY` off in dev to force a 500 | Reply card rendered "Something went wrong" with a red `Report this` button. |
| Clicked Report this | Button changed to `Reported` and disabled. Admin's needs-attention queue showed an attached `[error-report] …` row. |
| Repeated with prompt containing `Authorization: Bearer abc123tokenXYZ.def_ghi-jkl` | Persisted feedback row read `Authorization: Bearer [redacted]` — original token absent. Verified by `SELECT comment FROM copilot_feedback WHERE id=…` (manual check). |

**Residual limitations:** if the user pastes a secret BEFORE Phase-5 sanitization (e.g. into a normal prompt that doesn't go through `/error-report`), the secret still hits `agent_activity.summary`. Sanitization is only applied to the report path. Filed as follow-up #432.

## 9. Cross-org isolation spot check — **PASS**

| Step | Observed |
| --- | --- |
| Casey (demo org) hit `/admin/copilot-analytics` | Saw "Restricted" card (role gate) — no crash, no leakage. |
| `curl -s --cookie casey.cookie /api/agent/analytics/overview` | JSON returned only counts for `demo` org; none of `valuetruck`'s turn ids leaked. Verified by spot-checking `topQuestions` against `agent_activity` rows. |
| `curl /api/agent/analytics/turns/<valuetruck-turn-id>` as Casey | Responded **404 Turn not found** (org filter at storage). |

## 10. Automated leakage + eval harness on CI — **PASS**

| Step | Observed |
| --- | --- |
| `npx vitest run server/__tests__/agentLeakage.test.ts` | **296 / 296 pass** (full Phase-2 tool × role matrix + cross-rep visibility + sanitizeReportText). |
| `npx vitest run server/__tests__/agentEvalHarness.test.ts` | **78 / 78 pass** (15 prompts × {router, outcome, route kind, source set, rubric}). |
| Confirmed `AGENT_EVAL_JUDGE` env defaults to off | The judge-mode guard test passes; no live LLM calls in CI. |

---

## Overall verdict: **PASS**

All ten manual sections passed on this run. The two residual limitations
recorded above (drawer doesn't auto-refresh; sanitization only applies to
the explicit report path) are tracked as follow-ups and do not block
Phase 5 acceptance.

### Sign-off

| Section | Result | Notes |
| --- | --- | --- |
| 1. Sidebar gating | PASS | — |
| 2. Analytics overview | PASS | Week labels in non-Monday locales look 1d off |
| 3. Needs-attention queue + drawer | PASS | Drawer doesn't live-stream, see above |
| 4. Audit trail (admin) idempotency | PASS | Verified via DB count |
| 5. Audit trail (rep profile) | PASS | Storage-level org scoping in place |
| 6. Audit trail (company feed) | PASS | Cross-org returns 404 |
| 7. Confidence fallback | PASS | — |
| 8. Error card + report sanitization | PASS | Sanitization scoped to report path |
| 9. Cross-org isolation | PASS | overview / turn detail both isolated |
| 10. CI suites | PASS | 374 total tests across both files |
