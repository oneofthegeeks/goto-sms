// Runs the fake GoTo standalone on a fixed port, for the Playwright e2e (`npm run e2e`).
// Besides the normal fake routes it serves GET /__sent so the browser test can assert what
// the example app sent through it, and POST /__calls/refuse and /__calls/allow so it can make
// GoTo refuse the call reports (a missing cr.v1.read scope) and stop again.
import { startFakeGoTo } from './fake-goto.js';

const fake = await startFakeGoTo({ port: Number(process.env.FAKE_GOTO_PORT ?? 4010) });
fake.numbersPages = [[{ number: '+18015550100', callerIdName: 'Main line', smsEnabled: true }]];
fake.route('GET', '/__sent', () => ({ status: 200, body: fake.sent }), { auth: false });
fake.route(
  'POST',
  '/__calls/refuse',
  () => {
    fake.callReportsRefuse = 403;
    return { status: 204 };
  },
  { auth: false },
);
fake.route(
  'POST',
  '/__calls/allow',
  () => {
    delete fake.callReportsRefuse;
    return { status: 204 };
  },
  { auth: false },
);

console.log(`fake GoTo on ${fake.url}`);
process.on('SIGTERM', () => void fake.close().then(() => process.exit(0)));
process.on('SIGINT', () => void fake.close().then(() => process.exit(0)));
