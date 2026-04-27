// Task #742 — AI Hub consolidation smoke tests.
//
// What this protects:
//   1) The sidebar exposes exactly one "AI" entry that opens the hub
//      (the previous implementation scattered seven AI surfaces across
//      Customer-Facing, AI, and Admin groups).
//   2) Visiting /ai-hub renders the tabbed hub shell and uses the
//      `?hub=` query namespace (NOT `?tab=`, which collides with
//      ValueIQ's internal tab state).
//   3) Every legacy URL — /daily-priorities, /valueiq, /email-intelligence,
//      /contact-suggestions, /ai, /admin/ai-engagement, /admin/copilot-analytics
//      — still works and pre-selects the matching tab inside the hub.
//   4) Each visible hub tab actually mounts its underlying page (we
//      assert one stable per-page marker so a future broken import
//      surfaces here, not in production).
//
// The tests stay deliberately shallow: the hub is composition-only and
// each underlying page has its own deeper coverage.
const { test, expect } = require('@playwright/test');

const HUB_PAGE_TESTID = 'page-ai-hub';
const ACTIVE_TAB_ATTR = 'data-state'; // Radix Tabs uses data-state="active"

// (legacy URL → expected active tab key) for all seven surfaces.
// These pairs ARE the contract: if a legacy URL stops resolving to its
// matching tab, this test fails loudly before users notice.
const LEGACY_URL_TO_TAB = [
  ['/daily-priorities',         'priorities'],
  ['/valueiq',                  'valueiq'],
  ['/email-intelligence',       'email'],
  ['/contact-suggestions',      'contacts'],
  ['/ai',                       'center'],
  ['/admin/ai-engagement',      'engagement'],
  ['/admin/copilot-analytics',  'copilot'],
];

// (tab key → a stable per-page marker that proves the underlying page
// component actually mounted, not just an empty body wrapper). For pages
// without a top-level page-* testid we pick a stable inner element that
// has been around since well before this task.
const TAB_TO_PAGE_MARKER = {
  priorities: '[data-testid="page-daily-priorities"]',
  valueiq:    '[data-testid="text-valueiq-title"]',
  email:      '[data-testid="tab-urgency"]', // Email Intel's first inner tab
  contacts:   'h1, h2',                       // Contact Suggestions has no testid yet — any heading proves it rendered
  center:     '[data-testid="page-ai-center"]',
  engagement: '[data-testid="page-ai-engagement"]',
  copilot:    '[data-testid="page-copilot-analytics"]',
};

