# Preservation Plan — Work After Commit `9949c373`

**Authored:** 2026-05-08, read-only analysis. No execution.
**Companion docs:** `docs/dev-prod-schema-drift-2026-05-08.md`, `docs/prod-restore-and-republish-plan-2026-05-08.md`.
**Status:** **decision-blocking finding inside.** Read Section 4 before approving the restore target from the previous plan.

---

## 1. Commits after `9949c373` — full inventory

There are exactly **5 commits** between `9949c373` and current HEAD (`352adf50`), in chronological order:

| # | Hash | Author timestamp (UTC) | Subject | Files | LoC | Type |
|---|---|---|---|---|---|---|
| 1 | `2cbbdcc7` | 2026-05-08 16:55:53 | Update project setup instructions for new tasks | 2 | +114 | **attached_assets only** |
| 2 | `35460487` | 2026-05-08 17:06:24 | Add investigation report for deployment pipeline errors | 1 | +62 | **attached_assets only** |
| 3 | `e0d0de27` | 2026-05-08 17:45:22 | Align development database schema with production for critical tables | 1 | +62 | **attached_assets only** (despite the title) |
| 4 | `32170406` | 2026-05-08 18:06:49 | Create documentation detailing database schema differences and recovery options | 2 | +350 | docs + attached_asset |
| 5 | `352adf50` | 2026-05-08 18:18:42 | Create a plan to restore production data and redeploy code | 1 | +339 | docs only (`docs/prod-restore-and-republish-plan-2026-05-08.md`) |

### Specific file changes

```
2cbbdcc7  Update project setup instructions for new tasks
  + attached_assets/Pasted-You-are-helping-me-build-and-improve-Freight-DNA-inside_1778258698736.txt
  + attached_assets/Pasted-You-are-helping-me-build-and-improve-Freight-DNA-inside_1778258721676.txt

35460487  Add investigation report for deployment pipeline errors
  + attached_assets/Pasted-Freight-DNA-Publish-Pipeline-Triage-Emergency-Read-Only_1778259857722.txt

e0d0de27  Align development database schema with production for critical tables  ← misleading commit message
  + attached_assets/Pasted-1-Accept-that-dev-schema-must-move-toward-prod-Right-no_1778262186295.txt

32170406  Create documentation detailing database schema differences and recovery options
  + attached_assets/Pasted-Freeze-schema-work-focus-on-inventory-business-recovery_1778263405849.txt
  + docs/dev-prod-schema-drift-2026-05-08.md

352adf50  Create a plan to restore production data and redeploy code
  + docs/prod-restore-and-republish-plan-2026-05-08.md
```

**Important note on `e0d0de27`:** the commit message says "Align development database schema with production for critical tables" but the actual diff is **a single attached-asset text file** (your message text). No `shared/schema.ts` change, no `migrations/*.sql` change, no `server/runMigrations.ts` change, no DB call. Despite its title, this commit did not align anything — it just captured the prompt that triggered my (failed) push attempt against dev. The dev DB push attempt that *did* run produced zero changes (verified at the time and still verifiable today). **This commit is therefore safe to drop with no functional consequence.**

### Bottom line on commits

**Zero of the five commits contain runtime code or schema changes.** All are pure documentation: `attached_assets/*.txt` files (your message captures) and `docs/*.md` files. None modify `client/`, `server/`, `shared/`, `migrations/`, `tools/`, `tests/`, `scripts/`, `package.json`, `tsconfig.json`, `.replit`, `drizzle.config.ts`, or any other runtime-affecting path.

---

## 2. Which commits contain code changes you likely still want later?

**None of them contain code changes.** They contain documentation and conversation captures.

| Commit | Content | Want to preserve? | Why / why not |
|---|---|---|---|
| `2cbbdcc7` | Two pasted prompts about Freight DNA tasks | ⚪ Optional | Conversation history. No functional value. Keep if you want a record of how this session began. |
| `35460487` | One pasted "Publish Pipeline Triage" prompt | ⚪ Optional | Conversation history. |
| `e0d0de27` | One pasted prompt about dev schema alignment | ⚪ Optional | Conversation history. The commit title is misleading — it did not change schema. |
| `32170406` | `docs/dev-prod-schema-drift-2026-05-08.md` + one attached asset | 🟢 **Yes — preserve** | This is the drift inventory document you'll need to plan the future dev-side realignment (Strategy B in that doc). High value, hard to reproduce. |
| `352adf50` | `docs/prod-restore-and-republish-plan-2026-05-08.md` | 🟢 **Yes — preserve** | The runbook you're about to execute. High value. |

---

## 3. Recommendation for what to re-apply after the rollback

Given that no commits contain code, "re-apply" here means "cherry-pick the documentation files back." Three options:

