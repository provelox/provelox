import AxeBuilder from '@axe-core/playwright';
import { createThrowawayApps, removeThrowawayApps } from './api';
import { expect, test, type Page } from './fixtures';

/**
 * Automated accessibility checks (axe) on the pages people use most, in light and dark. The test fails on anything
 * axe rates serious or critical (missing names, labels and roles, contrast below the WCAG AA ratio, broken landmarks,
 * focus traps). Minor and moderate findings are listed in the run's output but do not fail it. axe cannot judge
 * everything (reading order, meaningful alternative text), so this is a floor, not a certificate.
 */

const APP = 'e2e-a11y';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Findings that are understood and belong to a part of the console someone else is changing. Each is listed, not hidden:
 * the run still prints it, and anything else on the page still fails. Remove an entry when its cause is fixed.
 */
const KNOWN: { page: string; rule: string; why: string }[] = [
  {
    page: 'apps',
    rule: 'aria-prohibited-attr',
    why: 'the status dots and the "no default address" marker in the Apps list put aria-label on a <span> with no role (apps-browser / app-row)',
  },
  {
    page: 'apps',
    rule: 'target-size',
    why: 'the address links in the Apps list rows are 16px tall and close together (apps-browser)',
  },
];

async function scan(page: Page, label: string, settle = false) {
  // a dialog fades in; measuring mid-fade reads colours that are not the final ones
  if (settle) await page.waitForTimeout(700);
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const rows = results.violations.map((v) => ({
    impact: v.impact,
    rule: v.id,
    help: v.help,
    nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    count: v.nodes.length,
  }));
  const blocking = rows.filter(
    (r) =>
      (r.impact === 'serious' || r.impact === 'critical') &&
      !KNOWN.some((k) => k.page === label.split(' (')[0] && k.rule === r.rule),
  );
  const minor = rows.filter((r) => !blocking.includes(r));
  for (const b of blocking)
    console.log(
      `[axe] ${label}: ${b.impact} ${b.rule} x${b.count} :: ${b.nodes.join(' | ')}`,
    );
  if (minor.length)
    console.log(
      `[axe] ${label}: ${minor.length} minor/moderate`,
      JSON.stringify(minor.map((m) => `${m.rule} x${m.count}`)),
    );
  expect(
    blocking,
    `${label}: ${blocking.map((b) => `${b.rule} (${b.count}) ${b.nodes[0]}`).join('; ')}`,
  ).toEqual([]);
}

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('the sign-in page', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Password')).toBeVisible();
    await scan(page, 'login');
  });
});

test.describe('signed in', () => {
  test.beforeAll(() => createThrowawayApps(APP));
  test.afterAll(removeThrowawayApps);

  for (const scheme of ['light', 'dark'] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme });

      const PAGES: [string, string, RegExp | string][] = [
        ['apps', '/apps', 'Apps'],
        ['an app: overview', `/apps/${APP}`, APP],
        ['an app: deployments', `/apps/${APP}/deploy`, APP],
        ['an app: configuration', `/apps/${APP}/configuration`, APP],
        ['an app: networking', `/apps/${APP}/networking`, APP],
        ['an app: logs', `/apps/${APP}/logs`, APP],
        ['templates', '/templates', 'Templates'],
        ['settings overview', '/settings', 'Settings'],
        ['settings: domain', '/settings/domain', 'Domain & HTTPS'],
        ['settings: access', '/settings/access', 'Password & tokens'],
      ];
      for (const [label, path, heading] of PAGES)
        test(`${label} (${scheme})`, async ({ page }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await page.addInitScript(
            (s) => localStorage.setItem('theme', s),
            scheme,
          );
          await page.goto(path);
          await expect(
            page.getByRole('heading', { name: heading }).first(),
          ).toBeVisible();
          await scan(page, `${label} (${scheme})`);
        });

      test(`the new-app dialog (${scheme})`, async ({ page }) => {
        await page.addInitScript(
          (s) => localStorage.setItem('theme', s),
          scheme,
        );
        await page.goto('/apps?new=1');
        await expect(
          page.getByRole('dialog', { name: 'Create an app' }),
        ).toBeVisible();
        await scan(page, `new-app dialog (${scheme})`, true);
      });
    });
  }

  test('the command palette and the shortcuts help', async ({ page }) => {
    await page.goto('/apps');
    await page.getByRole('button', { name: /^Search/ }).click();
    await expect(
      page.getByRole('dialog', { name: 'Command palette' }),
    ).toBeVisible();
    await scan(page, 'command palette', true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.keyboard.press('?');
    await expect(
      page.getByRole('dialog', { name: 'Keyboard shortcuts' }),
    ).toBeVisible();
    await scan(page, 'shortcuts help', true);
  });

  test('the delete confirmation', async ({ page }) => {
    await page.goto(`/apps/${APP}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /Delete app/ }).click();
    await expect(
      page.getByRole('alertdialog', { name: `Delete ${APP}?` }),
    ).toBeVisible();
    await scan(page, 'delete confirmation', true);
  });
});
