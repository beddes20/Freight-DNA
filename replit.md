# FreightDNA
FreightDNA is a mini CRM application designed to empower transportation brokerage sales teams by managing customer accounts, contacts, and shipping data to boost sales efficiency and revenue.

## Run & Operate
- **Run:** `npm start`
- **Build:** `npm run build`
- **Typecheck:** `npm run typecheck`
- **Codegen:** `npm run codegen`
- **DB Push:** `drizzle-kit push:pg`
- **Environment Variables:** `DATABASE_URL`, `OPENAI_API_KEY`, `MICROSOFT_GRAPH_CLIENT_ID`, `MICROSOFT_GRAPH_CLIENT_SECRET`, `RESEND_API_KEY`

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
- **Customer Quotes & Account Ownership:** Modifying `applyFilters`, `loadContext`, `enrich`, `attachResponseTimes`, or the `__none__` resolver in `server/services/customerQuotes.ts` requires updating `docs/customer-quotes-stability-contract.md` and `tests/code-quality-guardrails.test.ts` (Section 1100).
- **Unified ReplitDailyUpload:** Changes to financials or available freight upload logic (Task #1051) must maintain consistency with `freight_daily_upload_fact` and pass Section 1051 guardrails.
- **Email Ingestion:** The `processUserMailboxEmail` helper has specific logic for `PERSIST-UNKNOWN` and `TOMBSTONE-DROP` emails; do not reintroduce `DROP-GATE` behavior.
- **Carrier Ranking:** The carrier ranking engine prioritizes lane fit; AI adjustments cannot violate the lane-first ordering.

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