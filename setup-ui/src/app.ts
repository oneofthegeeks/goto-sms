// The goto-sms setup page. Plain DOM, no framework. Every URL is relative ('api/status'), so
// the page works under any mount path, including nested paths behind a proxy. Text that came
// from GoTo, texters or the server is always set with textContent, never as HTML.
//
// Two views: a five-step setup (one step open at a time, the first unfinished one unless the
// admin chose another with Change) and, once steps 1-4 are done, a calm manage view.

type Source = 'options' | 'env' | 'store' | 'unset';
type Field = 'clientId' | 'clientSecret' | 'accountKey' | 'fromNumber';
type Mode = 'webhook' | 'polling' | 'off';
type StepNo = 1 | 2 | 3 | 4 | 5;

/** The subset of the server's StatusPayload (contract/http.md) the page reads. */
interface Status {
  version: string;
  configured: boolean;
  connected: boolean;
  loginExpired: boolean;
  credentialsUnreadable: boolean;
  ready: boolean;
  clientId?: string;
  accountKey?: string;
  fromNumber?: string;
  invalidFromNumber?: true;
  sources: Record<Field, Source>;
  refreshSource?: 'login' | 'seeded-from-env';
  redirectUri: string;
  incoming: {
    mode: Mode;
    webhookUrl?: string;
    canWebhook: boolean;
    error?: { error: string; message: string; gotoStatus?: number };
  };
  requiredScopes: string[];
  back?: { url: string; label: string };
  startupError?: string;
}
interface Account {
  key: string;
  name: string;
}
interface NumberEntry {
  number: string;
  name: string;
  accountKey: string;
  smsEnabled?: boolean;
}
interface LogEntry {
  direction: string;
  from: string;
  to: string;
  status: string;
  reason?: string;
  at: string;
}
interface OptOut {
  number: string;
  at: string;
  source: string;
}
interface SendResult {
  status: string;
  reason?: string;
  messageId?: string;
  to?: string;
}

const STEPS: Record<StepNo, string> = {
  1: 'GoTo app credentials',
  2: 'Sign in to GoTo',
  3: 'Sending number',
  4: 'Test text',
  5: 'Incoming texts',
};
const MODE_LABEL: Record<Mode, string> = {
  off: 'Off',
  polling: 'Polling every 30 s',
  webhook: 'Webhook',
};
const CONFIG = "✓ set by your app's config";
const SECRET_SAVED = 'Saved. Leave blank to keep it.';

/** An API error carrying the contract's { error, message, gotoStatus?, gotoBody? }. */
class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly gotoStatus?: number,
    readonly gotoBody?: string,
  ) {
    super(message);
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    path,
    body === undefined
      ? { headers: { accept: 'application/json' } }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      typeof data.error === 'string' ? data.error : 'http_' + res.status,
      typeof data.message === 'string' ? data.message : 'Request failed (' + res.status + ')',
      typeof data.gotoStatus === 'number' ? data.gotoStatus : undefined,
      typeof data.gotoBody === 'string' ? data.gotoBody : undefined,
    );
  }
  return data as T;
}

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error('missing #' + id);
  return el as T;
}
const btn = (id: string) => $<HTMLButtonElement>(id);
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);

const live = $('live');
/** Announces a change to screen readers (the aria-live region). */
function announce(text: string): void {
  live.textContent = '';
  // A fresh text node after clearing, so a repeated message is announced again.
  setTimeout(() => (live.textContent = text), 50);
}

/** Shows a result line; GoTo's error body is shown verbatim under it. */
function show(id: string, kind: 'ok' | 'bad', text: string, gotoBody?: string): void {
  const el = $(id);
  el.hidden = false;
  el.className = 'msg ' + kind;
  el.textContent = text;
  if (gotoBody) {
    const pre = document.createElement('pre');
    pre.textContent = gotoBody;
    el.append(pre);
  }
  announce(text);
}
function clear(id: string): void {
  $(id).hidden = true;
}
function showError(id: string, err: unknown): void {
  if (err instanceof ApiError) {
    const text = err.gotoStatus ? err.message + '. GoTo said:' : err.message;
    show(id, 'bad', text, err.gotoBody);
  } else {
    show(id, 'bad', "Couldn't reach the server. Check your connection and try again.");
  }
}

