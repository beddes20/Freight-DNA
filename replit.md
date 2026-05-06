# FreightDNA

FreightDNA is a CRM application that empowers transportation brokerage sales teams to manage accounts, contacts, and shipping data, aiming to boost sales efficiency and revenue.

## Run & Operate

_Populate as you build_

## Stack

- **Frontend**: React, TypeScript, Tailwind CSS, `shadcn/ui`
- **Backend**: Express.js
- **Database**: PostgreSQL (via Drizzle ORM)
- **Runtime**: Node.js (version implied by Express.js usage)
- **Build Tool**: _Populate as you build_
- **ORM**: Drizzle ORM
- **Validation**: _Populate as you build_

## Where things live

- `client/`: Frontend React application.
- `server/`: Backend Express.js application.
  - `server/routes/`: API endpoints.
  - `server/services/`: Business logic and data manipulation.
  - `server/storage.ts`: Database interaction logic.
  - `server/agent/`: AI runtime components.
  - `server/agentic/`: AI control and autonomy layers.
- `docs/`: Project documentation.
  - `docs/customer-quotes-stability-contract.md`: Defines customer quotes and account ownership stability.
  - `docs/unified-replit-daily-upload.md`: Details unified daily upload process.
  - `docs/production-parity-audit.md`: Audits production parity.
- `tests/code-quality-guardrails.test.ts`: Enforces code quality and stability contracts.
- `package.json`: Project dependencies and scripts.
- `drizzle.config.ts`: Drizzle ORM configuration (schema source of truth).

## Architecture decisions

-   **Zero-new-error philosophy**: Express handlers normalize request parameters to prevent new errors.
-   **Role-Based Access Control (RBAC)**: Dynamic, session-based authentication ensures data visibility based on user roles.
-   **AI-driven insights**: Integration of OpenAI models for features like talking points, health scores, email drafting, and next-best-action recommendations.
-   **Multi-layered caching and performance optimization**: Server-side and in-memory caching, keyset pagination, and optimized dashboard queries improve application responsiveness.
-   **Unified data source for financial and freight data**: Financials, Available Freight, and Lane Work Queue share a single `freight_daily_upload_fact` table.

## Product

-   Comprehensive CRM for managing customer accounts, contacts, and shipping data.
-   AI-assisted RFP and Award management with Excel upload capabilities.
-   Advanced analytics for lane research, coverage gaps, and wallet share analysis.
-   User and team management functionalities.
-   Data integration via global search and OneDrive sync.
-   AI-powered features including talking points, health score narratives, touchpoint summaries, proactive nudges, and email drafting.
-   Next Best Action (NBA) engine for daily task recommendations.
-   Lane Work Queue (LWQ) for managing assignable lane workflows.
-   Carrier Hub for intelligence and Rate Intelligence with AI coaching.
-   Email Intelligence for capturing contacts, integrating two-way emails, and extracting intent signals.
-   Quote Lifecycle Autopilot for automated quote processing.
-   Automated email syncing, Tactical Learning Engine, and weekly account reviews.
-   Webex Calling integration and Call Performance Hub.
-   Admin-facing features for external service health monitoring, agent administration, and carrier scoring configuration.

## User preferences

I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## Gotchas

-   `processUserMailboxEmail` no longer silently drops inbound emails from unknown senders; they are now persisted with `linkedAccountId = NULL` and `linkedCarrierId = NULL`, creating a new `email_conversation_thread`.
-   When modifying `applyFilters`, `loadContext`, `enrich`, `attachResponseTimes`, or the `__none__` resolver in `server/services/customerQuotes.ts`, `docs/customer-quotes-stability-contract.md` and Section 1100 of `tests/code-quality-guardrails.test.ts` must be updated in the same commit.
-   Carrier ranking engine prioritizes lane fit and carrier profile over customer history.

## Pointers

-   **React Documentation**: [https://react.dev/](https://react.dev/)
-   **Express.js Documentation**: [https://expressjs.com/](https://expressjs.com/)
-   **Drizzle ORM Documentation**: [https://orm.drizzle.team/](https://orm.drizzle.team/)
-   **Tailwind CSS Documentation**: [https://tailwindcss.com/docs](https://tailwindcss.com/docs)
-   **shadcn/ui Documentation**: [https://ui.shadcn.com/docs](https://ui.shadcn.com/docs)
-   **PostgreSQL Documentation**: [https://www.postgresql.org/docs/](https://www.postgresql.org/docs/)
-   **Microsoft Graph API Documentation**: [https://learn.microsoft.com/en-us/graph/](https://learn.microsoft.com/en-us/graph/)
-   **OpenAI API Documentation**: [https://platform.openai.com/docs/](https://platform.openai.com/docs/)