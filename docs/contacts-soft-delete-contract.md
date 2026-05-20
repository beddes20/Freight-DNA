# Contacts Soft-Delete Contract (Task 1, 2026-05-07 incident; finished by Task #1093)

## Rules
- Hard `db.delete(contacts)` is **forbidden** in production code; tests are the only allow-listed callers.
- `storage.deleteContact(id, { userId, reason })` writes `deleted_at` / `deleted_by` / `delete_reason` instead.
- **Every** new `db.select().from(contacts)` (or join into contacts) MUST include `isNull(contacts.deletedAt)`.

## Enforcement
Section 1200 of `tests/code-quality-guardrails.test.ts` enforces this on every IStorage `getContact*` method, with a tiny explicit allow-list for methods that don't touch the contacts table. New `getContact*` methods either filter or get added to that allow-list with a justifying comment.

## Schema
Requires Drizzle push (`drizzle-kit push:pg`) before deploy — see `migrations/0016_contacts_partial_indexes.sql` for the partial indexes:
- `contacts_deleted_at_idx WHERE deleted_at IS NOT NULL`
- `contacts_company_active_idx ON (company_id) WHERE deleted_at IS NULL`

## Restore
Restore path = clear `deleted_at`.

The read-path audit table lives above the contact storage methods in `server/storage.ts`.
