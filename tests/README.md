# `tests/` — Playwright + integration suites

This directory contains the project's automated test suites. Most files are
Playwright browser-driven specs (`*.spec.cjs`) that exercise the running dev
server end-to-end; a smaller set of `*.test.ts` files are Vitest integration
tests for storage / pure server modules.

## Running

The Playwright runner is wired through `playwright.config.cjs`. The dev server
(`npm run dev` → port `5000`) must already be up; the config does **not**
spawn one.

```bash
# all Playwright specs
npx playwright test --config=playwright.config.cjs

# a single spec
npx playwright test --config=playwright.config.cjs tests/<spec>.spec.cjs --workers=4

# a single test by name
npx playwright test --config=playwright.config.cjs tests/<spec>.spec.cjs --grep "<title fragment>"
```

Vitest integration files run via:

```bash
npx vitest run tests/<file>.test.ts
```

## Auth

All Playwright specs assume the dev-only auth bypass is active:

- `DEV_AUTH_BYPASS_USER_ID` env var → the user that browser-driven requests
  authenticate as. The dev workflow injects this automatically.
- API requests issued from a separate Playwright `request` context (see
  `lane-system-e2e.spec.cjs`) inherit the same bypass — no cookie required.

## Suite catalog

### `lane-system-e2e.spec.cjs` — Lane System E2E (task #703)

Browser-driven coverage for the four cross-linked lane surfaces:

- `/available-freight` (Available Freight)
- `/lanes/work-queue`  (Lane Work Queue)
- `/carrier-hub`       (Carrier Hub)
- `/lane-inbox`        (Lane Inbox)

What it asserts:

1. **Cross-tab breadcrumb contract** — every surface, when arrived at with
   `?from=<sourceSlug>&fromQuery=<encoded>`, renders
   `[data-testid="breadcrumb-cross-tab-<target>"]`, exposes a back-link
   `[data-testid="breadcrumb-link-<source>"]` whose `href` rebuilds the
   source URL with the captured query, and shows a non-clickable
   `[data-testid="breadcrumb-current-<target>"]` label. Direct visits
   (no `?from=`) render no breadcrumb.
2. **Lane Work Queue filter persistence** — `?highFreq=1&manual=1&customer=X`
   lights the matching filter chips on first paint, and clicking
   "Clear all filters" wipes both the chips and the URL search string.
3. **Lane assignment + SSE cross-tab sync** — assigning a lane in one tab
   moves it out of the unassigned bucket on a second tab without a manual
   reload, driven by the `recurring_lane` SSE topic. A separate test issues
   a reassignment `PATCH /api/recurring-lanes/:id` from an out-of-band
   request context and asserts the open Lane Inbox surfaces a new
   "Lane reassigned" row via the same SSE invalidation pipe.

#### Fixture seeding

`test.beforeAll` resolves the dev-bypass user's organization, picks an
existing company in that org for FK validity, and inserts **two**
independent recurring-lane fixtures (one per SSE scenario) so the two
SSE tests can run in parallel workers without trampling each other.
Each lane:

- has a stamped, suite-unique `company_name` (`E2E Customer <stamp>`) so it
  lands in its own customer group in the LWQ — keeps assertions isolated
  from any pre-existing manual lanes;
- is mirrored into `lane_summary_cache` (the LWQ fast path reads from the
  cache, not the underlying `recurring_lanes` table).

`test.afterAll` deletes the seeded lanes plus any cascading
`carrier_outreach_logs`, `tasks`, and `notifications` rows. The shared `pg`
pool is intentionally **not** closed; Playwright's worker reuse can call
`beforeAll` again on the same module instance, which would hit
"Cannot use a pool after calling end on the pool".

#### Test mode / parallelism

The whole file runs in `parallel` mode (`test.describe.configure`). Each
test owns its own seeded lane (`seeded.assign` vs `seeded.reassign`) so
parallelism is safe.

#### Performance budget

The suite runs in **under 60s in CI** with `--workers=4`. Local runs can
land 5–15s higher under dev-server (Vite) contention. The dominant cost is
the assignment SSE test (two browser contexts + SSE round-trip).

#### Server contract dependencies

The SSE assignment test depends on
`POST /api/recurring-lanes/:laneId/assign` calling
`publishLiveSync(orgId, "recurring_lane", laneId)` so the second tab's
work-queue subscription invalidates and refetches. The reassignment test
depends on `PATCH /api/recurring-lanes/:id` writing a
`carrier_outreach_logs` row with `outreach_mode = "reassignment"` AND
publishing the same SSE topic, which the lane-inbox query subscribes to.

### Other suites

The remaining specs cover individual feature flows (Available Freight
"Make Recurring", AI engagement persistence, carrier import, shared
inbox, etc.). They follow the same dev-bypass auth and Playwright config
conventions as above.
