# Contact Promotion — Design Proposal (NOT YET IMPLEMENTED)

> **Status:** Design-only. No code, no API, no migration. Approval gate before
> any write path is built. Do not start implementation until the user signs off
> on this document.

## Why this exists

The Email Intelligence pipeline learns inbound senders and writes them to
`account_contact_suggestions` (currently 803 rows in prod, 748 in dev). Reps
already have a per-suggestion **Add** button on the Customers page. What's
missing is an admin-grade tool to:

1. **Bulk-promote** vetted suggestions on a single account in one action.
2. Prove what was promoted, by whom, and provide a one-click rollback if a
   batch turns out to be junk.
3. Stay strictly inside the existing visibility/RBAC model — no end-runs.

This document is the design contract for that tool. No code in this repo
should change until this document is converted into a task the user has
explicitly approved.

---

## UX concept

### Entry point
- A new admin page `/admin/contact-promotion` (NOT linked from rep nav).
- Surfaced as a follow-up from the **Email-Derived Companies** read-only
  console (`/admin/email-derived-companies`) once that view is approved.
- Page lists all companies in the admin's org that have ≥1 `pending`
  suggestion, sorted by suggestion count desc.

### Per-account drawer
Selecting a company opens a right-side drawer with the existing org-chart
preview on the left and the suggestion list on the right:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Armstrong World Industries                                          │
│ Saved contacts: 0   Pending suggestions: 32                         │
├──────────────────────────┬──────────────────────────────────────────┤
│  Org chart (preview)     │  Pending suggestions          [Select all]│
│                          │  ☐ joshm@armstrongtransport.com  conf 92 │
│  (empty — no contacts)   │  ☐ macardin@armstrong.com        conf 88 │
│                          │  ☐ phxpr012@armstrongceilings.com conf 71│
│                          │  ☐ bwitmer@armstrong.com         conf 86 │
│                          │  …                                       │
│                          │                                          │
│                          │  [ Promote N selected ]   [ Dismiss N ]  │
└──────────────────────────┴──────────────────────────────────────────┘
```

### Confirmation gate
Clicking **Promote N selected** opens a confirm dialog showing:
- Exact suggestion → contact mapping (email, suggested name, suggested title).
- Inline editable name/title/role (defaults to suggested values).
- A required free-text "Reason for promotion" (≥10 chars).
- A **dry-run preview** that returns *what would be created* without writing
  anything (server returns the planned `Contact` shape so the UI can render
  exactly what the table will look like after commit).
- Big amber banner: *"This creates N permanent rows in `contacts`. You can
  undo this batch within 7 days from the Promotion History tab."*

### Promotion History tab
A second tab on the same admin page lists every promotion batch:
- Batch id, org, account, by-user, count, reason, timestamp.
- **Rollback** button (visible for 7 days) that hard-deletes the contacts
  created by that batch *and only that batch* (FK guarded — see Guardrails).
- After 7 days, rollback is disabled (suggestion: rep must use the regular
  contact UI to delete individual contacts).

---

## Proposed API shape

All endpoints `requireAuth + isAdmin`. All endpoints scoped to
`req.user.organizationId` — no cross-org reads or writes.

### Read

```
GET /api/admin/contact-promotion/eligible-accounts
  → { ok: true, rows: [{ companyId, name, savedContactCount, pendingSuggestionCount, lastSuggestionAt }] }

GET /api/admin/contact-promotion/account/:companyId
  → { ok: true,
      company: { id, name, ownerRepId, industry },
      savedContacts: Contact[],
      pendingSuggestions: AccountContactSuggestion[] }
```

### Write — dry-run

```
POST /api/admin/contact-promotion/dry-run
  body: { companyId, suggestions: [{ suggestionId, name, title?, roleType? }] }
  → { ok: true,
      plan: [{ suggestionId, plannedContact: InsertContact, conflictsWith: Contact | null }] }
```

The server validates every suggestion belongs to that company *and* status =
`pending`, and refuses if any conflict (e.g. existing contact with same email).
Idempotent and side-effect free.

### Write — commit

```
POST /api/admin/contact-promotion/commit
  body: { companyId, reason: string,
          suggestions: [{ suggestionId, name, title?, roleType? }] }
  → { ok: true, batchId, createdContactIds: string[] }