/** Runs an action with its button disabled, so double clicks don't send twice. */
async function busy(button: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
  button.disabled = true;
  try {
    await fn();
  } finally {
    button.disabled = false;
  }
}

/** Sets a button's role in its step: the one filled (primary) button, or a quiet one. */
function setPrimary(button: HTMLElement, primary: boolean): void {
  button.classList.toggle('primary', primary);
  button.classList.toggle('ghost', !primary);
}

const locked = (s: Status, f: Field): boolean =>
  s.sources[f] === 'options' || s.sources[f] === 'env';

/** '+13854400099' → '385-440-0099'; anything else unchanged. */
function phone(n: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(n);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : n;
}
const time = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

// --- Remembered "skip the test" (per mount, so two mounts on one origin don't collide) -------

const SKIP_KEY = 'goto-sms:test-skipped:' + location.pathname;
function skipped(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
}
function setSkipped(on: boolean): void {
  try {
    if (on) localStorage.setItem(SKIP_KEY, '1');
    else localStorage.removeItem(SKIP_KEY);
  } catch {
    // Storage blocked (private window): the skip lasts for this page only.
  }
}

// --- State ------------------------------------------------------------------------------------

let status: Status | undefined;
let view: 'loading' | 'setup' | 'manage' = 'loading';
let openStep: StepNo = 1;
/** The stepper was opened from the manage view with Change; finishing returns there. */
let fromManage = false;
/** Skip chosen this visit, when localStorage is unavailable. */
let skippedNow = false;
/** Incoming step finished this visit (Finish pressed). */
let incomingDone = false;
/** When the newest outbound text was sent (from the log or a test this visit). */
let lastSent: string | undefined;
let accounts: Account[] | undefined;
let numbers: NumberEntry[] = [];
/** Why the last GoTo sign-in failed (from the OAuth callback's ?error=). */
let loginError: string | undefined;

function done(s: Status, n: StepNo): boolean {
  switch (n) {
    case 1:
      return s.configured;
    case 2:
      return s.connected;
    case 3:
      return s.ready;
    case 4:
      return lastSent !== undefined || skippedNow || skipped();
    case 5:
      return incomingDone || s.incoming.mode !== 'off';
  }
}
const requiredDone = (s: Status): boolean => ([1, 2, 3, 4] as const).every((n) => done(s, n));
/** The first unfinished required step (1-4), if any. */
const firstUnfinished = (s: Status): StepNo | undefined =>
  ([1, 2, 3, 4] as const).find((n) => !done(s, n));
/** The earlier step this one is waiting for: 2 needs 1, 3 needs 2, 4 and 5 need 3. */
function waitingFor(s: Status, n: StepNo): StepNo | undefined {
  const needs = ([1, 2, 3] as const).filter((k) => k < n);
  return needs.find((k) => !done(s, k));
}

function stepSummary(s: Status, n: StepNo): string {
  switch (n) {
    case 1: {
      if (locked(s, 'clientId') && locked(s, 'clientSecret')) return "Set by your app's config";
      const id = s.clientId ?? '';
      return 'Client ID ' + (id.length > 8 ? id.slice(0, 8) + '…' : id) + ', secret saved';
    }
    case 2:
      return s.refreshSource === 'seeded-from-env'
        ? 'Connected (from your app config)'
        : 'Connected';
    case 3: {
      const name = accounts?.find((a) => a.key === s.accountKey)?.name;
      return phone(s.fromNumber ?? '') + (name ? ' (' + name + ')' : '');
    }
    case 4:
      return lastSent ? 'Test sent ' + time(lastSent) : 'Skipped';
    case 5:
      return MODE_LABEL[s.incoming.mode];
  }
}

// --- Rendering --------------------------------------------------------------------------------

