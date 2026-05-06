// Task #749 — Email Intelligence → Response Time tab → per-rep
// leaderboard clock-clarity UI test.
//
// The leaderboard previously did not say which clock its Avg/Median
// were measured against, leaving viewers unable to tell why a rep's
// "20m avg" was good or bad. Task #749 added an explicit clock
// indicator in the leaderboard card header plus Info-icon tooltips
// on the Avg and Median columns. This test pins:
//   1) The leaderboard card header shows a clock label that contains
//      "Business hours (M–F 8a–6p ET)" by default.
//   2) Toggling the page-level "Business hours only" switch flips
//      the leaderboard label to "Wall-clock" without a reload.
//   3) Toggling back restores the business-hours label.
//
// Tooltip render (Avg/Median Info icons) is verified at the
// service/UI layer in the runTest harness; this Playwright spec
// keeps the must-have header-flip assertion stable in CI.
const { test, expect } = require('@playwright/test');

test.describe('Response Time leaderboard exposes its clock basis (Task #749)', () => {
  test('clock label flips with the business-hours toggle', async ({ page }) => {
    await page.goto('/email-intelligence');

    // The Response Time tab is one of the tabs on the Email Intelligence
    // page. Click it to make the leaderboard card render.
    const responseTimeTab = page.getByRole('tab', { name: /response time/i });
    await expect(responseTimeTab).toBeVisible({ timeout: 20_000 });
    await responseTimeTab.click();

    // Leaderboard card lives below the KPI / SLA / trend / heatmap
    // sections — scroll it into view before asserting.
    const leaderboardCard = page.getByTestId('card-rt-leaderboard');
    await leaderboardCard.scrollIntoViewIfNeeded();
    await expect(leaderboardCard).toBeVisible({ timeout: 20_000 });

    const clockLabel = page.getByTestId('text-rt-leaderboard-clock');
    await expect(clockLabel).toBeVisible();
    // Default page state: businessHours = true.
    await expect(clockLabel).toContainText('Business hours (M–F 8a–6p ET)');

    // Toggle business hours off — leaderboard must reflect Wall-clock.
    const bizHoursSwitch = page.getByTestId('switch-rt-business-hours');
    await expect(bizHoursSwitch).toBeVisible();
    await bizHoursSwitch.click();
    await expect(clockLabel).toContainText('Wall-clock');

    // Toggle back on — leaderboard must reflect Business hours again.
    await bizHoursSwitch.click();
    await expect(clockLabel).toContainText('Business hours (M–F 8a–6p ET)');
  });
});
