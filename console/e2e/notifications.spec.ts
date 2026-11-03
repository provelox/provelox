import { removeThrowawayWebhooks } from './api';
import { expect, test } from './fixtures';

test.afterEach(removeThrowawayWebhooks);

test('a webhook can be added and removed, and its secret address is never shown', async ({
  page,
}) => {
  await page.goto('/settings/notifications');
  await expect(
    page.getByRole('heading', { name: 'Notifications', level: 2 }),
  ).toBeVisible();

  await page.getByLabel('Webhook name').fill('e2e-hook');
  await page
    .getByLabel('Webhook address')
    .fill('https://hooks.example.com/services/SECRET-E2E-TOKEN');
  await page.getByRole('button', { name: 'Add webhook' }).click();

  // the webhook's own row (the toast that says it was added is a list item too)
  const item = page
    .getByRole('listitem')
    .filter({ hasText: 'e2e-hook' })
    .filter({ has: page.getByRole('button', { name: 'Send a test' }) });
  await expect(item).toBeVisible();
  await expect(item).toContainText('hooks.example.com');
  await expect(page.getByText('SECRET-E2E-TOKEN')).toHaveCount(0);

  await page.getByRole('button', { name: 'Remove e2e-hook' }).click();
  await expect(item).toHaveCount(0);
});

test('the events can be switched off and on', async ({ page }) => {
  await page.goto('/settings/notifications');
  const sw = page.getByRole('switch', { name: 'A certificate is running out' });
  const before = await sw.getAttribute('aria-checked');
  await sw.click();
  await expect(sw).not.toHaveAttribute('aria-checked', before ?? '');
  // put it back as it was found
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', before ?? '');
});