function render(): void {
  const s = status;
  if (!s) return;
  $('version').textContent = s.version;
  const back = $<HTMLAnchorElement>('back');
  back.hidden = !s.back;
  if (s.back) {
    back.href = s.back.url;
    back.textContent = '← Back to ' + s.back.label;
  }
  $('startup-error').hidden = !s.startupError;
  $('startup-text').textContent = s.startupError ?? '';
  $('loading').hidden = view !== 'loading';
  $('setup').hidden = view !== 'setup';
  $('manage').hidden = view !== 'manage';
  if (view === 'setup') renderSetup(s);
  if (view === 'manage') renderManage(s);
}

function renderSetup(s: Status): void {
  $('progress-text').textContent = 'Step ' + openStep + ' of 5 · ' + STEPS[openStep];
  $('progress-fill').style.width = (openStep / 5) * 100 + '%';
  btn('to-summary').hidden = !fromManage;
  renderRail(s);
  for (const n of [1, 2, 3, 4, 5] as const) $('step-' + n).hidden = n !== openStep;
  renderStep1(s);
  renderStep2(s);
  renderStep3(s);
  renderStep4(s);
  renderStep5(s);
}

function renderRail(s: Status): void {
  const items = ([1, 2, 3, 4, 5] as const).map((n) => {
    const li = document.createElement('li');
    const current = n === openStep;
    const isDone = done(s, n) && !current;
    const wait = waitingFor(s, n);
    const state = current ? 'current' : isDone ? 'done' : wait ? 'blocked' : 'todo';
    li.className = 'rail-item ' + state;
    if (current) li.setAttribute('aria-current', 'step');

    const marker = document.createElement('span');
    marker.className = 'marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = isDone ? '✓' : String(n);

    const text = document.createElement('span');
    text.className = 'rail-text';
    const title = document.createElement('span');
    title.className = 'rail-name';
    title.textContent = STEPS[n];
    const sub = document.createElement('span');
    sub.className = 'rail-sub';
    sub.textContent = isDone
      ? stepSummary(s, n)
      : state === 'blocked'
        ? 'Needs step ' + String(wait)
        : n === 5 && !current
          ? 'Optional'
          : '';
    // The state in words, for screen readers (the marker is hidden).
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = current ? ' (current step)' : isDone ? ' (done)' : '';
    title.append(sr);
    text.append(title);
    if (sub.textContent) text.append(sub);
    li.append(marker, text);

    if (isDone) {
      const change = document.createElement('button');
      change.type = 'button';
      change.className = 'linkish change';
      change.textContent = 'Change';
      change.setAttribute('aria-label', 'Change ' + STEPS[n]);
      change.addEventListener('click', () => goTo(n, { focus: true }));
      li.append(change);
    }
    return li;
  });
  $('rail').replaceChildren(...items);
}

function renderStep1(s: Status): void {
  $('redirect-uri').textContent = s.redirectUri;
  $('redirect-uri').parentElement!.hidden = !s.redirectUri;
  $('no-redirect').hidden = Boolean(s.redirectUri);
  $('scopes').replaceChildren(
    ...s.requiredScopes.map((scope) => {
      const li = document.createElement('li');
      const code = document.createElement('code');
      // Line breaks allowed after each dot on narrow screens (<wbr> adds no characters).
      scope.split('.').forEach((part, i) => {
        if (i > 0) code.append('.', document.createElement('wbr'));
        code.append(part);
      });
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'ghost small';
      copy.textContent = 'Copy';
      copy.setAttribute('aria-label', 'Copy ' + scope);
      copy.addEventListener('click', () => copyText(scope, scope + ' copied', code));
      li.append(code, copy);
      return li;
    }),
  );

  const idLocked = locked(s, 'clientId');
  const secretLocked = locked(s, 'clientSecret');
  const id = input('client-id');
  const secret = input('client-secret');
  // Don't overwrite what the admin is typing; refill only from a fresh status.
  if (document.activeElement !== id) id.value = s.clientId ?? '';
  id.hidden = idLocked;
  $('client-id-locked').hidden = !idLocked;
  $('client-id-locked').textContent = CONFIG + (s.clientId ? ': ' + s.clientId : '');
  secret.hidden = secretLocked;
  $('client-secret-locked').hidden = !secretLocked;
  // The secret is write-only: never echoed back, only a hint that one is stored.
  secret.placeholder = s.sources.clientSecret === 'store' && s.configured ? SECRET_SAVED : '';
  // The client secret is stored but can't be decrypted: the key changed.
  const unreadable = s.credentialsUnreadable && !s.configured;
  $('cred-problem').hidden = !unreadable;
  $('cred-problem').textContent = unreadable
    ? "The saved client secret can't be read because the encryption key changed. Paste the secret again."
    : '';
  const bothLocked = idLocked && secretLocked;
  btn('save-cred').textContent = bothLocked ? 'Continue' : 'Save and continue';
  btn('save-cred').disabled = Boolean(s.startupError);
}

