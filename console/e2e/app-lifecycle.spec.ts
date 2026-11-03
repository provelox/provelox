import { removeThrowawayApps } from './api';
import { expect, test, throwawayName } from './fixtures';

test.afterEach(removeThrowawayApps);

test('an app can be created, looked at, and deleted', async ({ page }) => {
  const name = throwawayName();

  // create it from the New menu
  await page.goto('/apps');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: /^App/ }).click();
  await page.getByLabel('App name').fill(name);
  for (let i = 0; i < 3; i++)
    await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Create app' }).click();
  await expect(
    page.getByRole('heading', { name: `${name} is created` }),
  ).toBeVisible();

  // it has the five tabs, and cannot be restarted before anything is deployed
  await page.goto(`/apps/${name}`);
  for (const tab of [
    'Overview',
    'Configuration',
    'Networking',
    'Deployments',
    'Logs',
  ])
    await expect(
      page.getByRole('link', { name: tab, exact: true }),
    ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart' })).toBeDisabled();

  // the domain wizard walks its four steps and can be cancelled without adding anything
  await page.goto(`/apps/${name}/networking`);
  await page.getByRole('button', { name: 'Add domain' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Domain', { exact: true })
    .fill('shop.example.com');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('create this record so')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Serve over HTTPS')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Points at')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('shop.example.com')).toHaveCount(0);

  // delete it from the list, with the name typed
  await page.goto('/apps');
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: /Delete app/ }).click();
  // the list's own dialog asks with a placeholder, the app page's (ConfirmDeleteDialog) with a label
  await page
    .getByPlaceholder(`Type ${name} to confirm`)
    .or(page.getByLabel(`Type ${name} to confirm`))
    .fill(name);
  await page.getByRole('button', { name: 'Delete app' }).click();
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
});
