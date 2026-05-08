# Restore Target Recommendation — Post-Audit

**Authored:** 2026-05-08, after read-only X-vs-Y audit on prod.
**Companion:** `.local/dev-db-backups/prod-after-restore-target/audit_results.md` (raw audit query output).
**Status:** recommendation only. **No execution.** All standing guardrails honored.

---

## Recommended restore target

# **2026-05-04T00:00:00Z** (Option X)

---

## Rationale (the four key audit findings)

### Finding 1 — Post-pause emails are 100% unique, NOT replays

`SELECT count(*) AS total, count(DISTINCT (org_id, provider_message_id)) AS distinct_msgs FROM email_messages WHERE created_at > '2026-04-29T23:30:00Z'`
→ **81,015 total = 81,015 distinct.** Zero duplicates by `provider_message_id`.

The 80,788 emails in the post-target window are real, distinct inbound messages. The 5/4–5/8 volume surge is genuine inbound traffic, not the backfill tool replaying old messages into the email_messages table.

### Finding 2 — Quote_opportunities ARE heavily duplicated, by an unrelated mechanism

`SELECT count(*) AS dup_groups, sum(c) AS dup_rows FROM (SELECT source_reference, count(*) c FROM quote_opportunities WHERE created_at > '2026-04-29T23:30:00Z' GROUP BY 1 HAVING count(*) > 1) t`
→ **9,560 dup_groups, 19,283 dup_rows.**

About **9,723 redundant QO rows** for ~9,560 distinct emails. This is the **unpatched quote-pipeline race condition that commit `7f577c98` ("Handle duplicate record insertions safely") fixes.** That fix is in the workspace but not in prod. The duplication is ongoing in prod and will continue at the rate of inbound traffic until publish.

**Important consequence:** restoring to Y vs X doesn't fix the underlying race. New duplicates will appear on every inbound email until `7f577c98` is published. So the "right" cure for duplication is publish-the-fix, not restore.

### Finding 3 — Almost no QO replay across the X boundary

`qo_replaying_old_emails` (QOs created after X that reference emails from before X) → **78 rows total**, all on 2026-05-04.
`qo_new_business` (QOs created after X that reference emails from after X) → **15,974 rows** spread across 5/4–5/8.

Translation: when the system came back from the 5/2–5/3 pause, it processed the genuine new inbound (~99.5% of post-X QOs reference post-X emails). The backfill tool's replay window was effectively exhausted by 5/4. So **the post-X data is overwhelmingly genuine new business**, not backfill artifacts.

### Finding 4 — Backfill-tool QOs (4/30–5/1) are CORRECT data, not corruption

Re-reading `tools/backfill-incident-window.ts`: the tool exists to **fill in missing QO rows** for emails from the capture-first P0 incident window. It doesn't introduce bad data; it repairs missing data from an earlier bug. The 6,772 QOs created on 4/30–5/1 are emails that *should* have had QOs from the start but didn't due to the prior incident — the backfill fixed that.

Restoring to Y wipes those 6,772 correct backfill repairs. Restoring to X preserves them.

---

## Why X over Y, in one paragraph

X (5/4 00:00 UTC) preserves the 4/30–5/3 backfill-window data, which is **legitimate corrected data** from the P0 repair. It loses 4.5 days of post-restore writes — the bulk of which are integration-driven (emails resynced via M365, QOs that include the unwanted-but-fixable race-condition duplicates). Y (4/29 23:30 UTC) loses an additional 4.5 days — including the backfill repairs — and gains nothing in return because **the QO duplication problem is solved by the unpublished `7f577c98` fix, not by restoring further back.** The least-destructive choice is X.

**The single argument for Y over X:** if you have direct evidence that the 4/30–5/3 backfill writes themselves are wrong (e.g., reps reporting QOs assigned to wrong customers in that window). I have no such evidence in the audit data.

---

## Estimated data loss by category — at the recommended target (X = 2026-05-04T00:00:00Z)