function renderStep2(s: Status): void {
  const loginUnreadable = s.credentialsUnreadable && s.configured;
  let problem = '';
  if (loginUnreadable) {
    problem =
      "The saved GoTo login can't be read because the encryption key changed. Sign in again to replace it.";
  } else if (s.loginExpired) {
    problem = 'GoTo refused the saved login, so texts can’t be sent. Sign in again to fix it.';
  }
  $('login-problem').hidden = !problem;
  $('login-problem').textContent = problem;
  $('goto-login-error').hidden = loginError !== 'goto_login' || s.connected;
  $('connected-note').hidden = !s.connected;
  const connect = btn('connect');
  const again = s.loginExpired || loginUnreadable;
  // Connected: Continue is the step's one primary action (Disconnect sits beside it).
  connect.dataset.action = s.connected ? 'continue' : 'connect';
  connect.textContent = s.connected ? 'Continue' : again ? 'Reconnect' : 'Connect to GoTo';
  btn('disconnect').hidden = !s.connected;
  $('connect-fine').hidden = s.connected;
  connect.disabled = !s.configured || Boolean(s.startupError);
}

function renderStep3(s: Status): void {
  const accountLocked = locked(s, 'accountKey');
  const numberLocked = locked(s, 'fromNumber');
  select('account').disabled = accountLocked;
  $('account-locked').hidden = !accountLocked;
  $('number-field').hidden = numberLocked || !$('typed-field').hidden;
  $('number-locked').hidden = !numberLocked;
  $('number-locked').textContent =
    CONFIG.replace('set', 'Number set') + (s.fromNumber ? ': ' + phone(s.fromNumber) : '');
  $('number-problem').hidden = !s.invalidFromNumber;
  if (numberLocked) $('typed-field').hidden = true;
  btn('save-number').disabled = !s.connected;
}

function renderStep4(s: Status): void {
  const sentNow = $('test-msg').classList.contains('ok') && !$('test-msg').hidden;
  // After a successful test, Continue is the one primary button.
  btn('test-continue').hidden = !sentNow;
  setPrimary(btn('send-test'), !sentNow);
  btn('test-skip').hidden = sentNow;
  btn('send-test').disabled = !s.ready;
}

function renderStep5(s: Status): void {
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="incoming"]');
  const anyChecked = Array.from(radios).some((r) => r.checked);
  for (const r of radios) {
    if (!anyChecked) r.checked = r.value === s.incoming.mode;
    if (r.value === 'webhook') r.disabled = !s.incoming.canWebhook;
  }
  $('webhook-reason').hidden = s.incoming.canWebhook;
  $('webhook-url').textContent = s.incoming.webhookUrl ?? '';
  $('webhook-url-row').hidden = !s.incoming.webhookUrl;
  // Moving the webhook to a newly picked account failed: texts to it aren't arriving.
  const err = s.incoming.error;
  $('incoming-error').hidden = !err;
  $('incoming-error').textContent = err
    ? 'Incoming texts for the selected account are not set up: ' +
      err.message +
      (err.gotoStatus ? ' (GoTo ' + String(err.gotoStatus) + ')' : '') +
      '. Choose Webhook and press ' +
      (fromManage ? 'Save' : 'Finish') +
      ' to try again.'
    : '';
  btn('finish').textContent = fromManage ? 'Save' : 'Finish';
}

