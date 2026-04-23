const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();

  console.log('Navigating to /lane-work-queue...');
  await page.goto('http://localhost:5000/lane-work-queue');
  
  // Wait for page to load
  await page.waitForSelector('data-testid=btn-manage-sharing', { timeout: 10000 });
  console.log('Page loaded.');

  console.log('Clicking Manage Sharing button...');
  await page.click('data-testid=btn-manage-sharing');

  console.log('Verifying dialog opens...');
  await page.waitForSelector('data-testid=dialog-account-sharing', { timeout: 5000 });
  
  const searchInput = page.locator('data-testid=input-account-search');
  await expect(searchInput).toBeVisible();

  const accountRow = page.locator('data-testid=row-account-aa84ed7a-1e69-4fe4-8280-a9afd684911c');
  await expect(accountRow).toBeVisible();
  
  const accountName = page.locator('data-testid=text-account-name-aa84ed7a-1e69-4fe4-8280-a9afd684911c');
  await expect(accountName).toHaveText('Browser Test Corp ABC');

  console.log('Testing search filter...');
  await searchInput.fill('ABC');
  // Verify other rows are hidden or count decreases? 
  // Let's just check the target row is still there.
  await expect(accountRow).toBeVisible();
  await searchInput.fill('XYZNonExistent');
  await expect(accountRow).not.toBeVisible();
  await searchInput.fill('');
  await expect(accountRow).toBeVisible();

  console.log('Adding collaborator...');
  const selectTrigger = page.locator('data-testid=select-add-collaborator-aa84ed7a-1e69-4fe4-8280-a9afd684911c');
  await selectTrigger.click();
  // Sophia Gabbitas (e84fc739-2736-4f0c-9d9a-5f88c3a6a7b5)
  await page.click('text=Sophia Gabbitas');
  
  const addButton = page.locator('data-testid=button-add-collaborator-aa84ed7a-1e69-4fe4-8280-a9afd684911c');
  await addButton.click();

  console.log('Verifying collaborator badge...');
  const badge = page.locator('data-testid=badge-collaborator-aa84ed7a-1e69-4fe4-8280-a9afd684911c-e84fc739-2736-4f0c-9d9a-5f88c3a6a7b5');
  await expect(badge).toBeVisible();
  
  // Check for toast
  const toast = page.locator('text=Collaborator added');
  await expect(toast).toBeVisible();

  console.log('Removing collaborator...');
  const removeButton = page.locator('data-testid=button-remove-collaborator-aa84ed7a-1e69-4fe4-8280-a9afd684911c-e84fc739-2736-4f0c-9d9a-5f88c3a6a7b5');
  await removeButton.click();

  console.log('Verifying badge disappears...');
  await expect(badge).not.toBeVisible();
  const removeToast = page.locator('text=Collaborator removed');
  await expect(removeToast).toBeVisible();

  console.log('Closing dialog...');
  await page.keyboard.press('Escape');
  await expect(page.locator('data-testid=dialog-account-sharing')).not.toBeVisible();

  console.log('Test PASSED');
  await browser.close();
})();

async function expect(locator) {
  return {
    toBeVisible: async () => {
      const visible = await locator.isVisible();
      if (!visible) throw new Error(`Element ${locator._selector} is not visible`);
    },
    not.toBeVisible: async () => {
      const visible = await locator.isVisible();
      if (visible) throw new Error(`Element ${locator._selector} should not be visible`);
    },
    toHaveText: async (text) => {
      const actual = await locator.innerText();
      if (actual !== text) throw new Error(`Expected text "${text}", got "${actual}"`);
    }
  };
}