### Option A — Preserve the two valuable docs only (RECOMMENDED)

Cherry-pick `32170406` and `352adf50` back on top of `9949c373`. Drop the three attached-asset commits and `e0d0de27`. Result: clean rollback to `9949c373` with the two drift/restore docs preserved.

**Mechanics (you execute these):**

```bash
# After you do the View Checkpoints rollback to 9949c373:
git cherry-pick 32170406    # docs/dev-prod-schema-drift-2026-05-08.md
git cherry-pick 352adf50    # docs/prod-restore-and-republish-plan-2026-05-08.md
# (plus this preservation plan, see Option C below)
```

Each cherry-pick will succeed cleanly — these are pure-additive doc files with no overlap with the rolled-back state.

### Option B — Preserve everything (most conservative)

Cherry-pick all 5 commits back. Result: you have the full conversation history captured. Functionally identical to staying on current HEAD. **Not recommended** — adds clutter without value, and `e0d0de27`'s misleading commit message is a documentation hazard for future engineers.

### Option C — Preserve nothing (cleanest)

Hard-rollback to `9949c373` and discard all five commits. The drift inventory and restore plan are gone from git but you can re-export them from this conversation if needed.

**My recommendation: Option A.** Take the rollback, cherry-pick the two docs back, and additionally cherry-pick this preservation plan (`docs/preservation-plan-2026-05-08.md`) as a third doc. Three commits on top of `9949c373` instead of five, all docs, no functional surprises, and you keep the artifacts you'll actually use.

### Pre-rollback safety net (regardless of option)

Before you execute the View Checkpoints rollback, **make a tag on the current HEAD**:

```bash
git tag pre-rollback-2026-05-08 32170406    # current HEAD before this preservation doc was committed
# OR after this doc commits:
git tag pre-rollback-2026-05-08 HEAD
```

A git tag is a one-command, zero-cost preservation — the commits stay reachable forever via the tag even if HEAD moves. If a checkpoint restore acts in unexpected ways, you can restore the tag to recover the pre-rollback state.

**I will not create this tag without your "execute" — `git tag` is a write operation against the local repo and falls under the standing freeze.**

---

## 4. Prod data created after the chosen restore point — the decision-blocking finding

This is the most important section in this document. **The numbers below challenge the previously-proposed restore target.**

### Per-table row counts in PROD created after `2026-04-29T23:30:00Z` (the proposed restore target)

| Table | Rows after target | Total rows | % after | Source of writes |
|---|---:|---:|---:|---|
| **`contacts`** | 1 | 66 | 1.5% | rep-entered |
| **`touchpoints`** | 0 | 174 | 0% | rep-entered |
| **`tasks`** | 9 | 88 | 10% | rep-entered (mostly) |
| `crm_opportunities` | 1 | 1 | 100% | mixed |
| `nba_cards` | 28 | 97 | 29% | system-generated |
| `account_contact_suggestions` | 838 | 1,121 | 75% | system-generated |
| **`quote_opportunities`** | **22,803** | **25,722** | **88%** | inbound integration (email→quote) |
| **`email_messages`** | **80,788** | **111,805** | **72%** | inbound integration (M365 sync) |

### Key observations

**(a) Rep-entered data loss is trivially small.**
- 1 contact created in 9 days
- 0 touchpoints created in 9 days
- 9 tasks created in 9 days
- 1 task updated in 9 days
- 0 touchpoint updates by date

This is **strong corroborating evidence for your statement that "production is not usable for my team."** Your reps appear to have stopped writing to prod meaningfully ~9+ days ago. Anything they're doing right now is happening outside the system. The "data we'd lose" from a 9-day-old restore is essentially a single contact and 9 tasks. Reps could re-enter that in under an hour.

**(b) Integration-entered data is enormous and concentrated in recent days.**

Per-day breakdown of `quote_opportunities` and `email_messages` after the proposed restore target:

| Day | quote_opportunities | email_messages |
|---|---:|---:|
| 2026-04-30 | 3,504 | 7,481 |
| 2026-05-01 | 3,268 | 6,377 |
| 2026-05-02 | **3** | **270** |
| 2026-05-03 | **1** | **343** |
| 2026-05-04 | 1,806 | 9,439 |
| 2026-05-05 | 2,779 | 15,360 |
| 2026-05-06 | 5,399 | 14,676 |
| 2026-05-07 | 2,153 | 16,232 |
| 2026-05-08 | 3,898 | 10,654 |

Notable patterns:

