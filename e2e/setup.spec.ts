import { expect, test, type Page } from '@playwright/test';

const FAKE_SENT = 'http://127.0.0.1:4010/__sent';
const APP = 'http://localhost:4011';

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

test.use({
  httpCredentials: { username: 'admin', password: 'e2e-pass', origin: APP, send: 'always' },
});

test('setup flow: credentials, connect, pick number, send a test', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.setViewportSize({ width: 360, height: 800 });

  await page.goto('/goto-sms/');
  await expect(page.locator('#banner-title')).toHaveText('Not configured');
  await expectNoHorizontalScroll(page);

  await page.fill('#client-id', 'cid');
  await page.fill('#client-secret', 'csecret');
  await page.click('#save-cred');
  await expect(page.locator('#cred-msg')).toBeVisible();

  await page.click('#connect');
  await expect(page.locator('#connect-msg')).toHaveText('Connected to GoTo.');
  await expect(page.locator('#banner-title')).toHaveText('Connected');

  await page.selectOption('#account', 'acct-1');
  await page.selectOption('#number', '+18015550100');
  await page.click('#save-number');
  await expect(page.locator('#number-msg')).toBeVisible();

  await page.fill('#test-to', '+18015550199');
  await page.click('#send-test');
  await expect(page.locator('#test-msg')).toContainText('Sent');
  expect(await sentCount()).toBe(1);

  await expectNoHorizontalScroll(page);

  // Desktop width: same page, still no sideways scroll.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoHorizontalScroll(page);
  expect(consoleErrors).toEqual([]);
});

test('dark color scheme renders with a dark background', async ({ browser }) => {
  const background = async (colorScheme: 'light' | 'dark') => {
    const context = await browser.newContext({
      colorScheme,
      httpCredentials: { username: 'admin', password: 'e2e-pass', origin: APP, send: 'always' },
    });
    const page = await context.newPage();
    await page.goto(`${APP}/goto-sms/`);
    await expect(page.locator('#banner-title')).not.toHaveText('Loading status…');
    if (colorScheme === 'dark') await page.screenshot({ path: 'test-results/setup-dark.png' });
    const color = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await context.close();
    return color;
  };
  expect(await background('dark')).not.toBe(await background('light'));
});