| Category | Count lost | Source | Recoverable? | Action |
|---|---:|---|---|---|
| **Contacts (rep-entered)** | 1 | Created 4/30–5/8 | ✅ Yes — exported to `.local/dev-db-backups/prod-after-restore-target/contacts.csv` | Re-insert manually post-restore (1 row) |
| **Touchpoints (rep-entered)** | 0 | None created/dated after restore-Y; safely zero for restore-X too | n/a | Nothing to do |
| **Tasks (rep-entered)** | ~5 | 9 created since 4/29; subset post-5/4 | ✅ Yes — exported to `.local/dev-db-backups/prod-after-restore-target/tasks.csv` (full 9 rows) | Re-insert post-5/4 subset post-restore |
| **CRM opportunities (rep-entered)** | 1 | The single post-target row | ✅ Yes — exported to `.local/dev-db-backups/prod-after-restore-target/crm_opportunities.csv` | Re-insert manually post-restore |
| **Quote opportunities (integration)** | ~16,000 | ~50% are race-condition duplicates that 7f577c98 prevents going forward; ~50% are legitimate new business that will re-create on next email re-classification cycle | ⚠ Partial — see notes below | Forensic export delegated to Replit support (see Step 3 below) |
| **Email messages (integration)** | ~66,000 | All unique, all real inbound | ✅ Body content fully recoverable via M365 resync; classification metadata lost | Forensic export delegated to Replit support (see Step 3 below) |
| **NBA cards** | ~28 | System-generated from upstream signals | ✅ Yes — auto-regenerates from current state post-restore | Nothing to do |
| **Account contact suggestions** | ~838 | System-generated from signature sweep | ✅ Yes — auto-regenerates as the sweep re-runs | Nothing to do |
| **Backfill-window QO repairs (4/30–5/3)** | **0 lost** ✓ | Preserved by choosing X over Y | n/a | Preserved |

### Notes on QO loss

- **Race-condition duplicates (~9,000–10,000):** these are noise. Losing them is a feature, not a bug.
- **Legitimate new-business QOs (~6,000–7,000):** these are the loss that matters. They will *partially* re-create after restore as M365 resyncs the underlying emails and the inline classifier processes them — but with the publish, only one QO per email will be created (the race fix), so the post-restore count will be lower than the pre-restore "duplicated" count by design.
- **Net practical effect:** prod ends up with the correct QOs for unique inbound emails since 5/4, with no stale duplicates. Reps see a clean pipeline.

### Notes on email_messages loss

- The Microsoft Graph mailbox **is the source of truth** for inbound message bodies. The next M365 sync after restore will re-pull 5/4–5/8's inbound messages from the live mailbox. Your DB body content is recoverable in full.
- What is **not** recoverable: classifier outputs (routing_status, has_been_classified flags, links from email to QO) — those have to re-run through the inline classifier on re-sync. That is an automatic process, not manual work.
- For forensic reference — what classifications existed pre-restore — see Step 3 below.

---

## Exact operator steps to take next

These are the steps for **you** to execute. I'm not executing any of them. Each step's read-only/write classification is marked.

### Step 1 (today, ~5 min) — confirm export bundle is intact [READ-ONLY]

```
ls -la .local/dev-db-backups/prod-after-restore-target/
```

You should see:

```
audit_results.md               1,152 bytes  (raw audit query results)
contacts.csv                     717 bytes  (1 row + header)
crm_opportunities.csv            521 bytes  (1 row + header)
tasks.csv                      6,376 bytes  (9 rows + header)
touchpoints.csv                    2 bytes  (header only — 0 rows, expected)
qo_metadata.csv                   27 bytes  ⚠ TRUNCATED (read-replica cap)
email_metadata.csv                27 bytes  ⚠ TRUNCATED (read-replica cap)
```

