import { expect, test } from './fixtures';

test.describe('settings', () => {
  test('are grouped, with every page one link away', async ({ page }) => {
    await page.goto('/settings');
    const nav = page.getByRole('navigation', { name: 'Settings' });
    for (const name of [
      'Appearance',
      'Domain & HTTPS',
      'Notifications',
      'Platform pages',
      'Password & tokens',
      'Deploy keys',
      'Image registries',
      'Template registries',
      'Servers',
      'Platform services',
      'Storage & cleanup',
      'Connection',
    ])
      await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  });

  test('old addresses land on the new page', async ({ page }) => {
    await page.goto('/settings/security');
    await expect(page).toHaveURL(/\/settings\/access$/);
    await page.goto('/settings/api-keys');
    await expect(page).toHaveURL(/\/settings\/deploy-keys$/);
    await page.goto('/settings/general#domain');
    await expect(page).toHaveURL(/\/settings\/domain$/);
    await page.goto('/settings/infrastructure?keep=2#storage');
    await expect(page).toHaveURL(/\/settings\/storage\?keep=2$/);
  });

  test('the password form stays closed until asked for', async ({ page }) => {
    await page.goto('/settings/access');
    await expect(page.getByLabel('Current password')).toHaveCount(0);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByLabel('Current password')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Current password')).toHaveCount(0);
  });
});
