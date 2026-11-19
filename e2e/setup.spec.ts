import { expect, test, type Page } from '@playwright/test';

const FAKE_SENT = 'http://127.0.0.1:4010/__sent';
const FAKE = 'http://127.0.0.1:4010';
const APP = 'http://localhost:4011';
// The same example app with WATCH_CALLS=1 (playwright.config.ts).
const CALLS_APP = 'http://localhost:4012';
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

/** Screenshots of the current view at 320, 768 and 1440 px, dark (default) and light (SHOTS_DIR only). */
async function shots(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  const size = page.viewportSize();
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: `${SHOTS_DIR}/${name}-${width}-${theme}.png`,
        fullPage: true,
      });
    }
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
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

test('calls: without watchCalls there is no Calls row and no call scope', async ({ page }) => {
  await page.goto('/goto-sms/');
  await expect(page.locator('#manage')).toBeVisible();
  await expect(page.locator('#summary-rows .row')).toHaveCount(4);
  await expect(page.locator('#calls-row')).toHaveCount(0);
  await expect(page.locator('#summary-rows')).not.toContainText('Calls');
  await page.getByRole('button', { name: 'Change credentials' }).click();
  await expect(page.locator('#scopes li')).toHaveCount(4);
  await expect(page.locator('#scopes')).not.toContainText('cr.v1.read');
  await expect(page.locator('#scopes')).not.toContainText('calls');
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
  // Valid description list: each row holds only dt and dd (Change lives in the dd).
  await expect(page.locator('#summary-rows > div > :not(dt, dd)')).toHaveCount(0);

  // An unsaved choice in step 5 is dropped: reopening shows the saved mode again.
  await page.getByRole('button', { name: 'Change incoming texts' }).click();
  await expect(page.locator('input[name="incoming"][value="polling"]')).toBeChecked();
  await page.check('input[name="incoming"][value="off"]');
  await page.click('#to-summary');
  await expect(page.locator('#manage')).toBeVisible();
  await page.getByRole('button', { name: 'Change incoming texts' }).click();
  await expect(page.locator('input[name="incoming"][value="polling"]')).toBeChecked();

  // Back to summary after a Disconnect goes to the unfinished step, not a stale Ready card.
  // (Runs last: it leaves the app disconnected.)
  await page.click('#to-summary');
  await page.getByRole('button', { name: 'Change goto login' }).click();
  await page.click('#disconnect');
  await expect(page.locator('#connect-msg')).toContainText('Disconnected');
  await page.click('#to-summary');
  await expect(page.locator('#step-2')).toBeVisible();
  await expect(page.locator('#manage')).toBeHidden();
});

test('theme: dark by default, the toggle switches to light and survives a reload', async ({
  browser,
}) => {
  // A light OS preference must not matter: dark is the default.
  const context = await browser.newContext({ colorScheme: 'light', httpCredentials: AUTH });
  const page = await context.newPage();
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`${APP}/goto-sms/`);
  await expect(page.locator('#loading')).toBeHidden();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background()).toBe('rgb(17, 19, 23)'); // --bg #111317
  const toDark = page.getByRole('button', { name: 'Switch to light mode' });
  await expect(toDark).toBeVisible();
  await expectNoHorizontalScroll(page);

  await toDark.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await background()).toBe('rgb(242, 245, 244)'); // --bg #f2f5f4
  await expect(page.getByRole('button', { name: 'Switch to dark mode' })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.reload();
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await background()).toBe('rgb(242, 245, 244)');

  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await context.close();
});

