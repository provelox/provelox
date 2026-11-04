import { expect, test } from './fixtures';

test.describe('updates', () => {
  test('the page says which release runs, and the check can be switched off', async ({
    page,
  }) => {
    await page.goto('/settings/updates');
    await expect(
      page.getByRole('heading', { name: 'Updates', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('running-version')).toBeVisible();
    await expect(
      page.getByRole('switch', { name: 'Check for new releases' }),
    ).toBeVisible();
    // updating is a deliberate step on this page, never something a visit starts
    await expect(page.getByTestId('update-progress')).toHaveCount(0);
  });
});