function renderManage(s: Status): void {
  const account = accounts?.find((a) => a.key === s.accountKey)?.name ?? s.accountKey;
  $('ready-line').textContent =
    'Sending from ' +
    phone(s.fromNumber ?? '') +
    (account ? ' (' + account + ')' : '') +
    ' · Incoming: ' +
    MODE_LABEL[s.incoming.mode];
  const rows: Array<[StepNo, string]> = [
    [1, 'Credentials'],
    [2, 'GoTo login'],
    [3, 'Sending number'],
    [5, 'Incoming texts'],
  ];
  $('summary-rows').replaceChildren(
    ...rows.map(([n, label]) => {
      const row = document.createElement('div');
      row.className = 'row';
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = stepSummary(s, n);
      const change = document.createElement('button');
      change.type = 'button';
      change.className = 'linkish change';
      change.textContent = 'Change';
      change.setAttribute('aria-label', 'Change ' + label.toLowerCase());
      change.addEventListener('click', () => {
        fromManage = true;
        goTo(n, { focus: true });
      });
      row.append(dt, dd, change);
      return row;
    }),
  );
}

// --- Navigation -------------------------------------------------------------------------------

/** Opens step n in the stepper. Focus moves to its heading only on a transition. */
function goTo(n: StepNo, o: { focus?: boolean } = {}): void {
  view = 'setup';
  openStep = n;
  render();
  if (n === 3) void loadAccounts();
  if (o.focus) {
    $('h-' + n).focus();
    announce('Step ' + n + ' of 5: ' + STEPS[n]);
  }
}

function showManage(o: { focus?: boolean } = {}): void {
  view = 'manage';
  fromManage = false;
  render();
  void loadLog().catch(() => {});
  void loadOptOuts().catch(() => {});
  if (!accounts && status?.connected) void loadAccounts();
  if (o.focus) {
    $('ready-title').focus();
    announce('Setup complete. Ready to send texts.');
  }
}

/** After a step succeeded: the next unfinished step, step 5 if not yet chosen, or the manage view. */
function advance(from: StepNo): void {
  const s = status;
  if (!s) return;
  const next = firstUnfinished(s);
  if (next) goTo(next, { focus: true });
  // First run: the optional incoming step comes before the summary, unless already set up.
  else if (!fromManage && from < 5 && !done(s, 5)) goTo(5, { focus: true });
  else showManage({ focus: true });
}

// --- Data -------------------------------------------------------------------------------------

