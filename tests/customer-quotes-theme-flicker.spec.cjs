// Task #650 — Customer Quotes theme flicker fix.
//
// The previous implementation set/reset the global `dark` class on
// `document.documentElement` on mount/unmount, which produced a visible
// flicker on every navigation in or out of the page. The fix scopes the
// theme to a page-root wrapper. These tests prove:
//   1) Visiting Customer Quotes with cq-theme=dark does NOT add the
//      `dark` class to <html>; the class lives on the page wrapper only.
//   2) Toggling theme on the page flips the wrapper class but never the
//      <html> class.
//   3) The cq-theme localStorage key still persists across reloads.
//   4) Navigating away from Customer Quotes leaves the global <html>
//      class untouched (no flicker for the rest of the app).
const { test, expect } = require('@playwright/test');

test.describe('Customer Quotes theme is page-scoped (Task #650)', () => {
  // Each Playwright test gets a fresh BrowserContext, so localStorage
  // starts empty. We do NOT register a global beforeEach init script —
  // it would also fire on `page.reload()` and stomp on the `cq-theme`
  // value that the persistence test deliberately leaves behind.

  test('visiting page with cq-theme=dark scopes dark to the wrapper, not <html>', async ({ page }) => {
    // Pre-seed cq-theme=dark *before* the SPA boots.
    await page.addInitScript(() => {
      try { window.localStorage.setItem('cq-theme', 'dark'); } catch (_e) { /* ignore */ }
    });

    await page.goto('/customer-quotes');
    const wrapper = page.getByTestId('page-customer-quotes');
    await expect(wrapper).toBeVisible({ timeout: 15_000 });

    // Wrapper carries the dark class.
    await expect(wrapper).toHaveAttribute('data-cq-theme', 'dark');
    await expect(wrapper).toHaveClass(/(^|\s)dark(\s|$)/);

    // <html> does NOT.
    const htmlHasDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(htmlHasDark).toBe(false);
  });

  test('page-level toggle flips the wrapper class only, never <html>', async ({ page }) => {
    await page.goto('/customer-quotes');
    const wrapper = page.getByTestId('page-customer-quotes');
    await expect(wrapper).toBeVisible({ timeout: 15_000 });

    // Default = light (cq-theme cleared in beforeEach).
    await expect(wrapper).toHaveAttribute('data-cq-theme', 'light');
    await expect(wrapper).not.toHaveClass(/(^|\s)dark(\s|$)/);
    let htmlDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(htmlDark).toBe(false);

    // Click the toggle → wrapper becomes dark.
    await page.getByTestId('button-toggle-theme').click();
    await expect(wrapper).toHaveAttribute('data-cq-theme', 'dark');
    await expect(wrapper).toHaveClass(/(^|\s)dark(\s|$)/);

    // <html> must remain unchanged the whole time.
    htmlDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(htmlDark).toBe(false);

    // Click again → wrapper back to light.
    await page.getByTestId('button-toggle-theme').click();
    await expect(wrapper).toHaveAttribute('data-cq-theme', 'light');
    await expect(wrapper).not.toHaveClass(/(^|\s)dark(\s|$)/);
    htmlDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(htmlDark).toBe(false);
  });

  test('cq-theme persists across reload', async ({ page }) => {
    await page.goto('/customer-quotes');
    const wrapper = page.getByTestId('page-customer-quotes');
    await expect(wrapper).toBeVisible({ timeout: 15_000 });

    // Toggle to dark and confirm it persisted.
    await page.getByTestId('button-toggle-theme').click();
    await expect(wrapper).toHaveAttribute('data-cq-theme', 'dark');
    const stored = await page.evaluate(() => window.localStorage.getItem('cq-theme'));
    expect(stored).toBe('dark');

    // Reload — wrapper should rehydrate to dark, <html> still untouched.
    await page.reload();
    const w2 = page.getByTestId('page-customer-quotes');
    await expect(w2).toBeVisible({ timeout: 15_000 });
    await expect(w2).toHaveAttribute('data-cq-theme', 'dark');
    const htmlDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(htmlDark).toBe(false);
  });

  test('when global theme is dark, <html>.dark stays true through visit/toggle/exit', async ({ page }) => {
    // Pre-seed the GLOBAL theme dark and the page-scoped theme light to
    // prove the page never stomps on global state in either direction.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('theme', 'dark');
        window.localStorage.setItem('cq-theme', 'light');
      } catch (_e) { /* ignore */ }
    });

    // Hit a non-CQ page first so the global ThemeToggle hydrates and adds
    // `dark` to <html>.
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await expect
      .poll(async () => page.evaluate(() =>
        document.documentElement.classList.contains('dark'),
      ), { timeout: 10_000 })
      .toBe(true);

    // Visit Customer Quotes — wrapper is light (cq-theme=light), but
    // <html>.dark must stay true (the global preference is unchanged).
    await page.goto('/customer-quotes');
    const wrapper = page.getByTestId('page-customer-quotes');
    await expect(wrapper).toBeVisible({ timeout: 15_000 });
    await expect(wrapper).toHaveAttribute('data-cq-theme', 'light');
    await expect(wrapper).not.toHaveClass(/(^|\s)dark(\s|$)/);
    let htmlDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(htmlDark).toBe(true);

    // Toggle the page theme — only the wrapper flips. <html> still dark.
    await page.getByTestId('button-toggle-theme').click();
    await expect(wrapper).toHaveAttribute('data-cq-theme', 'dark');
    htmlDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(htmlDark).toBe(true);

    // Navigate away — global state still reflects the user's `theme=dark`
    // preference. Poll because ThemeToggle re-applies the class from
    // localStorage in a useEffect after mount on this fresh page load.
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await expect
      .poll(async () => page.evaluate(() =>
        document.documentElement.classList.contains('dark'),
      ), { timeout: 10_000 })
      .toBe(true);
  });

  test('navigating away from Customer Quotes leaves <html> unchanged', async ({ page }) => {
    // Seed dark on Customer Quotes.
    await page.addInitScript(() => {
      try { window.localStorage.setItem('cq-theme', 'dark'); } catch (_e) { /* ignore */ }
    });

    await page.goto('/customer-quotes');
    const wrapper = page.getByTestId('page-customer-quotes');
    await expect(wrapper).toBeVisible({ timeout: 15_000 });

    // Confirm wrapper is dark and <html> is light at the start.
    await expect(wrapper).toHaveClass(/(^|\s)dark(\s|$)/);
    let htmlDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(htmlDark).toBe(false);

    // Navigate to a different in-app route. SPA route change unmounts
    // the page; the global <html> class must NOT change.
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');

    htmlDark = await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    );
    expect(htmlDark).toBe(false);

    // Sanity: Customer Quotes wrapper is gone.
    await expect(page.getByTestId('page-customer-quotes')).toHaveCount(0);
  });

  test('CSS scoping: wrapper light vars override inherited <html>.dark vars', async ({ page }) => {
    // Force <html> to dark globally; force the page to light. The wrapper
    // must re-assert the light --background variable so child elements get
    // the light color, even though they live inside <html class="dark">.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('theme', 'dark');
        window.localStorage.setItem('cq-theme', 'light');
      } catch (_e) { /* ignore */ }
    });

    // Bring up the global dark mode first.
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');
    await expect
      .poll(async () => page.evaluate(() =>
        document.documentElement.classList.contains('dark'),
      ), { timeout: 10_000 })
      .toBe(true);

    await page.goto('/customer-quotes');
    const wrapper = page.getByTestId('page-customer-quotes');
    await expect(wrapper).toBeVisible({ timeout: 15_000 });
    await expect(wrapper).toHaveAttribute('data-cq-theme', 'light');

    // The wrapper's resolved --background must equal the light value
    // (the same value an isolated wrapper outside .dark would resolve to),
    // proving the cascade was broken by `.light` re-asserting :root vars.
    const bgInsideWrapper = await wrapper.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--background').trim(),
    );
    const bgOnHtml = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
    );
    expect(bgInsideWrapper).not.toBe('');
    expect(bgInsideWrapper).not.toBe(bgOnHtml);
  });

  test('overlays portal into the page wrapper, not document.body', async ({ page }) => {
    // Seed page=dark + global=light to maximize the visual delta between
    // an unscoped portal (would inherit body/light) and a scoped portal
    // (must inherit wrapper/dark).
    await page.addInitScript(() => {
      try { window.localStorage.setItem('cq-theme', 'dark'); } catch (_e) { /* ignore */ }
    });

    await page.goto('/customer-quotes');
    const wrapper = page.getByTestId('page-customer-quotes');
    await expect(wrapper).toBeVisible({ timeout: 15_000 });
    await expect(wrapper).toHaveAttribute('data-cq-theme', 'dark');

    // Open the customer combobox (Popover) — its content must portal into
    // [data-testid="cq-overlay-portal"], which is a child of the wrapper.
    await page.getByTestId('combobox-customer').click();

    // Radix uses [role="listbox"] / [data-radix-popper-content-wrapper].
    // We assert the portal target hosts the popper wrapper.
    const portalHostsPopper = await page.evaluate(() => {
      const portal = document.querySelector('[data-testid="cq-overlay-portal"]');
      if (!portal) return false;
      // Any popper-content-wrapper rendered by Radix should now live inside.
      return !!portal.querySelector('[data-radix-popper-content-wrapper]');
    });
    expect(portalHostsPopper).toBe(true);

    // Now also exercise a Dialog from an imported child component
    // (MarginFloorsSettings) — the architect flagged these as a leak
    // vector if the portal target wasn't shared via the exported context.
    // Close the popover by pressing Escape so it doesn't intercept clicks.
    await page.keyboard.press('Escape');
    await page.getByTestId('button-open-margin-floors').click();
    const dialogInsidePortal = await page.evaluate(() => {
      const portal = document.querySelector('[data-testid="cq-overlay-portal"]');
      if (!portal) return false;
      return !!portal.querySelector('[data-testid="dialog-margin-floors"]');
    });
    expect(dialogInsidePortal).toBe(true);

    // And the body should NOT host that popper wrapper anywhere outside
    // the page wrapper subtree (i.e. nothing leaked to document.body root).
    const leakedToBodyRoot = await page.evaluate(() => {
      const wrapperEl = document.querySelector('[data-testid="page-customer-quotes"]');
      const all = Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper]'));
      return all.some(n => !wrapperEl?.contains(n));
    });
    expect(leakedToBodyRoot).toBe(false);
  });
});
