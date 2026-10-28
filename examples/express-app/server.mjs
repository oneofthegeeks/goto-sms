// Example host app: mounts the goto-sms setup page behind HTTP Basic auth and sends texts.
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createGoToSms, VERSION } from '@oneofthegeeks/goto-sms';

const port = Number(process.env.PORT ?? 3000);
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  console.error('Set ADMIN_PASSWORD (the setup page password; any username works).');
  process.exit(1);
}

const sameString = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// HTTP Basic: any username, password must equal ADMIN_PASSWORD.
const isAdmin = (req) => {
  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  return sameString(decoded.slice(decoded.indexOf(':') + 1), adminPassword);
};

const sms = createGoToSms({
  authorize: isAdmin,
  publicUrl: process.env.GOTO_SMS_PUBLIC_URL,
  dataDir: process.env.GOTO_SMS_DATA_DIR ?? './data',
  // Overridden only by the e2e test, which points both at a fake GoTo.
  authBaseUrl: process.env.GOTO_SMS_AUTH_BASE_URL,
  apiBaseUrl: process.env.GOTO_SMS_API_BASE_URL,
});
sms.on('message', (m) => console.log('inbound text', m));

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, version: VERSION });
});

// The package answers an unauthorized request with 403, which makes a browser give up.
// Challenge first so it asks for the password. The OAuth callback and the GoTo webhook
// are exempt from authorize in the package, so they must be exempt here too.
app.use('/goto-sms', (req, res, next) => {
  const exempt = req.path === '/callback' || req.path.startsWith('/inbound/');
  if (exempt || isAdmin(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="goto-sms", charset="UTF-8"');
  res.status(401).end();
});
app.use('/goto-sms', sms.router());

app.post('/send', async (req, res) => {
  if (!isAdmin(req)) {
    res.set('WWW-Authenticate', 'Basic realm="goto-sms"');
    return res.status(401).end();
  }
  const { to, text } = req.body ?? {};
  res.json(await sms.send(String(to ?? ''), String(text ?? '')));
});

const server = app.listen(port, () => {
  console.log(`example listening on :${port}; setup page at /goto-sms/`);
});

const shutdown = async () => {
  server.close();
  await sms.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
