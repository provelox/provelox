import { removeThrowawayApps } from './api';
import { expect, test, throwawayName } from './fixtures';

test.afterEach(removeThrowawayApps);

test('a domain typed as the name gives the convention name and is attached', async ({
  page,
}) => {
  // api.e2e-<id>.com is product "e2e-<id>", role "api": the app is e2e-<id>-api, which the clean-up recognises
  const product = throwawayName();
  const host = `api.${product}.com`;
  const name = `${product}-api`;

  await page.goto('/apps?new=1');
  await page.getByLabel('App name').fill(host);
  await expect(page.getByText('looks like a domain')).toBeVisible();
  await page.getByRole('button', { name: `Use ${name}` }).click();
  await expect(page.getByLabel('App name')).toHaveValue(name);
  await expect(page.getByText(`Will also serve`)).toBeVisible();

  // the review lists the domain, then the app is created with it
  for (let i = 0; i < 3; i++)
    await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(host, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create app' }).click();
  await expect(
    page.getByRole('heading', { name: `${name} is created` }),
  ).toBeVisible();
  await expect(page.getByText('Attach the domain')).toBeVisible();

  // the app answers on the domain
  await page.goto(`/apps/${name}/networking`);
  await expect(page.getByText(host, { exact: true }).first()).toBeVisible();
});

test('a name that is not a domain is left to the usual checks', async ({
  page,
}) => {
  await page.goto('/apps?new=1');
  await page.getByLabel('App name').fill('Not A Name');
  await expect(page.getByText('looks like a domain')).toHaveCount(0);
  await expect(page.getByText(/spaces|lowercase/i).first()).toBeVisible();
});
