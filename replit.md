# FreightDNA
FreightDNA is a mini CRM application designed to empower transportation brokerage sales teams by managing customer accounts, contacts, and shipping data to boost sales efficiency and revenue.

## Run & Operate
- **Run:** `npm start`
- **Build:** `npm run build`
- **Typecheck:** `npm run typecheck`
- **Codegen:** `npm run codegen`
- **DB Push:** `drizzle-kit push:pg`
- **Environment variables:** See `docs/env-vars-reference.md` (core list + kill switches + forbidden vars). Render-specific deploy values: `docs/render-env-manifest.md`.

## Stack
- **Frontend:** React, TypeScript, Tailwind CSS, `shadcn/ui`
- **Backend:** Express.js
- **Database:** PostgreSQL (Drizzle ORM)
- **Runtime:** Node.js (specific version not specified, infer from `package.json`)
- **Build Tool:** Vite

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

---

## Critical surfaces & contracts
Each entry below is a one-line pointer to the authoritative contract doc. Read the doc before editing the surface — never expand scope from this file.

- **Customer Quotes & Account Ownership** — modifying `applyFilters`, `loadContext`, `enrich`, `attachResponseTimes`, or the `__none__` resolver in `server/services/customerQuotes.ts` requires updating the contract + Section 1100 of `tests/code-quality-guardrails.test.ts`. See: `docs/customer-quotes-stability-contract.md`.
- **CQ Guardrail Hardening (2026-05-15)** — tests-only relax + new Section 1450 cross-file binding contract. Zero production code changed. See: `docs/cq-guardrail-hardening-2026-05-15.md`.
- **Customers Tab Trust (Subtask B, 2026-05-15)** — `/customers` is the only opt-in caller of the Bucket D thin-stub `?customersOnly=true` filter; `storage.getCompanies` no-opts overload is unchanged. Section 1300. See: `docs/customers-tab-trust-contract.md`.
- **Users Roster Trust (Subtask B, 2026-05-15)** — `/admin/users` default roster hides `@example.com`-family fixtures via `?includeJunkSuspects` opt-in; no-opts `storage.getUsers(orgId)` unchanged. Section 1400. See: `docs/users-roster-trust-contract.md`.
- **Launchpad L1.1 — Routing Visibility (2026-05-18)** — `getVisibleCompanyIds` / `canAccessCompany` opt-in `includeUnroutedEmailDerived` for the four manager roles; no-arg overloads byte-for-byte unchanged. Section 1600. See: `docs/launchpad-routing-visibility-contract.md`.
- **Fixture User Cleanup — FUC-P1-S1 (Task #1179, 2026-05-18)** — `isFixtureUser(u)` composes existing pattern sources + Task #1126 lifecycle flags; wired in exactly one place: `server/routes/dashboard.ts` margin-metrics. Section 1500. See: `docs/fixture-user-cleanup-contract.md`.
- **Top Opportunities (Task #1140, 2026-05-08)** — three-state freshness pill + manager-only dismiss role list; Section 1140. See: `docs/top-opportunities-trust-contract.md`.
- **Quote Requests default-trust hide (2026-05-08)** — client-side `customerName === "Unknown — needs review"` post-filter; server `applyFilters` untouched. See: `docs/quote-requests-default-trust-hide.md`.
- **Profile Safety Labels (Tasks #1109 / #1109a, 2026-05-07)** — non-destructive freshness pills behind `profile_safety_labels_enabled`; three-state loading / unavailable / stale rule. See: `docs/profile-safety-labels-contract.md`.
- **Email-Derived Companies (Task #1095, 2026-05-07)** — `companies.is_email_derived` flag + `?includeEmailDerived` opt-in; backfill TODO documented. Section 1095. See: `docs/email-derived-companies-contract.md`.
- **Contacts are soft-delete only (Task #1093, 2026-05-07)** — hard `db.delete(contacts)` forbidden; every read must filter `isNull(contacts.deletedAt)`. Section 1200. See: `docs/contacts-soft-delete-contract.md`.
- **User lifecycle (Task #1126 Phase 1, Steps 3 + 4a-API + 4a-UI)** — admin-only lifecycle routes, default `GET /api/users` cleaned filter, `admin-users.tsx` segmented tabs. Sections 1126.3 / 1126.4 / 1126.4-UI. See: `docs/user-lifecycle-contract.md`.
- **Unified ReplitDailyUpload (Task #1051)** — financials + available freight + LWQ all share `freight_daily_upload_fact`. Section 1051. See: `docs/unified-replit-daily-upload.md`.

## Operational gotchas
- **CONTACT_JOBS_ENABLED kill switch (Task #1094)** — env-driven pause for inbound contact / suggestion auto-create writers; default `true`; user-driven CRUD stays ungated. See: `docs/contact-jobs-kill-switch-contract.md`.
- **Email Ingestion** — `processUserMailboxEmail` has specific `PERSIST-UNKNOWN` / `TOMBSTONE-DROP` logic; do not reintroduce `DROP-GATE` behavior. See: `docs/email-ingestion-contract.md`.
- **Email & environment gate (Render cutover)** — live mail requires BOTH `APP_ENV=production` AND `EMAIL_LIVE_MODE=true`; staging on a prod-DB-clone stays fail-closed. Gate lives at `server/emailGate.ts`. Operator config: `docs/render-env-manifest.md`. Env reference: `docs/env-vars-reference.md`.
- **Carrier Ranking** — the carrier ranking engine prioritizes lane fit; AI adjustments cannot violate the lane-first ordering.

## Pointers
- **Drizzle ORM:** [https://orm.drizzle.team/](https://orm.drizzle.team/)
- **Tailwind CSS:** [https://tailwindcss.com/](https://tailwindcss.com/)
- **shadcn/ui:** [https://ui.shadcn.com/](https://ui.shadcn.com/)
- **Microsoft Graph API:** [https://learn.microsoft.com/en-us/graph/](https://learn.microsoft.com/en-us/graph/)
- **OpenAI API:** [https://platform.openai.com/docs/api-reference](https://platform.openai.com/docs/api-reference)
- **FreightWaves SONAR:** _Populate as you build_
- **Webex Calling API:** _Populate as you build_
- **Clerk Documentation:** _Populate as you build_
- **Contact Promotion Design:** `docs/contact-promotion-design.md`