function apply(s: Status): void {
  status = s;
  render();
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function useTypedNumber(on: boolean): void {
  $('typed-field').hidden = !on;
  $('number-field').hidden = on;
  if (on && status?.fromNumber) input('typed-number').value = status.fromNumber;
}

function renderSmsHint(): void {
  const hint = $('sms-hint');
  const picked = numbers.find((n) => n.number === select('number').value);
  hint.hidden = !picked || !$('typed-field').hidden;
  if (!picked) return;
  hint.textContent =
    picked.smsEnabled === false
      ? 'GoTo says this number is not enabled for SMS. Turn on SMS for it in GoTo Admin first.'
      : picked.smsEnabled === true
        ? 'SMS is turned on for this number.'
        : "GoTo didn't say whether this number can text. The test in the next step will tell.";
}

let accountsLoading: Promise<void> | undefined;
/** Lists the accounts (once per visit), then the chosen account's numbers. */
function loadAccounts(): Promise<void> {
  const s = status;
  if (!s?.connected) return Promise.resolve();
  accountsLoading ??= (async () => {
    clear('number-msg');
    $('number-loading').hidden = false;
    try {
      accounts = (await api<{ accounts: Account[] }>('api/accounts')).accounts;
    } catch (err) {
      showError('number-msg', err);
      useTypedNumber(true);
      return;
    } finally {
      $('number-loading').hidden = true;
    }
    const accountSelect = select('account');
    accountSelect.replaceChildren(
      option('', 'Choose an account'),
      ...accounts.map((a) => option(a.key, a.name || a.key)),
    );
    if (s.accountKey) {
      // Keep a configured key selectable even if GoTo didn't list it.
      if (!accounts.some((a) => a.key === s.accountKey)) {
        accountSelect.append(option(s.accountKey, s.accountKey));
      }
      accountSelect.value = s.accountKey;
    } else if (accounts.length === 1 && accounts[0]) {
      accountSelect.value = accounts[0].key;
    }
    render();
    await loadNumbers(accountSelect.value);
  })().finally(() => {
    accountsLoading = undefined;
  });
  return accountsLoading;
}

/** Fills the number list for one account. */
async function loadNumbers(accountKey: string): Promise<void> {
  const numberSelect = select('number');
  numbers = [];
  if (!accountKey) {
    numberSelect.replaceChildren(option('', 'Choose an account first'));
    renderSmsHint();
    return;
  }
  numberSelect.replaceChildren(option('', 'Loading numbers…'));
  try {
    numbers = (
      await api<{ numbers: NumberEntry[] }>(
        'api/numbers?accountKey=' + encodeURIComponent(accountKey),
      )
    ).numbers;
  } catch (err) {
    showError('number-msg', err);
    useTypedNumber(true);
    return;
  }
  useTypedNumber(false);
  numberSelect.replaceChildren(
    option('', numbers.length ? 'Choose a number' : 'This account has no numbers'),
    ...numbers.map((n) =>
      option(
        n.number,
        phone(n.number) +
          (n.name ? ' (' + n.name + ')' : '') +
          (n.smsEnabled === false ? ', no SMS' : ''),
      ),
    ),
  );
  const current = status?.fromNumber;
  if (current && numbers.some((n) => n.number === current)) numberSelect.value = current;
  else if (numbers.length === 1 && numbers[0]) numberSelect.value = numbers[0].number;
  if (status) renderStep3(status);
  renderSmsHint();
}

/** The log table, and the newest successful send (step 4 counts it as a test). */
async function loadLog(): Promise<void> {
  const { entries } = await api<{ entries: LogEntry[] }>('api/log?limit=50');
  lastSent ??= entries.find((e) => e.direction === 'outbound' && e.status === 'sent')?.at;
  $('log-body').replaceChildren(
    ...entries.map((e) =>
      tableRow([
        ['Time', when(e.at)],
        ['Direction', e.direction],
        ['From', e.from],
        ['To', e.to],
        ['Status', e.status],
        ['Reason', e.reason ?? ''],
      ]),
    ),
  );
  $('log-empty').hidden = entries.length > 0;
  $('log-body').closest('table')!.hidden = entries.length === 0;
}

/** A table row whose cells carry data-label, for the stacked-card layout on phones. */
function tableRow(cells: Array<[string, string | Node]>): HTMLTableRowElement {
  const tr = document.createElement('tr');
  for (const [label, value] of cells) {
    const td = document.createElement('td');
    td.dataset.label = label;
    // Free text (GoTo's reasons) may break anywhere; numbers and dates stay whole.
    if (label === 'Reason') td.className = 'reason';
    if (typeof value === 'string') td.textContent = value;
    else td.append(value);
    tr.append(td);
  }
  return tr;
}

function renderOptOuts(list: OptOut[]): void {
  $('optout-body').replaceChildren(
    ...list.map((o) => {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ghost small';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', 'Remove opt-out for ' + o.number);
      remove.addEventListener('click', () => void changeOptOut(remove, o.number, 'remove'));
      return tableRow([
        ['Number', o.number],
        ['Since', when(o.at)],
        ['Source', o.source],
        ['', remove],
      ]);
    }),
  );
  $('optout-empty').hidden = list.length > 0;
  $('optout-body').closest('table')!.hidden = list.length === 0;
}

async function loadOptOuts(): Promise<void> {
  renderOptOuts((await api<{ optOuts: OptOut[] }>('api/opt-outs')).optOuts);
}

async function changeOptOut(
  button: HTMLButtonElement,
  number: string,
  action: 'add' | 'remove',
): Promise<void> {
  await busy(button, async () => {
    try {
      const { optOuts } = await api<{ optOuts: OptOut[] }>('api/opt-outs', { number, action });
      renderOptOuts(optOuts);
      show(
        'optout-msg',
        'ok',
        action === 'add' ? number + ' will not be texted.' : number + ' can be texted again.',
      );
      if (action === 'add') input('optout-number').value = '';
    } catch (err) {
      showError('optout-msg', err);
    }
  });
}

// --- Actions ----------------------------------------------------------------------------------