test.describe('AI Hub consolidation (Task #742)', () => {
  test('sidebar exposes exactly one AI entry and it opens /ai-hub', async ({ page }) => {
    await page.goto('/dashboard');

    const aiLink = page.getByTestId('link-ai-hub');
    await expect(aiLink).toBeVisible({ timeout: 15_000 });

    // The seven legacy sidebar entries are gone — the hub is the only
    // entrypoint. We probe for the testids the previous sidebar exposed
    // and confirm none of them survive.
    const removedTestIds = [
      'link-today\'s-priorities',
      'link-valueiq',
      'link-email-intelligence',
      'link-contact-suggestions',
      'link-ai-center',
      'link-ai-engagement',
      'link-copilot-analytics',
    ];
    for (const tid of removedTestIds) {
      const remainingCount = await page.locator(`[data-testid="${tid}"]`).count();
      expect(remainingCount, `Sidebar still has legacy AI row "${tid}"`).toBe(0);
    }

    // Clicking the AI row navigates to /ai-hub and renders the hub shell.
    await aiLink.click();
    await expect(page).toHaveURL(/\/ai-hub(\?|$)/);
    await expect(page.getByTestId(HUB_PAGE_TESTID)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('ai-hub-tabbar')).toBeVisible();
  });

  test('/ai-hub renders the tabbed hub with Today\'s Priorities active by default', async ({ page }) => {
    await page.goto('/ai-hub');

    await expect(page.getByTestId(HUB_PAGE_TESTID)).toBeVisible({ timeout: 15_000 });

    // Default tab is priorities — its tab trigger is data-state="active".
    const prioritiesTab = page.getByTestId('ai-hub-tab-priorities');
    await expect(prioritiesTab).toHaveAttribute(ACTIVE_TAB_ATTR, 'active', { timeout: 10_000 });

    // The matching panel is mounted.
    await expect(page.getByTestId('ai-hub-body-priorities')).toBeVisible();
  });

  test('every legacy URL still works and lands on the matching tab', async ({ page }) => {
    for (const [url, expectedTab] of LEGACY_URL_TO_TAB) {
      await page.goto(url);

      // Hub shell is up — proves the route resolved to AiHubPage rather
      // than a 404 or one of the old standalone pages.
      await expect(
        page.getByTestId(HUB_PAGE_TESTID),
        `Legacy URL ${url} should render the AI Hub`,
      ).toBeVisible({ timeout: 15_000 });

      // The expected tab is the active one. We scope by testid because
      // Radix sets data-state on every trigger and we want to assert
      // about exactly one of them.
      const activeTab = page.getByTestId(`ai-hub-tab-${expectedTab}`);
      await expect(
        activeTab,
        `Legacy URL ${url} should pre-select tab "${expectedTab}"`,
      ).toHaveAttribute(ACTIVE_TAB_ATTR, 'active', { timeout: 10_000 });

      // The matching tab body is mounted (we don't assert about its
      // contents — each page has its own tests).
      await expect(
        page.getByTestId(`ai-hub-body-${expectedTab}`),
        `Legacy URL ${url} should mount body for tab "${expectedTab}"`,
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test('clicking a hub tab updates the URL with ?hub= (not ?tab=) and mounts that page', async ({ page }) => {
    // Start on the hub default and click ValueIQ — the tab the
    // namespace-collision regression would have broken.
    await page.goto('/ai-hub');
    await expect(page.getByTestId(HUB_PAGE_TESTID)).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('ai-hub-tab-valueiq').click();

    // Canonical hub URL uses `hub=` so it doesn't shadow ValueIQ's own
    // internal `?tab=` state.
    await expect(page).toHaveURL(/\/ai-hub\?hub=valueiq/);
    await expect(page.getByTestId('ai-hub-tab-valueiq')).toHaveAttribute(
      ACTIVE_TAB_ATTR, 'active', { timeout: 10_000 },
    );
    await expect(page.getByTestId('ai-hub-body-valueiq')).toBeVisible();
    // ValueIQ's actual page header rendered → its internal Tabs are
    // still healthy, which is exactly what the namespace fix protects.
    await expect(page.getByTestId('text-valueiq-title')).toBeVisible({ timeout: 15_000 });
  });

  test('every visible hub tab mounts its underlying page', async ({ page }) => {
    await page.goto('/ai-hub');
    await expect(page.getByTestId(HUB_PAGE_TESTID)).toBeVisible({ timeout: 15_000 });

    // Iterate the rendered tab triggers (so we only walk tabs the
    // current user actually sees) rather than hard-coding a list.
    const triggers = page.locator('[data-testid^="ai-hub-tab-"]');
    const tabKeys = await triggers.evaluateAll((els) =>
      els
        .map((e) => e.getAttribute('data-testid') || '')
        .map((t) => t.replace(/^ai-hub-tab-/, ''))
        // The body badge testid follows the same prefix; filter it out.
        .filter((k) => k && !k.startsWith('badge-')),
    );

    expect(tabKeys.length, 'expected at least one visible AI Hub tab').toBeGreaterThan(0);

    for (const key of tabKeys) {
      await page.getByTestId(`ai-hub-tab-${key}`).click();
      await expect(page.getByTestId(`ai-hub-tab-${key}`)).toHaveAttribute(
        ACTIVE_TAB_ATTR, 'active', { timeout: 10_000 },
      );
      await expect(page.getByTestId(`ai-hub-body-${key}`)).toBeVisible({ timeout: 10_000 });

      const marker = TAB_TO_PAGE_MARKER[key];
      if (marker) {
        // The underlying page rendered something concrete — proves
        // we didn't silently mount an empty wrapper.
        await expect(
          page.locator(`[data-testid="ai-hub-body-${key}"] ${marker}`).first(),
          `Tab "${key}" should render its underlying page (marker: ${marker})`,
        ).toBeVisible({ timeout: 15_000 });
      }
    }
  });
});
