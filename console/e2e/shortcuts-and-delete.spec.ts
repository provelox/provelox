import { createThrowawayApps, removeThrowawayApps } from './api';
import { expect, test, throwawayName } from './fixtures';

test.afterEach(removeThrowawayApps);

test.describe('keyboard shortcuts', () => {
  test('g then a, t, s go to Apps, Templates and Settings', async ({
    page,
  }) => {
    await page.goto('/apps');
    await page.locator('body').click();
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expect(page).toHaveURL(/\/settings$/);
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await expect(page).toHaveURL(/\/templates$/);
    await page.keyboard.press('g');
    await page.keyboard.press('a');
    await expect(page).toHaveURL(/\/apps$/);
  });

  test('n opens the new-app dialog', async ({ page }) => {
    await page.goto('/apps');
    await page.locator('body').click();
    await page.keyboard.press('n');
    await expect(page).toHaveURL(/new=1/);
    await expect(
      page.getByRole('dialog', { name: 'Create an app' }),
    ).toBeVisible();
  });

  test('? lists the shortcuts, and Escape closes them', async ({ page }) => {
    await page.goto('/apps');
    await page.locator('body').click();
    await page.keyboard.press('?');
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(help).toBeVisible();
    for (const label of ['Apps', 'Templates', 'Settings', 'New app'])
      await expect(help.getByText(label, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
  });

  test('/ goes to the page search, and keys typed there are just text', async ({
    page,
  }) => {
    await createThrowawayApps(throwawayName());
    await page.goto('/apps');
    // the list streams in after the page: wait for its search box, or there is nothing to jump to yet
    const search = page.getByLabel('Filter apps');
    await expect(search).toBeVisible();
    // and for the page to finish hydrating, which replaces the box: focus given before that would be lost
    await page.waitForLoadState('networkidle');
    await page.locator('body').click();
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
    // inside a field the shortcuts do nothing: "n" is a letter, "g" then "s" does not leave the page
    await page.keyboard.type('ngs?');
    await expect(search).toHaveValue('ngs?');
    // (the list writes what is searched into the address, so the path is what stays)
    expect(new URL(page.url()).pathname).toBe('/apps');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('/ on a page with no search opens the command palette', async ({
    page,
  }) => {
    await page.goto('/settings');
    await page.locator('body').click();
    await page.keyboard.press('/');
    await expect(
      page.getByRole('dialog', { name: 'Command palette' }),
    ).toBeVisible();
  });

  test('the palette shows the keys next to what they do', async ({ page }) => {
    await page.goto('/apps');
    await page.locator('body').click();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await expect(
      palette.getByRole('option', { name: /Templates/ }).locator('kbd'),
    ).toHaveText('g t');
  });
});

test.describe('deleting asks for the name', () => {
  test('the button waits for the exact name, and the dialog says what goes and what stays', async ({
    page,
  }) => {
    const name = throwawayName();
    await createThrowawayApps(name);
    await page.goto(`/apps/${name}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /Delete app/ }).click();

    const dialog = page.getByRole('alertdialog', { name: `Delete ${name}?` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Deleted', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Kept', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/deploy keys/i)).toBeVisible();
    await expect(dialog.getByText(/no data volumes/i)).toBeVisible();

    const del = dialog.getByRole('button', { name: 'Delete app' });
    await expect(del).toBeDisabled();
    const box = dialog.getByLabel(`Type ${name} to confirm`);
    await box.fill(name.slice(0, -1));
    await expect(del).toBeDisabled();
    await box.fill(name.toUpperCase());
    await expect(del).toBeDisabled();
    await box.fill(name);
    await expect(del).toBeEnabled();

    // nothing typed for one deletion carries over to the next
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /Delete app/ }).click();
    await expect(
      page.getByRole('alertdialog').getByRole('button', { name: 'Delete app' }),
    ).toBeDisabled();
    await page.getByLabel(`Type ${name} to confirm`).fill(name);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/apps$/);
    await expect(page.getByText(`Deleted ${name}`)).toBeVisible();
  });
});