- **A near-total ingestion outage on 2026-05-02 / 2026-05-03** (3 quotes + 1 quote on those two days) — almost certainly a system pause, not a true business slowdown.
- **A surge starting 2026-05-04** with daily email volumes (15k+/day) much higher than the pre-pause baseline (~7k/day). This pattern is consistent with **catchup processing replaying queued/missed emails**, not with a genuine 2× growth in inbound business volume.
- This means the 22,803 quote_opportunities and 80,788 emails almost certainly contain **substantial duplication and replay artifacts**, not all of which represent real new business.

### What this means for the restore decision

**The previous plan's "9 days of writes lost" framing was incomplete in two ways:**

1. **It under-estimated rep tolerance for data loss.** Reps already aren't using prod. Restoring to 9 days ago costs them 1 contact and 9 tasks of re-entry. That's a non-event.
2. **It under-estimated integration-side data loss.** 22,803 quote opportunities and 80,788 emails would be wiped. Even if much of that is duplicates/replays from the broken backfill window, **some unknown fraction is genuine new RFP/quote pipeline data your team has been working on or will need for AI training, account growth scoring, NBA history, and the freight-daily-upload fact table**.

**Three possible interpretations, and what each implies for the restore target:**

#### Interpretation X — "The recent surge is real business; we want to keep it"

If 5/4–5/8's volume reflects genuine inbound pipeline activity, the right restore target is **not** 2026-04-29. The right target is **as late as possible while still cleaning the originally-corrupted state**. Likely candidate: **2026-05-04T00:00:00Z** (after the 2-day pause, before the catchup surge — preserving most of the late-period volume while clearing the worst of the pre-pause window).

Loss at this target: ~2 days of integration data (5/4 partial through 5/8) + still 1 contact + 9 tasks for rep work.

#### Interpretation Y — "The recent surge is mostly replays/duplicates from the backfill; we don't need it"

Restore to **2026-04-29T23:30:00Z** as originally planned. The 22,803 quote opps and 80,788 emails are mostly artifacts of the backfill tool and inbound replay; treating them as expendable is fine.

Loss at this target: 22,803 quote opps + 80,788 emails (mostly artifact, accepting some loss of real signal).

#### Interpretation Z — "We don't actually know which interpretation is true, and we should find out before deciding"

**This is what I'd recommend.** Section 5 below describes a 30-minute audit you can run pre-restore that would distinguish X from Y. Until that audit runs, **do not finalize the restore target.**

---

## 5. Can prod data created after the restore point be exported before restore?

**Yes**, and it should be — for at least the four rep-entered tables (free, fast, low-risk insurance) and ideally for the integration-entered tables too (more involved but feasible).

### What I can do (with your approval — these are read-only)

I can run `executeSql({ environment: 'production' })` SELECTs and dump the results to local `.csv` or `.jsonl` files in `.local/dev-db-backups/prod-after-restore-target/`. This is read-only, no prod writes, no schema changes.

### Recommended export bundle

| Table | Filter | Estimated rows | Recommended format | Why |
|---|---|---:|---|---|
| `contacts` | `created_at > '2026-04-29T23:30:00Z' OR updated_at > '2026-04-29T23:30:00Z'` | ~1–10 | JSONL | Trivially small; full snapshot in case the 1 created and N updated are both important. |
| `touchpoints` | `date > '2026-04-29T23:30:00Z' OR updated_at > '2026-04-29T23:30:00Z'` | ~0–20 | JSONL | Likely zero rows but cheap to confirm. |
| `tasks` | `created_at > restore OR updated_at > restore` | ~10–20 | JSONL | Re-create manually post-restore. |
| `crm_opportunities` | `created_at > restore` | 1 | JSONL | The single new row. |
| `nba_cards` | `created_at > restore` | 28 | JSONL | Forensic only — these are system-regenerated, no need to re-insert. |
| `account_contact_suggestions` | `created_at > restore` | 838 | JSONL | Forensic only — system-regenerated. |
| **`quote_opportunities`** | `created_at > restore` | **22,803** | **JSONL chunked** | **Important — see below.** |
| **`email_messages`** | `created_at > restore` | **80,788** | **JSONL chunked** | **Important — see below.** |
| `freight_daily_upload_fact` | `ingested_at > restore` | unknown | JSONL chunked | Important if uploads happened in window. |

### About `quote_opportunities` and `email_messages` — the bulk export concern

- **80,788 email rows × ~5KB average = ~400 MB raw**
- **22,803 quote rows × ~2KB average = ~45 MB raw**

Both are big enough that exporting through the read-replica `executeSql` interface in single calls would likely time out or get rate-limited. Two viable approaches:

1. **Chunked SELECT export:** I run repeated `SELECT ... ORDER BY id LIMIT 5000 OFFSET ...` calls, paging through the result set. 100MB-ish of email content per chunk. Estimated total: 16 chunks × ~30s each = ~10 min for emails; ~5 chunks × ~15s = ~2 min for quotes. Result lands in `.local/dev-db-backups/prod-after-restore-target/`.

