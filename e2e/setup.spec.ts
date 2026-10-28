import { expect, test, type Page } from '@playwright/test';

const FAKE_SENT = 'http://127.0.0.1:4010/__sent';
const APP = 'http://localhost:4011';
const AUTH = { username: 'admin', password: 'e2e-pass', origin: APP, send: 'always' as const };
// Set SHOTS_DIR to also save screenshots of each view at phone, tablet and desktop widths.
const SHOTS_DIR = process.env.SHOTS_DIR;

async function sentCount(): Promise<number> {
  const res = await fetch(FAKE_SENT);
  return ((await res.json()) as unknown[]).length;
}

/** No sideways scrolling at this width. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
}

/** Screenshots of the current view at 320, 768 and 1440 px, light and dark (SHOTS_DIR only). */
async function shots(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  const size = page.viewportSize();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: `${SHOTS_DIR}/${name}-${width}-${colorScheme}.png`,
        fullPage: true,
      });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (size) await page.setViewportSize(size);
}

test.use({ httpCredentials: AUTH });

// The tests share one example app and data dir, so they run in order on accumulated state.
test('setup: the steps advance from credentials to a sent test, then Finish shows Ready', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.setViewportSize({ width: 360, height: 800 });

  await page.goto('/goto-sms/');
  const step1 = page.locator('#step-1');
  await expect(step1).toBeVisible();
  await expect(page.locator('.progress')).toContainText('Step 1 of 5');
  await expect(page.locator('#step-2')).toBeHidden();
  await expect(page.locator('.rail-item').nth(1)).toContainText('Needs step 1');
  // The back link from the example's backUrl.
  await expect(page.locator('#back')).toHaveText('← Back to the app');
  await expect(page.locator('#back')).toHaveAttribute('href', '/');
  await expectNoHorizontalScroll(page);
  await shots(page, 'setup-step1');

  await page.fill('#client-id', 'cid');
  await page.fill('#client-secret', 'csecret');
  await page.click('#save-cred');

  // Step 2 opens by itself, with focus on its heading.
  await expect(page.locator('#step-2')).toBeVisible();
  await expect(page.locator('#h-2')).toBeFocused();
  await expect(page.locator('.rail-item').first()).toContainText('Client ID cid, secret saved');
  await shots(page, 'setup-step2');

  // The fake GoTo approves at once and redirects back with ?connected=1: step 3, accounts loaded.
  await page.click('#connect');
  await expect(page.locator('#step-3')).toBeVisible();
  await expect(page).toHaveURL(/\/goto-sms\/$/);
  await expect(page.locator('#account')).toHaveValue('acct-1');
  await expect(page.locator('#number')).toHaveValue('+18015550100');
  await expect(page.locator('#sms-hint')).toContainText('SMS is turned on');
  await shots(page, 'setup-step3');
  await page.click('#save-number');

  await expect(page.locator('#step-4')).toBeVisible();
  await expect(page.locator('#h-4')).toBeFocused();
  await shots(page, 'setup-step4');
  await page.fill('#test-to', '+18015550199');
  await page.click('#send-test');
  await expect(page.locator('#test-msg')).toContainText('Sent');
  expect(await sentCount()).toBe(1);
  await page.click('#test-continue');

  await expect(page.locator('#step-5')).toBeVisible();
  await shots(page, 'setup-step5');
  await page.check('input[name="incoming"][value="polling"]');
  await page.click('#finish');

  await expect(page.locator('#manage')).toBeVisible();
  await expect(page.locator('#ready-title')).toContainText('Ready');
  await expect(page.locator('#ready-line')).toContainText('801-555-0100 (Test Account)');
  await expect(page.locator('#ready-line')).toContainText('Incoming: Polling');
  await expect(page.locator('#log-body tr')).toHaveCount(1);
  await expectNoHorizontalScroll(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoHorizontalScroll(page);
  expect(consoleErrors).toEqual([]);
});

test('manage: a reload lands on Ready; Change on the number reopens step 3', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/goto-sms/');
  await expect(page.locator('#manage')).toBeVisible();
  await expect(page.locator('#setup')).toBeHidden();
  await expectNoHorizontalScroll(page);
  await shots(page, 'manage');

  await page.getByRole('button', { name: 'Change sending number' }).click();
  await expect(page.locator('#step-3')).toBeVisible();
  await expect(page.locator('#h-3')).toBeFocused();
  await expect(page.locator('#number')).toHaveValue('+18015550100');
  await expect(page.locator('#to-summary')).toBeVisible();
  // Saving a change goes back to the summary.
  await page.click('#save-number');
  await expect(page.locator('#manage')).toBeVisible();

  // The always-available test send.
  await page.fill('#m-test-to', '(801) 555-0198');
  await page.click('#m-send-test');
  await expect(page.locator('#m-test-msg')).toContainText('Sent');
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expectNoHorizontalScroll(page);
});

test('dark color scheme renders with a dark background', async ({ browser }) => {
  const background = async (colorScheme: 'light' | 'dark') => {
    const context = await browser.newContext({ colorScheme, httpCredentials: AUTH });
    const page = await context.newPage();
    await page.goto(`${APP}/goto-sms/`);
    await expect(page.locator('#loading')).toBeHidden();
    const color = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await context.close();
    return color;
  };
  const dark = await background('dark');
  expect(dark).not.toBe(await background('light'));
  // A dark background: every channel low.
  const channels = (dark.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  expect(Math.max(...channels)).toBeLessThan(60);
});
