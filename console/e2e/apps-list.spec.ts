import { createThrowawayApps, removeThrowawayApps } from './api';
import { expect, test } from './fixtures';

// The list only has controls once there are apps, and a fresh platform has none: bring two of our own
test.beforeAll(() => createThrowawayApps('e2e-list-a', 'e2e-list-b'));
test.afterAll(removeThrowawayApps);

test.describe('apps list', () => {
  test('can be sorted, and the choice is remembered', async ({ page }) => {
    await page.goto('/apps');
    const sort = page.getByRole('combobox', { name: 'Sort' });
    await expect(sort).toContainText('Name');

    await sort.click();
    await page.getByRole('option', { name: /Status/ }).click();
    await expect(sort).toContainText('Status');

    // it survives a reload
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Sort' })).toContainText(
      'Status',
    );

    // leave it as it was found
    await page.getByRole('combobox', { name: 'Sort' }).click();
    await page.getByRole('option', { name: 'Name' }).click();
  });

  test('a project shows as one stack with Open project and Remove project', async ({
    page,
  }) => {
    await page.goto('/apps');
    const stacks = page.getByRole('button', { name: /^Actions for project / });
    test.skip(
      (await stacks.count()) === 0,
      'no project is installed on this instance',
    );
    await stacks.first().click();
    await expect(
      page.getByRole('menuitem', { name: 'Open project' }),
    ).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: /Remove project/ }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

test('a project page has its services, logs and compose file, and hides secrets until revealed', async ({
  page,
}) => {
  await page.goto('/projects');
  const first = page.getByRole('link', { name: /service/ }).first();
  test.skip(
    (await first.count()) === 0,
    'no project is installed on this instance',
  );
  await first.click();
  await expect(page.getByRole('link', { name: /^Services/ })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Logs', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Compose file' }),
  ).toBeVisible();

  // when the project is a template with a secret, it is hidden until Reveal
  const reveal = page.getByRole('button', { name: 'Reveal' });
  if (await reveal.count()) {
    await expect(page.getByText('••••••••').first()).toBeVisible();
    await reveal.click();
    await expect(page.getByRole('button', { name: 'Hide' })).toBeVisible();
    await page.getByRole('button', { name: 'Hide' }).click();
  }
});

test('several apps can be selected to act on together', async ({ page }) => {
  await page.goto('/apps');
  await expect(page.getByLabel(/^Select /).first()).toHaveCount(0);

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const boxes = page.getByRole('checkbox', { name: /^Select (?!every)/ });
  test.skip((await boxes.count()) < 2, 'needs at least two apps');
  await boxes.nth(0).click();
  await boxes.nth(1).click();

  // the bar says how many, and offers the actions (nothing is run here)
  const bar = page.getByRole('region', {
    name: 'Actions for the selected apps',
  });
  await expect(bar).toContainText('2 selected');
  for (const name of [/^Restart/, /^Stop/, /^Start/, /^Move to collection/])
    await expect(bar.getByRole('button', { name })).toBeVisible();

  await bar.getByRole('button', { name: 'Clear selection' }).click();
  await expect(bar).toHaveCount(0);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(
    page.getByRole('button', { name: 'Select', exact: true }),
  ).toBeVisible();
});
