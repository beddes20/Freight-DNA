# FreightDNA
FreightDNA is a mini CRM application designed to empower transportation brokerage sales teams by managing customer accounts, contacts, and shipping data to boost sales efficiency and revenue.

## Run & Operate
- **Run:** `npm start`
- **Build:** `npm run build`
- **Typecheck:** `npm run typecheck`
- **Codegen:** `npm run codegen`
- **DB Push:** `drizzle-kit push:pg`
- **Environment Variables:** `DATABASE_URL`, `OPENAI_API_KEY`, `MICROSOFT_GRAPH_CLIENT_ID`, `MICROSOFT_GRAPH_CLIENT_SECRET`, `RESEND_API_KEY`, `CONTACT_JOBS_ENABLED` (Task #1094 kill switch — default true; set to literal `false` to halt inbound contact / suggestion auto-create writers)

## Stack
- **Frontend:** React, TypeScript, Tailwind CSS, `shadcn/ui`
- **Backend:** Express.js
- **Database:** PostgreSQL (Drizzle ORM)
- **Runtime:** Node.js (specific version not specified, infer from `package.json`)
- **Build Tool:** Vite (implied by React setup, confirm with `package.json`)

## Where things live
- `/client`: Frontend source code.
- `/server`: Backend source code.
- `/server/db/schema.ts`: Database schema definition (source of truth).
- `/server/routes`: API endpoints.
- `/server/services`: Business logic and data access.
- `/server/agent`: AI agent runtime components.
- `/server/agentic`: AI agent control and autonomy layers.
- `/docs`: Project documentation and architectural contracts.
- `/tests`: Code quality guardrails and test suite.

## Architecture decisions
- **"Zero-new-error" philosophy:** Express handlers are designed for robust request parameter normalization.
- **Role-Based Access Control (RBAC):** Dynamic RBAC implemented for secure access to features.
- **AI-first Integration:** AI functionalities (`/ai-hub`) deeply integrated for insights, automation, and communication.
- **Unified Data Source:** `freight_daily_upload_fact` table serves as a single source of truth for financials, available freight, and lane work queue data.
- **Stability Contracts:** Critical functionalities like Customer Quotes & Account Ownership are enforced by documented stability contracts and automated tests.
- **Inbound Email Preservation:** Prevents silent dropping of inbound emails from unknown senders by persisting them with null account/carrier links, differentiating from noise.

## Product
- Comprehensive CRM for customer accounts, contacts, and shipping.
- AI-assisted RFP and Award management via Excel uploads.
- Advanced analytics for lane research, coverage gaps, and wallet share.
- User and team management with role-based access.
- Real-time communication and collaboration tools (notes, Webex Calling).
- AI-powered features: talking points, health scores, touchpoint summaries, email drafting, Next Best Action (NBA) engine.
- Lane Work Queue (LWQ) for managing assignable lane workflows.
- Integration with external services for market intelligence (FreightWaves SONAR/TRAC, ZoomInfo).
- Automated processes for email syncing, account reviews, and quote processing.
- Admin consoles for monitoring system health and triaging data (e.g., Email-Derived Companies).

## User preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## Gotchas
- **Contacts are soft-delete only (Task 1, 2026-05-07 incident; finished by Task #1093):** Hard `db.delete(contacts)` is forbidden in production code; tests are the only allow-listed callers. `storage.deleteContact(id, { userId, reason })` writes `deleted_at`/`deleted_by`/`delete_reason` instead. **Every** new `db.select().from(contacts)` (or join into contacts) MUST include `isNull(contacts.deletedAt)` — Section 1200 of `tests/code-quality-guardrails.test.ts` enforces this on every IStorage `getContact*` method, with a tiny explicit allow-list for methods that don't touch the contacts table. New `getContact*` methods either filter or get added to that allow-list with a justifying comment. Schema requires Drizzle push (`drizzle-kit push:pg`) before deploy — see `migrations/0016_contacts_partial_indexes.sql` for the partial indexes (`contacts_deleted_at_idx WHERE deleted_at IS NOT NULL`, `contacts_company_active_idx ON (company_id) WHERE deleted_at IS NULL`). Restore path = clear `deleted_at`. The read-path audit table lives above the contact storage methods in `server/storage.ts`.
- **Customer Quotes & Account Ownership:** Modifying `applyFilters`, `loadContext`, `enrich`, `attachResponseTimes`, or the `__none__` resolver in `server/services/customerQuotes.ts` requires updating `docs/customer-quotes-stability-contract.md` and `tests/code-quality-guardrails.test.ts` (Section 1100).
- **Unified ReplitDailyUpload:** Changes to financials or available freight upload logic (Task #1051) must maintain consistency with `freight_daily_upload_fact` and pass Section 1051 guardrails.
- **Email Ingestion:** The `processUserMailboxEmail` helper has specific logic for `PERSIST-UNKNOWN` and `TOMBSTONE-DROP` emails; do not reintroduce `DROP-GATE` behavior.
- **Carrier Ranking:** The carrier ranking engine prioritizes lane fit; AI adjustments cannot violate the lane-first ordering.
- **Email-Derived Companies (Task #1095, 2026-05-07):** `companies.is_email_derived` (bool, default false) marks rows auto-created by the inbound-email path. The default `GET /api/companies` filter excludes these — pass `?includeEmailDerived=true` to opt back in (Customers page uses `data-testid="toggle-show-email-derived"`). The won-quote AF handoff in `server/services/customerQuotes.ts` is the only production setter (sets `true` iff `opp.source === "email"`); do not introduce other auto-create sites without flagging consistently. Schema requires `drizzle-kit push:pg` before deploy (adds `is_email_derived`, `email_derived_at`, `email_derived_seed_message_id`, partial index `companies_email_derived_idx`). **Backfill TODO:** existing legacy stub rows are NOT yet flagged — use the admin console's "Heuristic (legacy)" mode in `/admin/email-derived-companies` until a backfill migration is run; the "is_email_derived flag" mode (`?source=flag`) only sees newly-flagged rows. Section 1095 of `tests/code-quality-guardrails.test.ts` enforces these contracts.
- **Profile Safety Labels (Task #1109 / #1109a, 2026-05-07):** Non-destructive UI labels on the Company Profile (email-derived banner, split Connection / Data-freshness pills, per-card "Updated Xh ago" + "Stale" pills, financial "may be incomplete" hint). Gated by org-scoped feature flag `profile_safety_labels_enabled`, exposed via `GET /api/profile-safety-flag` (default-ON: returns `{ enabled: true, configured: false }` when no row exists; admins flip OFF via `PATCH /api/feature-flags/profile_safety_labels_enabled`). Two new read-only routes: `GET /api/companies/:id/data-freshness` (max(createdAt) on nbaCards / latest accountGrowthScores.calculatedAt / max(touchpoints.date) / max(freightDailyUploadFact.ingestedAt) for matching customer) and `GET /api/companies/:id/financial-mapping-health` (counts freight rows whose `customer` ILIKEs the company name but is not bound by name- or financialAlias-equality). Stale thresholds: NBA 24h, growth/health/financials 7d (in `client/src/hooks/useCompanyDataFreshness.ts`). All UI is gated behind `useProfileSafetyFlag()` — leaving the flag default-ON in dev. **Three states (#1109a hardening):** loading / unavailable (fetch error → neutral grey "Freshness unavailable", emits `data-freshness-state="unavailable"`) / stale (real upstream age → amber). Do NOT collapse fetch errors back into the stale branch — it misled reps in pilot. The `health` source maps to "Last touchpoint" (not "Health updated") because `touchpoints.date` is user-entered and can be backdated; do not rename without changing the underlying timestamp source. **Out of scope (do not regress here):** no edits to `server/services/customerQuotes.ts`, `freight_daily_upload_fact` writers, email ingestion, or the CQ stability contract — these endpoints are pure SELECTs.
- **User Management lifecycle tabs (Task #1126 Phase 1 Step 4a-UI, 2026-05-07):** `client/src/pages/admin-users.tsx` is the **only** consumer that opts into the 4a-API `include*` flags. Admin-only segmented strip (`data-testid="lifecycle-tabs"`) maps `Active|Inactive|Service accounts|Quarantined|Deleted` → `none|includeInactive|includeServiceAccounts|includeQuarantined|includeDeleted`. Non-admins never see the strip and always read `/api/users` (cleaned default). Per-tab cache slices keyed off `[usersUrl]`; create/edit/delete/bulk-import all flow through `invalidateAllUsersQueries()` (predicate matches any `/api/users` key, excluding sub-routes like `/api/users/sales`). `includeDemo` is intentionally NOT wired here — no Demo tab; that's a future sub-step. Section 1126.4-UI of `tests/code-quality-guardrails.test.ts` pins the mapping, the admin gate, the `[usersUrl]` queryKey, and the absence of legacy bare-key invalidations. **Out of scope (do not regress):** every other `/api/users` consumer (~24 files) keeps the bare `["/api/users"]` queryKey and inherits the cleaned default.
- **Default `GET /api/users` lifecycle filter (Task #1126 Phase 1 Step 4a-API, 2026-05-07):** The default roster now hides `deleted_at IS NOT NULL`, `is_active=false`, `is_service_account=true`, `is_quarantined=true`, `is_demo=true`, and `is_fixture=true` rows. Five opt-in query flags exist: `?includeInactive=true` (any caller), and `?includeDeleted=true` / `?includeServiceAccounts=true` / `?includeQuarantined=true` / `?includeDemo=true` (all four **admin-only**, silently dropped + debug-logged for non-admins — never 403'd, so shared client code can keep passing them). **There is no `includeFixture` knob — `is_fixture` rows stay excluded under every flag combination** (preserves the fixture-poisoning guard). The contract lives on `storage.getUsers(orgId, filter?: UserListFilter)`; the no-arg overload keeps the legacy "every user" behavior for the two internal financial-uploads callers (`getFinancialUploadsForOrg`, `getLatestFinancialUploadForOrg`) so their historical scoping does not silently lose now-deactivated reps. Section 1126.4 of `tests/code-quality-guardrails.test.ts` enforces the contract. **Out of scope (do not regress):** `/api/users/sales`, `/api/users/search`, `POST /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id`, `server/auth.ts` / login, dashboards, leaderboards, goals, customer quotes, NBA, Webex/M365, Stripe seat counts, contact jobs — none consume the new default yet. Admin-users UI tabs land in Step 4a-UI as a separate PR. Known day-one caveat: pages that resolve historical author names from `["/api/users"]` (notes, touchpoints, activity feeds) will fall back to "Unknown user" for soft-deleted authors; the proper fix is `formatUserAttribution` adoption in those surfaces (later sub-step).
- **User lifecycle write paths (Task #1126 Phase 1 Step 3, 2026-05-07):** Admin-only, org-scoped routes at `POST /api/admin/users/:id/{classify,deactivate,reactivate,soft-delete,restore}` plus `GET /api/admin/users/:id/{lifecycle-events,impact}` — registered in `server/routes/adminUserLifecycle.ts`. **All lifecycle column writes (`is_active`, `is_service_account`, `is_demo`, `is_fixture`, `is_quarantined`, `deleted_at`, `deactivated_at`, …) MUST go through `storage.{classify,deactivate,reactivate,softDelete,restore}User` — never raw `db.update(users).set({ isActive… })`** — those methods row-lock the target with `SELECT … FOR UPDATE`, snapshot `prev_state`, apply the UPDATE, and insert a single `user_lifecycle_events` row in the same transaction. Audit rows must only be written from `server/storage.ts` (Section 1126.3 of `tests/code-quality-guardrails.test.ts` enforces this). **Restore returns the user to INACTIVE, not active** (caller must reactivate explicitly). **Service accounts cannot be promoted from a live user without also setting `isActive:false` in the same `classify` call**, and `reactivate` refuses while `is_service_account=true`. Soft-delete refuses with HTTP 409 + impact preview when the user has open ownership; `?force=true` overrides and is recorded in `next_state.force`. **Out of scope (do not regress):** `server/auth.ts`, `GET /api/users` defaults, `DELETE /api/users/:id` contract, `PATCH /api/users/:id`, `client/src/pages/admin-users.tsx`, dashboards, goals, quotes, NBA, Webex, Stripe, contact-jobs — none of these read the new lifecycle flags yet (Step 4+). Schema requires `drizzle-kit push:pg` (migrations 0017 + 0018 from Step 1) before deploy.
- **CONTACT_JOBS_ENABLED kill switch (Task #1094):** Env-driven pause for inbound `contacts` / auto-created `companies` / `account_contact_suggestions` writers. Default is **true** (enabled). Disabled ONLY when the env value is the literal string `false` (trimmed, case-insensitive). When disabled, gated callers (`server/accountContactCaptureService.ts`, `server/services/signatureContactSweep.ts`) early-return and emit a `[contact-jobs] disabled — skipping <writer>` warn line; PERSIST-UNKNOWN still preserves the source email. User-driven CRUD (`POST /api/companies/:companyId/contacts`, `PATCH /api/contacts/:id`, `POST /api/companies`) stays UNGATED so reps retain a recovery path. Helper lives at `server/lib/featureFlags.ts`; boot log emits `[boot] CONTACT_JOBS_ENABLED=<true|false>`. New writers MUST add the gate AND extend `tests/code-quality-guardrails.test.ts` Section 1094.

## Pointers
- **Drizzle ORM:** [https://orm.drizzle.team/](https://orm.drizzle.team/)
- **Tailwind CSS:** [https://tailwindcss.com/](https://tailwindcss.com/)
- **shadcn/ui:** [https://ui.shadcn.com/](https://ui.shadcn.com/)
- **Microsoft Graph API:** [https://learn.microsoft.com/en-us/graph/](https://learn.microsoft.com/en-us/graph/)
- **OpenAI API:** [https://platform.openai.com/docs/api-reference](https://platform.openai.com/docs/api-reference)
- **FreightWaves SONAR:** _Populate as you build_
- **Webex Calling API:** _Populate as you build_
- **Clerk Documentation:** _Populate as you build_
- **Customer Quotes Stability Contract:** `docs/customer-quotes-stability-contract.md`
- **Unified ReplitDailyUpload Documentation:** `docs/unified-replit-daily-upload.md`
- **Contact Promotion Design:** `docs/contact-promotion-design.md`