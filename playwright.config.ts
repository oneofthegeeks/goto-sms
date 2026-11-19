import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// Fixed ports: the fake GoTo and the example app agree on them through env vars.
// Run `npm run build` first; the example consumes the built package.
const FAKE_PORT = 4010;
const APP_PORT = 4011;
// A second example app with call watching on (WATCH_CALLS=1), set up entirely from env.
const CALLS_APP_PORT = 4012;
const dataDir = mkdtempSync(join(tmpdir(), 'goto-sms-e2e-'));
const callsDataDir = mkdtempSync(join(tmpdir(), 'goto-sms-e2e-calls-'));

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${APP_PORT}` },
  webServer: [
    {
      command: 'npx tsx packages/node/test/helpers/fake-goto-cli.ts',
      url: `http://127.0.0.1:${FAKE_PORT}/__sent`,
      env: { FAKE_GOTO_PORT: String(FAKE_PORT) },
    },
    {
      command: 'node examples/express-app/server.mjs',
      url: `http://localhost:${APP_PORT}/healthz`,
      env: {
        PORT: String(APP_PORT),
        ADMIN_PASSWORD: 'e2e-pass',
        GOTO_SMS_PUBLIC_URL: `http://localhost:${APP_PORT}`,
        GOTO_SMS_DATA_DIR: dataDir,
        GOTO_SMS_AUTH_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
        GOTO_SMS_API_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
      },
    },
    {
      command: 'node examples/express-app/server.mjs',
      url: `http://localhost:${CALLS_APP_PORT}/healthz`,
      env: {
        PORT: String(CALLS_APP_PORT),
        ADMIN_PASSWORD: 'e2e-pass',
        WATCH_CALLS: '1',
        GOTO_SMS_CALL_POLL_MS: '300',
        GOTO_CLIENT_ID: 'cid',
        GOTO_CLIENT_SECRET: 'csecret',
        GOTO_ACCOUNT_KEY: 'acct-1',
        GOTO_FROM_NUMBER: '+18015550100',
        // The fake's refresh token: the app starts connected, with no sign-in in the browser.
        GOTO_REFRESH_TOKEN: 'refresh-1',
        GOTO_SMS_PUBLIC_URL: `http://localhost:${CALLS_APP_PORT}`,
        GOTO_SMS_DATA_DIR: callsDataDir,
        GOTO_SMS_AUTH_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
        GOTO_SMS_API_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
      },
    },
  ],
});