/** Copies text; without a clipboard (plain http) selects `fallback` for a manual copy. */
function copyText(text: string, done: string, fallback: HTMLElement): void {
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(fallback);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    announce("Couldn't copy automatically; the text is selected, copy it by hand");
  };
  if (!navigator.clipboard) return select();
  navigator.clipboard.writeText(text).then(() => announce(done), select);
}

async function saveCredentials(): Promise<void> {
  const s = status;
  if (!s) return;
  const idLocked = locked(s, 'clientId');
  const secretLocked = locked(s, 'clientSecret');
  if (idLocked && secretLocked) return advance(1);
  // Only fields the admin can edit: a locked (options/env) field is never posted.
  const body: Record<string, string> = {};
  const id = input('client-id').value.trim();
  const secret = input('client-secret').value.trim();
  if (!idLocked) {
    if (!id) return show('cred-msg', 'bad', 'Paste the client ID from GoTo.');
    body.clientId = id;
  }
  if (!secretLocked) {
    const stored = s.sources.clientSecret === 'store' && s.configured;
    if (!secret && !stored) return show('cred-msg', 'bad', 'Paste the client secret from GoTo.');
    if (secret) body.clientSecret = secret;
  }
  try {
    apply(await api<Status>('api/credentials', body));
    input('client-secret').value = '';
    clear('cred-msg');
    if (status?.configured) advance(1);
  } catch (err) {
    showError('cred-msg', err);
  }
}

async function connect(): Promise<void> {
  try {
    const { url } = await api<{ url: string }>('api/connect', {});
    location.href = url;
  } catch (err) {
    showError('connect-msg', err);
  }
}

async function saveNumber(): Promise<void> {
  const s = status;
  if (!s) return;
  const body: Record<string, string> = {};
  if (!locked(s, 'accountKey')) {
    const key = select('account').value;
    if (key) body.accountKey = key;
  }
  if (!locked(s, 'fromNumber')) {
    const typed = !$('typed-field').hidden;
    const n = typed ? input('typed-number').value.trim() : select('number').value;
    if (!n) return show('number-msg', 'bad', 'Choose the number to send from.');
    body.fromNumber = n;
  }
  try {
    apply(await api<Status>('api/selection', body));
    clear('number-msg');
    if (status?.ready) advance(3);
  } catch (err) {
    showError('number-msg', err);
  }
}

const RESULT_TEXT: Record<string, string> = {
  sent: 'Sent',
  opted_out: 'Not sent: that number opted out',
  invalid_number: 'Not sent: that isn’t a valid phone number',
  uncertain: 'Unclear whether it was sent',
  not_connected: 'Not sent: not connected to GoTo',
  rejected: 'GoTo refused the text',
};

/** Sends the fixed test text; the reason is shown verbatim (GoTo's or the package's words). */
async function sendTest(toId: string, msgId: string): Promise<boolean> {
  const to = input(toId).value.trim();
  if (!to) {
    show(msgId, 'bad', 'Enter the mobile number to text.');
    return false;
  }
  try {
    const r = await api<SendResult>('api/test', { to });
    const head = (RESULT_TEXT[r.status] ?? r.status) + (r.to ? ' to ' + phone(r.to) : '');
    show(msgId, r.status === 'sent' ? 'ok' : 'bad', r.reason ? head + ': ' + r.reason : head + '.');
    if (r.status === 'sent') lastSent = new Date().toISOString();
    void loadLog().catch(() => {});
    return r.status === 'sent';
  } catch (err) {
    showError(msgId, err);
    return false;
  }
}

async function finishIncoming(): Promise<void> {
  const s = status;
  if (!s) return;
  const picked = document.querySelector<HTMLInputElement>('input[name="incoming"]:checked');
  const mode = (picked?.value ?? s.incoming.mode) as Mode;
  // Re-subscribing an unchanged webhook would call GoTo for nothing; a failed move retries.
  if (mode !== s.incoming.mode || s.incoming.error) {
    try {
      apply(await api<Status>('api/incoming', { mode }));
    } catch (err) {
      showError('incoming-msg', err);
      return;
    }
  }
  clear('incoming-msg');
  incomingDone = true;
  advance(5);
}

