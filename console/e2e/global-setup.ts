import { chromium, type FullConfig } from '@playwright/test';

export const STORAGE_STATE = 'e2e/.auth.json';

/** Signs in once and keeps the session, so each test starts signed in. */
export default async function globalSetup(config: FullConfig) {
  const password = process.env.E2E_PASSWORD;
  if (!password)
    throw new Error(
      'Set E2E_PASSWORD to the Provelox admin password of the instance being tested.',
    );
  const { baseURL } = config.projects[0].use;
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL === 'bundled' ? undefined : 'chrome',
  });
  const page = await browser.newPage({ baseURL });
  await page.goto('/login');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/apps');
  await page.context().storageState({ path: STORAGE_STATE });
  await browser.close();
}