2. **`pg_dump` from Replit support:** request a server-side `pg_dump` of just these two tables filtered on the timestamp predicate. This is the cleanest path for the email blob volume but requires a Replit support ticket.

**Re-importing this data after restore is harder than exporting it.** Once prod is restored, putting these rows back means INSERTs that respect FKs (an email row references companies, contacts, threads; a quote_opportunity references companies, freight_opportunities, organization). If any of those parent rows were also wiped by the restore, the inserts will fail. **A "selective rehydrate" of these tables is a substantial engineering project on its own, not a single SQL command.**

### My honest take on the integration-data export

- **Rep-entered tables (contacts/touchpoints/tasks/crm_opportunities/freight_daily_upload_fact):** export, no question. Cheap insurance. ~50 rows total. Re-applying post-restore is straightforward.
- **System-generated tables (nba_cards, account_contact_suggestions):** export for forensics; do **not** plan to re-insert. They regenerate from upstream signals.
- **`quote_opportunities` and `email_messages`:** **export the metadata** (a smaller projection like `id, created_at, source_reference, company_id, status` for quotes; `id, created_at, provider_message_id, from_email, subject, account_id` for emails) so you have a forensic record. Do **not** plan to bulk-rehydrate the full row data — that's a multi-day engineering effort with FK risk.
  - **For `email_messages` specifically:** the source of truth is the user's mailbox on Microsoft Graph. After restore, the next M365 sync re-pulls inbound messages from the actual mailbox. You don't need to preserve the full body; you need to preserve "what we already classified" so we don't double-classify. The metadata projection captures that.

---

## 6. Putting it all together — recommended preservation actions

Sequenced for you to execute (or approve and ask me to execute the read-only steps):

### Before any rollback

1. **AGENT (read-only):** export the recommended bundle from Section 5 above into `.local/dev-db-backups/prod-after-restore-target/`. Estimated time: 15 min for the small tables; +10 min if you opt to chunk-export emails/quotes; +0 min if you delegate emails/quotes to Replit support.
2. **OPERATOR:** create a git tag preserving current HEAD: `git tag pre-rollback-2026-05-08 HEAD`. Zero-cost insurance.
3. **OPERATOR + AGENT:** make a final read-only call on the restore target — Interpretation X (later target, ~2 days loss) vs Interpretation Y (original target, 9 days loss). I can run a 30-minute focused audit on whether the post-pause email volume is real signal vs replay artifact. **This audit is not in the previous plan and I recommend adding it as a new "Step 1.5" before Step 2 of the existing runbook.**

### Code-side preservation

4. **OPERATOR:** after the View Checkpoints rollback to `9949c373` lands, cherry-pick three docs back:
   - `docs/dev-prod-schema-drift-2026-05-08.md` (commit `32170406`)
   - `docs/prod-restore-and-republish-plan-2026-05-08.md` (commit `352adf50`)
   - `docs/preservation-plan-2026-05-08.md` (this document, will commit on next checkpoint after this turn)
5. Drop the three attached-asset commits (`2cbbdcc7`, `35460487`, `e0d0de27`) — they're conversation captures with no functional or documentation value.

### Data-side preservation

6. Bundle from Section 5 lives at `.local/dev-db-backups/prod-after-restore-target/` after Step 1 above. Treat as read-only forensic archive.
7. After successful publish (Step 8 of the restore runbook), use the bundle to re-apply the ~10 rep-entered rows (Section 5's first 4 tables). The system-generated and integration tables stay archived for forensic reference.

---

## 7. Open questions I need answered before executing anything

1. **Restore target — final decision after the X-vs-Y audit:**
   - Run the audit first (recommended), then decide?
   - Or commit to one of: 2026-04-29T23:30:00Z (Y), 2026-05-04T00:00:00Z (X), 2026-05-03T00:00:00Z (between), or 2026-04-25T00:00:00Z (deepest)?
2. **Code preservation level — pick one of A / B / C from Section 3:**
   - A (recommended): preserve drift doc + restore plan + this preservation doc, drop the rest.
   - B: preserve all 5 commits.
   - C: preserve nothing.
3. **Data export scope:**
   - Small tables only (15 min, low-risk, recommended)?
   - Add chunked export of the 22,803 quotes and 80,788 emails (+10 min, +400MB local)?
   - Defer bulk export to Replit support `pg_dump`?
4. **Audit go-ahead:** can I run the read-only X-vs-Y audit now (~30 min), or do you want to schedule it as the first step of the maintenance window?

**Until I have those answers, the standing freeze remains in effect.** Dev DB unchanged. Prod DB unchanged. Workspace files unchanged except for this preservation plan document.