```

Server steps (single transaction):
1. Re-validate every suggestion (still pending, still belongs to this company,
   no conflicts). Reject the entire batch if any check fails.
2. Insert N rows into `contacts` with `source_type = 'admin_promoted'` and
   `created_by = req.user.id`.
3. Update the corresponding `account_contact_suggestions` rows to
   `status = 'promoted'`, `acted_by_user_id = req.user.id`, `notes = reason`.
4. Insert one row into a new `contact_promotion_batches` table (see Schema).
5. Insert one row into the existing `crm_account_history` audit table per
   contact created.

### Rollback

```
POST /api/admin/contact-promotion/rollback/:batchId
  → { ok: true, deletedContactIds: string[] }
```

Server steps (single transaction):
1. Look up batch; refuse if older than 7 days or already rolled back.
2. For each contact id in the batch:
   - Refuse if the contact has been edited since promotion (any change to
     `name`, `email`, `title`, `relationship_base`, `next_steps`, etc.).
   - Refuse if the contact is referenced by any non-cascade FK (touchpoints,
     tasks, etc.) — force the admin to clean those up first or use the
     normal delete UI.
3. Delete the contacts.
4. Flip `account_contact_suggestions.status` back to `pending`.
5. Mark the batch row `rolled_back_at = now()`.

---

## New schema (proposed only — not added)

```ts
export const contactPromotionBatches = pgTable("contact_promotion_batches", {
  id: varchar("id").primaryKey(),
  orgId: varchar("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  companyId: varchar("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  promotedByUserId: varchar("promoted_by_user_id").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  contactIds: text("contact_ids").array().notNull(),            // contacts created by this batch
  suggestionIds: text("suggestion_ids").array().notNull(),       // suggestions consumed
  createdAt: timestamp("created_at").notNull().defaultNow(),
  rolledBackAt: timestamp("rolled_back_at"),
  rolledBackByUserId: varchar("rolled_back_by_user_id").references(() => users.id),
});
```

One new column on `contacts`:
- `source_type` already exists — we'd only standardise the value
  `'admin_promoted'` for batch promotions.

---

## Guardrails

1. **Org isolation.** Every read/write filters by `req.user.organizationId`.
   The single-org guarantee is enforced at the SQL layer, not just Express.

2. **Admin-only.** `isAdmin(user)` check at every route. RBAC change is not
   in scope for this feature.

3. **Pending-only promotion.** A suggestion that has already been actioned
   (`status != 'pending'`) is silently ignored in dry-run and rejected in
   commit. Prevents double-promotion on a stale page.

4. **Conflict refusal.** If any selected suggestion's email collides with an
   existing contact (same email + same company), the entire batch is
   refused. Forces admin to merge manually instead of producing duplicates.

5. **No silent fallback on commit.** If validation rejects 1 of N
   suggestions, the entire commit is rolled back — partial promotion is
   never allowed.

6. **Batch-scoped rollback.** Rollback only deletes contacts whose ids are
   listed in `contact_promotion_batches.contact_ids`. A contact that was
   later modified is excluded with a clear error message.

7. **7-day rollback window.** After 7 days, rollback is disabled. Avoids
   surprising long-tail mass-deletions.

8. **Permanent audit trail.** Even after rollback, the batch row stays
   forever. `crm_account_history` rows are never deleted — they show the
   contact existed for a window of time.

9. **Test contract.** A new section of `tests/code-quality-guardrails.test.ts`
   asserts:
   - Both `commit` and `rollback` are wrapped in `db.transaction(...)`.
   - The `commit` route writes to `contacts`, `account_contact_suggestions`,
     `contact_promotion_batches`, and `crm_account_history` — and nothing
     else.
   - `rollback` only deletes contacts whose ids are in the named batch.
   - Org filter is present on every SQL statement.

10. **Rate limit.** Max one commit per admin per minute. Prevents an admin
    from accidentally clicking twice.

---

## Risks deliberately not solved by this design

- **Soft-delete of contacts.** Out of scope; rollback uses hard delete
  protected by FK and edit-after-promotion checks.
- **Cross-org promotion.** Unsupported and intentionally impossible.
- **Auto-promotion based on confidence threshold.** Out of scope; this is a
  human-in-the-loop tool.
- **Editing the suggestion email itself.** Email is the immutable identifier;
  if the email is wrong, the admin should dismiss the suggestion and create a
  contact manually.

---

## What I need from you before implementation

1. Confirm the UX matches what you want (drawer vs. full page vs. inline).
2. Confirm the rollback window (7 days proposed; can be 24h or 30d).
3. Confirm the `contact_promotion_batches` table name and shape.
4. Approve "fail entire batch on any conflict" as the conflict policy.
5. Decide whether we want a per-rep promotion path later, or admin-only
   forever.

Once these five points are answered, I can scope the implementation as one
focused task with a single Section in the guardrails test file.
