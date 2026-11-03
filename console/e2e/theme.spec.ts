import { expect, test } from './fixtures';

test('the header switch flips light and dark in one click, and it is remembered', async ({
  page,
}) => {
  await page.goto('/apps');
  const html = page.locator('html');
  const toggle = page.getByRole('button', {
    name: /Switch to (light|dark) mode/,
  });

  const wasDark = await html.evaluate((el) => el.classList.contains('dark'));
  await toggle.click();
  if (wasDark) await expect(html).not.toHaveClass(/dark/);
  else await expect(html).toHaveClass(/dark/);

  // the choice survives a reload, applied before the page paints
  await page.reload();
  if (wasDark) await expect(html).not.toHaveClass(/dark/);
  else await expect(html).toHaveClass(/dark/);

  // and one click back
  await toggle.click();
  if (wasDark) await expect(html).toHaveClass(/dark/);
  else await expect(html).not.toHaveClass(/dark/);
});

test('Settings has System, Light and Dark', async ({ page }) => {
  await page.goto('/settings/appearance');
  const html = page.locator('html');
  await page.getByRole('radio', { name: /^Dark/ }).click();
  await expect(html).toHaveClass(/dark/);
  await page.getByRole('radio', { name: /^Light/ }).click();
  await expect(html).not.toHaveClass(/dark/);
  // leave it as it was found
  await page.getByRole('radio', { name: /^System/ }).click();
  await expect(page.getByRole('radio', { name: /^System/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