The 4 small-table exports are complete and trustworthy. The 2 metadata files are truncated to 27 bytes (just the read-replica's "START TRANSACTION / ROLLBACK" boilerplate) — they are NOT useful, see Step 3 for the substitute path.

### Step 2 (today, 2 min) — schedule the maintenance window [WRITE: communication only]

Pick a low-traffic window. Recommend Sunday morning or another off-hours block (3–4 hours). Send the maintenance notice to your team channel using the template in `docs/prod-restore-and-republish-plan-2026-05-08.md` Step 1.

### Step 3 (today, 5 min) — open Replit support ticket for the bulk forensic export [WRITE: support ticket only]

Replit's read-replica `executeSql` interface caps result-set rows; the agent cannot bulk-export the 22,803 quote_opportunities or 80,788 email_messages from this seat. Either path works:

**Option 3a (recommended):** open a Replit support ticket with this exact request:

> Project ID: [your project ID]
> Database: production
> Request: server-side `pg_dump` filtered to two tables, written to a downloadable archive:
>
> ```
> pg_dump --data-only \
>   -t public.quote_opportunities \
>   -t public.email_messages \
>   --where="quote_opportunities: created_at > '2026-04-29T23:30:00Z'" \
>   --where="email_messages: created_at > '2026-04-29T23:30:00Z'"
> ```
>
> Purpose: forensic archive before scheduled point-in-time restore.
> Restore target: 2026-05-04T00:00:00Z. Forensic window covers everything between target and current.
> Lead time required: at least 24h before maintenance window.

(Note: pg_dump's `--where` syntax may require splitting into two separate dumps; Replit support can adjust.)

**Option 3b (skip the bulk forensic):** if the post-restore plan is to re-classify from M365 and not look back at the duplicate-laden pre-restore state, you can skip this step. The trade-off: you lose the ability to forensically inspect what classifications existed in prod before restore. For most restore-and-move-on situations this is acceptable.

**My recommendation:** Step 3a. The cost is one support ticket. The benefit is being able to reconstruct any specific account's pre-restore state if a rep later asks "what happened to the Acme quote on 5/6?".

### Step 4 (during maintenance window) — execute the restore using the existing runbook [WRITE: prod restore + publish]

Follow `docs/prod-restore-and-republish-plan-2026-05-08.md` Steps 1 → 8 with these substitutions:

- **Restore target:** `2026-05-04T00:00:00Z` (confirmed by this audit).
- **Step 1.5 (NEW) — pre-restore export verification:** confirm the support-team `pg_dump` archive from Step 3 above is downloaded and accessible before proceeding to Step 3 of the runbook.
- **Step 7 (verification) addition — re-insert the 11 exported rep rows:** after the verification smoke test passes, manually re-insert (or have a rep re-enter through the UI):
  - `contacts.csv` — 1 row
  - `tasks.csv` — the subset of the 9 rows whose `created_at > '2026-05-04T00:00:00Z'` (likely ~5 rows)
  - `crm_opportunities.csv` — 1 row

  **Important:** these re-inserts go through the prod app's normal write path (UI or API), not direct SQL. Direct SQL inserts skip lifecycle hooks, audit trails, and FK validation. I will not write a re-insert SQL script.

- **Step 8 (re-enable integrations) addition — verify the `7f577c98` race fix is actually live:** after re-enabling `CONTACT_JOBS_ENABLED=true`, watch the first 30 minutes of inbound emails. Confirm in the deploy logs that no duplicate-key error fires on the first wave of QO creation. If duplicates still appear, the fix didn't ship correctly and you need to re-publish.

### Step 5 (post-restore, separate maintenance window) — schedule dev schema realignment

Use `docs/dev-prod-schema-drift-2026-05-08.md` Strategy B (forward migrations) for a follow-up window, as you said you would. Not part of today's restore window.

---

## What I have NOT done (guardrails honored)

- ❌ No schema changes anywhere
- ❌ No prod writes (only `executeSql({ environment: 'production' })` SELECTs)
- ❌ No publish or rollback or git tag triggered
- ❌ No drizzle-kit operations
- ❌ No code changes outside `docs/` (and `attached_assets/` from your prior message)

## What I HAVE done in this turn

- ✅ Ran the X-vs-Y audit (9 read-only SELECTs against prod read-replica)
- ✅ Saved raw audit output to `.local/dev-db-backups/prod-after-restore-target/audit_results.md`
- ✅ Exported the 4 rep-entered tables (contacts, touchpoints, tasks, crm_opportunities) — 11 rows total, ~7.6 KB
- ✅ Discovered the read-replica row cap that prevents bulk QO/email export from this seat — documented and routed to Replit support in Step 3 above
- ✅ Wrote this recommendation document

---

## TL;DR for fast scanning

- **Restore to: `2026-05-04T00:00:00Z`** (Option X).
- **Why: backfill-window data (4/30–5/3) is good data; the duplication problem is solved by publishing `7f577c98`, not by restoring further back.**
- **Total rep data loss: ~7 rows. All exported.**
- **Total integration data loss: ~16,000 QOs (half are duplicates anyway) + ~66,000 emails (M365 resync recovers bodies).**
- **Pre-restore action items for you: (1) verify the 4 small-table exports above; (2) schedule the maintenance window; (3) open Replit support ticket for the bulk pg_dump forensic export.**
- **Standing freeze remains in effect until you say "execute."**