/** Explains ?connected=1 / ?error=… left by the OAuth callback, then tidies the URL. */
function readCallbackResult(): 'connected' | 'error' | undefined {
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  if (params.has('connected') || error) history.replaceState(null, '', location.pathname);
  if (params.get('connected') === '1') return 'connected';
  if (!error) return undefined;
  loginError = error;
  if (error === 'bad_state') {
    show('connect-msg', 'bad', 'That sign-in link expired or was already used. Connect again.');
  } else if (error !== 'goto_login') {
    show('connect-msg', 'bad', 'Signing in failed (' + error + '). Try again.');
  }
  return 'error';
}

function onSubmit(formId: string, fn: () => Promise<void>): void {
  $(formId).addEventListener('submit', (e) => {
    e.preventDefault();
    const b = (e.target as HTMLFormElement).querySelector<HTMLButtonElement>('button[type=submit]');
    if (b) void busy(b, fn);
  });
}

function wire(): void {
  onSubmit('cred-form', saveCredentials);
  btn('copy-redirect').addEventListener('click', () =>
    copyText(status?.redirectUri ?? '', 'Redirect URI copied', $('redirect-uri')),
  );
  btn('copy-scopes').addEventListener('click', () =>
    copyText((status?.requiredScopes ?? []).join(' '), 'All scopes copied', $('scopes')),
  );
  btn('connect').addEventListener('click', () => {
    const b = btn('connect');
    if (b.dataset.action === 'continue') advance(2);
    else void busy(b, connect);
  });
  btn('disconnect').addEventListener('click', () => {
    void busy(btn('disconnect'), async () => {
      try {
        apply(await api<Status>('api/disconnect', {}));
        show('connect-msg', 'ok', 'Disconnected from GoTo.');
      } catch (err) {
        showError('connect-msg', err);
      }
    });
  });
  btn('to-step-1').addEventListener('click', () => {
    goTo(1);
    $('redirect-item').scrollIntoView({ block: 'center' });
    btn('copy-redirect').focus();
  });
  btn('to-summary').addEventListener('click', () => showManage({ focus: true }));

  select('account').addEventListener('change', () => {
    clear('number-msg');
    void loadNumbers(select('account').value);
  });
  select('number').addEventListener('change', renderSmsHint);
  onSubmit('number-form', saveNumber);

  onSubmit('test-form', async () => {
    await sendTest('test-to', 'test-msg');
    if (status) render();
  });
  btn('test-continue').addEventListener('click', () => advance(4));
  btn('test-skip').addEventListener('click', () => {
    skippedNow = true;
    setSkipped(true);
    advance(4);
  });
  btn('finish').addEventListener('click', () => void busy(btn('finish'), finishIncoming));

  onSubmit('m-test-form', async () => {
    await sendTest('m-test-to', 'm-test-msg');
  });
  btn('refresh-log').addEventListener('click', () => {
    void busy(btn('refresh-log'), () => loadLog().catch(() => announce('Could not load messages')));
  });
  $('optout-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const number = input('optout-number').value.trim();
    const b = (e.target as HTMLFormElement).querySelector('button')!;
    if (number) void changeOptOut(b, number, 'add');
  });
}

async function main(): Promise<void> {
  wire();
  const callback = readCallbackResult();
  let s: Status;
  try {
    s = await api<Status>('api/status');
  } catch (err) {
    $('loading').textContent =
      "Couldn't load the setup status: " +
      (err instanceof ApiError ? err.message : 'the server did not answer.');
    $('loading').className = 'alert bad';
    announce('Could not load status');
    return;
  }
  status = s;
  // The log decides whether the test step is already done, so read it before choosing a step.
  if (!s.startupError && s.connected) await loadLog().catch(() => {});

  if (callback === 'connected' && s.connected) {
    announce('Connected to GoTo');
    goTo(firstUnfinished(s) === 1 ? 1 : 3, { focus: true });
  } else if (callback === 'error') {
    goTo(s.configured ? 2 : 1, { focus: true });
  } else if (!s.startupError && requiredDone(s)) {
    showManage();
  } else {
    goTo(firstUnfinished(s) ?? 1);
  }
}

void main();