test('calls: the summary shows Watching, the scope fix when GoTo refuses, and Sign in again', async ({
  browser,
}) => {
  const context = await browser.newContext({
    httpCredentials: { ...AUTH, origin: CALLS_APP },
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  const row = page.locator('#calls-row');
  /** The page does not poll: reload until the watcher's next look shows. */
  const afterReload = async (check: () => Promise<void>): Promise<void> => {
    await expect(async () => {
      await page.reload();
      await check();
    }).toPass({ timeout: 15_000 });
  };
  /** Fits a 320 px phone in both themes, then back to dark at the old size. */
  const fitsAPhone = async (name: string): Promise<void> => {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 320, height: 700 });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await expectNoHorizontalScroll(page);
    }
    if (size) await page.setViewportSize(size);
    await shots(page, name);
  };

  try {
    await fetch(`${FAKE}/__calls/allow`, { method: 'POST' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${CALLS_APP}/goto-sms/`);
    // Configured and connected from env: only the test and incoming steps are left.
    await expect(page.locator('#step-4')).toBeVisible();
    await page.click('#test-skip');
    await expect(page.locator('#step-5')).toBeVisible();
    await page.click('#finish');
    await expect(page.locator('#manage')).toBeVisible();

    // Working: under the incoming texts row, with the sending number and a done mark.
    await afterReload(async () => {
      await expect(row).toContainText('Watching 801-555-0100', { timeout: 1000 });
    });
    await expect(page.locator('#summary-rows .row').last()).toHaveAttribute('id', 'calls-row');
    await expect(row.locator('dt')).toHaveText('Calls');
    await expect(row.locator('.row-done')).toHaveText('✓');
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(page.locator('#summary-rows > div > :not(dt, dd)')).toHaveCount(0);
    await fitsAPhone('manage-calls-watching');

    // GoTo refuses the call reports: the exact fix, and a quiet button to sign in again.
    await fetch(`${FAKE}/__calls/refuse`, { method: 'POST' });
    await afterReload(async () => {
      await expect(row).toContainText(
        'GoTo refused the call reports. Enable the scope cr.v1.read on the OAuth client, then reconnect.',
        { timeout: 1000 },
      );
    });
    await expect(row).not.toContainText('Watching');
    await expect(row.locator('.row-done')).toHaveCount(0);
    const again = row.getByRole('button', { name: 'Sign in again' });
    await expect(again).toBeVisible();
    await expect(again).not.toHaveClass(/primary/);
    // Texting is not interrupted: the summary is still Ready.
    await expect(page.locator('#ready-title')).toContainText('Ready');
    await fitsAPhone('manage-calls-refused');

    // Step 1 lists the extra scope, with a note saying what it is for.
    await page.getByRole('button', { name: 'Change credentials' }).click();
    const scope = page.locator('#scopes li').filter({ hasText: 'cr.v1.read' });
    await expect(page.locator('#scopes li')).toHaveCount(5);
    await expect(scope).toContainText('for calls');
    await fitsAPhone('setup-step1-calls-scope');
    await page.click('#to-summary');
    await expect(page.locator('#manage')).toBeVisible();

    // The admin enables the scope in GoTo, then signs in again from the row: the same sign-in
    // as step 2, over the live login, and straight back to the summary.
    await fetch(`${FAKE}/__calls/allow`, { method: 'POST' });
    // (Wait for the round trip through GoTo: a reload before it would cancel the sign-in.)
    const callback = page.waitForResponse((r) => r.url().includes('/goto-sms/callback'));
    await again.click();
    expect((await callback).status()).toBe(302);
    await expect(page).toHaveURL(`${CALLS_APP}/goto-sms/`);
    await expect(page.locator('#manage')).toBeVisible();
    await expect(page.locator('#setup')).toBeHidden();
    await expect(page.locator('#ready-title')).toBeFocused();
    // The new login ends the hourly back-off at the next look.
    await afterReload(async () => {
      await expect(row).toContainText('Watching 801-555-0100', { timeout: 1000 });
    });

    // The two states that depend on timing, with the status answer's `calls` replaced.
    let calls: unknown = { watching: false };
    await page.route('**/goto-sms/api/status', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, calls } });
    });
    // No look has run yet.
    await page.reload();
    await expect(row.locator('dd')).toHaveText('Starting…');
    // Back from Sign in again, before the next look: the refusal still shows, with a note.
    calls = {
      watching: false,
      error: { error: 'calls_scope', message: 'GoTo refused the call reports.', gotoStatus: 403 },
    };
    await page.evaluate(() => sessionStorage.setItem('goto-sms:calls-signin:/goto-sms/', '1'));
    await page.goto(`${CALLS_APP}/goto-sms/?connected=1`);
    await expect(page.locator('#manage')).toBeVisible();
    await expect(row).toContainText('GoTo refused the call reports. Signed in.');
    await fitsAPhone('manage-calls-signed-in');
    await page.reload();
    await expect(row).toContainText('GoTo refused the call reports.');
    await expect(row).not.toContainText('Signed in.');
    // Another failure has no button: signing in again would not fix it.
    calls = {
      watching: false,
      error: { error: 'goto_unreachable', message: 'GoTo could not be reached' },
    };
    await page.reload();
    await expect(row).toContainText('GoTo could not be reached');
    await expect(row.getByRole('button')).toHaveCount(0);
    await page.unroute('**/goto-sms/api/status');
    expect(consoleErrors).toEqual([]);
  } finally {
    await fetch(`${FAKE}/__calls/allow`, { method: 'POST' });
    await context.close();
  }
});
