const { test, expect } = require('@playwright/test');

test('Manage Sharing feature', async ({ page }) => {
  await page.goto('/lane-work-queue');
  
  // 3. In the LWQ header, find the "Manage Sharing" button
  const manageSharingBtn = page.locator('data-testid=btn-manage-sharing');
  await expect(manageSharingBtn).toBeVisible();
  await manageSharingBtn.click();

  // 4. Verify a dialog opens
  const dialog = page.locator('data-testid=dialog-account-sharing');
  await expect(dialog).toBeVisible();
  
  const searchInput = page.locator('data-testid=input-account-search');
  await expect(searchInput).toBeVisible();

  // Check for account row
  const accountRow = page.locator('data-testid=row-account-aa84ed7a-1e69-4fe4-8280-a9afd684911c');
  await expect(accountRow).toBeVisible();
  
  const accountName = page.locator('data-testid=text-account-name-aa84ed7a-1e69-4fe4-8280-a9afd684911c');
  await expect(accountName).toHaveText('Browser Test Corp ABC');

  // 5. Type an account name fragment into the search input
  await searchInput.fill('ABC');
  await expect(accountRow).toBeVisible();
  await searchInput.fill('XYZNonExistent');
  await expect(accountRow).not.toBeVisible();
  await searchInput.fill('');
  await expect(accountRow).toBeVisible();

  // 6. Pick one account row, open its add-collaborator dropdown, select a teammate, and click "Add".
  const selectTrigger = page.locator('data-testid=select-add-collaborator-aa84ed7a-1e69-4fe4-8280-a9afd684911c');
  await selectTrigger.click();
  
  // Sophia Gabbitas
  await page.click('text=Sophia Gabbitas');
  
  const addButton = page.locator('data-testid=button-add-collaborator-aa84ed7a-1e69-4fe4-8280-a9afd684911c');
  await addButton.click();

  // Verify: A toast appears saying "Collaborator added"
  await expect(page.locator('text=Collaborator added')).toBeVisible();
  
  // Verify: The row now shows that person as a Badge with an "X" remove button
  const badge = page.locator('data-testid=badge-collaborator-aa84ed7a-1e69-4fe4-8280-a9afd684911c-e84fc739-2736-4f0c-9d9a-5f88c3a6a7b5');
  await expect(badge).toBeVisible();
  const removeBtn = page.locator('data-testid=button-remove-collaborator-aa84ed7a-1e69-4fe4-8280-a9afd684911c-e84fc739-2736-4f0c-9d9a-5f88c3a6a7b5');
  await expect(removeBtn).toBeVisible();

  // 7. Click the X on the badge. 
  await removeBtn.click();
  
  // Verify: A toast appears saying "Collaborator removed"
  await expect(page.locator('text=Collaborator removed')).toBeVisible();
  // Verify: The badge disappears
  await expect(badge).not.toBeVisible();

  // 8. Close the dialog
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});
