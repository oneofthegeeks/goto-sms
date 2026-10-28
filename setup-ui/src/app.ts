// The goto-sms setup page. Plain DOM, no framework. Every URL is relative ('api/status'), so
// the page works under any mount path, including nested paths behind a proxy. Text that came
// from GoTo, texters or the server is always set with textContent, never as HTML.

type Source = 'options' | 'env' | 'store' | 'unset';
type Field = 'clientId' | 'clientSecret' | 'accountKey' | 'fromNumber';
type Mode = 'webhook' | 'polling' | 'off';

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
  redirectUri: string;
  incoming: { mode: Mode; webhookUrl?: string; canWebhook: boolean };
  requiredScopes: string[];
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

const UNREADABLE =
  "Saved GoTo credentials can't be decrypted — re-enter the client secret and reconnect";
const GOTO_LOGIN =
  'GoTo shows the same error for an unregistered redirect URI or a scope not enabled on the client — check both.';
const SECRET_SAVED = 'saved — leave blank to keep';

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

const live = $('live');
/** Announces a change to screen readers (the aria-live region). */
function announce(text: string): void {
  live.textContent = '';
  // A fresh text node after clearing, so a repeated message is announced again.
  setTimeout(() => (live.textContent = text), 50);
}

/** Shows a result line under a section; GoTo's error body is shown verbatim. */
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
    show(id, 'bad', 'Could not reach the server; check your connection and try again.');
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

const locked = (s: Status, f: Field): boolean =>
  s.sources[f] === 'options' || s.sources[f] === 'env';

let status: Status | undefined;
let numbers: NumberEntry[] = [];

function renderBanner(s: Status): void {
  const banner = $('status');
  const title = $('banner-title');
  const detail = $('banner-detail');
  const reconnect = $<HTMLButtonElement>('reconnect');
  reconnect.hidden = true;
  let kind: '' | 'ok' | 'warn' | 'bad' = '';
  let head: string;
  let text = '';
  if (s.startupError) {
    kind = 'bad';
    head = 'goto-sms could not start';
    text = s.startupError;
  } else if (s.credentialsUnreadable) {
    kind = 'bad';
    head = 'Credentials unreadable';
    text = UNREADABLE;
  } else if (s.loginExpired) {
    kind = 'bad';
    head = 'GoTo login expired';
    text = 'GoTo refused the saved login. Reconnect to keep sending.';
    reconnect.hidden = false;
  } else if (!s.configured) {
    kind = 'warn';
    head = 'Not configured';
    text = 'Enter your GoTo OAuth client ID and secret in step 1.';
  } else if (!s.connected) {
    kind = 'warn';
    head = 'Not connected';
    text = 'Connect to GoTo in step 2.';
  } else if (!s.ready) {
    kind = 'warn';
    head = 'Connected';
    text = 'Pick a sending number in step 3.';
  } else {
    kind = 'ok';
    head = 'Ready';
    text = 'Texts are sent from ' + (s.fromNumber ?? '') + '.';
  }
  if (s.invalidFromNumber) {
    text += ' The configured sending number is not a valid phone number.';
  }
  const previous = title.textContent;
  banner.className = 'card banner span' + (kind ? ' ' + kind : '');
  title.textContent = head;
  detail.textContent = text;
  if (previous !== head) announce(head + '. ' + text);
}

function renderClient(s: Status): void {
  $('redirect-uri').textContent = s.redirectUri;
  $('redirect-uri').hidden = !s.redirectUri;
  $('copy-redirect').hidden = !s.redirectUri;
  $('no-redirect').hidden = Boolean(s.redirectUri);

  const scopes = $('scopes');
  scopes.replaceChildren(
    ...s.requiredScopes.map((scope) => {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = scope;
      li.append(code);
      return li;
    }),
  );

  const id = $<HTMLInputElement>('client-id');
  const secret = $<HTMLInputElement>('client-secret');
  const idLocked = locked(s, 'clientId');
  const secretLocked = locked(s, 'clientSecret');
  // Don't overwrite what the admin is typing; refill only from a fresh status.
  if (document.activeElement !== id) id.value = s.clientId ?? '';
  id.disabled = idLocked;
  $('client-id-locked').hidden = !idLocked;
  secret.disabled = secretLocked;
  $('client-secret-locked').hidden = !secretLocked;
  // The secret is write-only: never echoed back, only a hint that one is stored.
  secret.placeholder = s.sources.clientSecret !== 'unset' ? SECRET_SAVED : '';
  $<HTMLButtonElement>('save-cred').disabled = idLocked && secretLocked;
}

function renderConnect(s: Status): void {
  $('connect').textContent = s.connected ? 'Reconnect to GoTo' : 'Connect to GoTo';
  $('disconnect').hidden = !s.connected;
}

function renderIncoming(s: Status): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="incoming"]')) {
    input.checked = input.value === s.incoming.mode;
    if (input.value === 'webhook') input.disabled = !s.incoming.canWebhook;
  }
  $('webhook-url').textContent = s.incoming.webhookUrl ?? '';
  $('webhook-url-row').hidden = !s.incoming.webhookUrl;
}

function renderNumberLocks(s: Status): void {
  const accountLocked = locked(s, 'accountKey');
  const numberLocked = locked(s, 'fromNumber');
  $<HTMLSelectElement>('account').disabled = accountLocked;
  $('account-locked').hidden = !accountLocked;
  $<HTMLSelectElement>('number').disabled = numberLocked;
  $<HTMLInputElement>('typed-number').disabled = numberLocked;
  $('number-locked').hidden = !numberLocked;
  $<HTMLButtonElement>('save-number').disabled = accountLocked && numberLocked;
}

function render(s: Status): void {
  status = s;
  $('version').textContent = s.version;
  renderBanner(s);
  renderClient(s);
  renderConnect(s);
  renderNumberLocks(s);
  renderIncoming(s);
}

async function refreshStatus(): Promise<Status> {
  const s = await api<Status>('api/status');
  render(s);
  return s;
}

// --- 3. Sending number ---------------------------------------------------------------------

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function useTypedNumber(on: boolean): void {
  $('typed-field').hidden = !on;
  $('number-field').hidden = on;
}

function renderSmsHint(): void {
  const hint = $('sms-hint');
  const picked = numbers.find((n) => n.number === $<HTMLSelectElement>('number').value);
  hint.hidden = !picked;
  if (!picked) return;
  hint.textContent =
    picked.smsEnabled === false
      ? 'GoTo says this number is not enabled for SMS. Enable SMS on it in GoTo Admin first.'
      : picked.smsEnabled === true
        ? 'SMS is enabled on this number.'
        : "GoTo didn't say whether this number can text; send a test to check.";
}

/** Lists the accounts and every account's numbers, grouped by account. */
async function loadNumbers(s: Status): Promise<void> {
  clear('number-msg');
  const accountSelect = $<HTMLSelectElement>('account');
  const numberSelect = $<HTMLSelectElement>('number');
  let accounts: Account[];
  try {
    accounts = (await api<{ accounts: Account[] }>('api/accounts')).accounts;
  } catch (err) {
    showError('number-msg', err);
    useTypedNumber(true);
    return;
  }
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

  try {
    const lists = await Promise.all(
      accounts.map((a) =>
        api<{ numbers: NumberEntry[] }>('api/numbers?accountKey=' + encodeURIComponent(a.key)),
      ),
    );
    numbers = lists.flatMap((l) => l.numbers);
  } catch (err) {
    showError('number-msg', err);
    useTypedNumber(true);
    $<HTMLInputElement>('typed-number').value = s.fromNumber ?? '';
    return;
  }
  useTypedNumber(false);
  numberSelect.replaceChildren(option('', 'Choose a number'));
  for (const a of accounts) {
    const group = document.createElement('optgroup');
    group.label = a.name || a.key;
    for (const n of numbers.filter((x) => x.accountKey === a.key)) {
      const label =
        n.number + (n.name ? ' — ' + n.name : '') + (n.smsEnabled === false ? ' (no SMS)' : '');
      group.append(option(n.number, label));
    }
    if (group.children.length) numberSelect.append(group);
  }
  if (s.fromNumber) {
    if (!numbers.some((n) => n.number === s.fromNumber)) {
      numberSelect.append(option(s.fromNumber, s.fromNumber));
    }
    numberSelect.value = s.fromNumber;
  }
  renderSmsHint();
}

// --- 6. Activity ---------------------------------------------------------------------------

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

/** A table row whose cells carry data-label, for the stacked-card layout on phones. */
function row(cells: Array<[string, string | Node]>): HTMLTableRowElement {
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

async function loadLog(): Promise<void> {
  const { entries } = await api<{ entries: LogEntry[] }>('api/log?limit=50');
  $('log-body').replaceChildren(
    ...entries.map((e) =>
      row([
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
}

function renderOptOuts(list: OptOut[]): void {
  $('optout-body').replaceChildren(
    ...list.map((o) => {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', 'Remove opt-out for ' + o.number);
      remove.addEventListener('click', () => void changeOptOut(remove, o.number, 'remove'));
      return row([
        ['Number', o.number],
        ['Since', when(o.at)],
        ['Source', o.source],
        ['', remove],
      ]);
    }),
  );
  $('optout-empty').hidden = list.length > 0;
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
      if (action === 'add') $<HTMLInputElement>('optout-number').value = '';
    } catch (err) {
      showError('optout-msg', err);
    }
  });
}

// --- Actions -------------------------------------------------------------------------------

async function saveCredentials(): Promise<void> {
  const s = status;
  if (!s) return;
  // Only fields the admin can edit: a locked (options/env) field is never posted.
  const body: Record<string, string> = {};
  if (!locked(s, 'clientId')) body.clientId = $<HTMLInputElement>('client-id').value.trim();
  const secret = $<HTMLInputElement>('client-secret');
  if (!locked(s, 'clientSecret') && secret.value) body.clientSecret = secret.value.trim();
  try {
    render(await api<Status>('api/credentials', body));
    secret.value = '';
    show('cred-msg', 'ok', 'Saved.');
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
    const key = $<HTMLSelectElement>('account').value;
    if (key) body.accountKey = key;
  }
  if (!locked(s, 'fromNumber')) {
    const typed = !$('typed-field').hidden;
    const n = typed
      ? $<HTMLInputElement>('typed-number').value.trim()
      : $<HTMLSelectElement>('number').value;
    if (n) body.fromNumber = n;
  }
  try {
    render(await api<Status>('api/selection', body));
    show('number-msg', 'ok', 'Saved.');
  } catch (err) {
    showError('number-msg', err);
  }
}

const RESULT_TEXT: Record<string, string> = {
  sent: 'Sent',
  opted_out: 'Not sent: that number opted out',
  invalid_number: 'Not sent: invalid number',
  uncertain: 'Unclear whether it was sent',
  not_connected: 'Not sent: not connected',
  rejected: 'Rejected by GoTo',
};

async function sendTest(): Promise<void> {
  const to = $<HTMLInputElement>('test-to').value;
  try {
    const r = await api<SendResult>('api/test', { to });
    // The reason is shown verbatim: it's GoTo's (or the package's) own explanation.
    const head = (RESULT_TEXT[r.status] ?? r.status) + (r.to ? ' (' + r.to + ')' : '');
    show('test-msg', r.status === 'sent' ? 'ok' : 'bad', r.reason ? head + ': ' + r.reason : head);
    void loadLog().catch(() => {});
  } catch (err) {
    showError('test-msg', err);
  }
}

async function setIncoming(mode: Mode): Promise<void> {
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="incoming"]');
  for (const r of radios) r.disabled = true;
  try {
    render(await api<Status>('api/incoming', { mode }));
    show('incoming-msg', 'ok', 'Incoming texts: ' + mode + '.');
  } catch (err) {
    showError('incoming-msg', err);
  } finally {
    for (const r of radios) r.disabled = false;
    // Re-applies canWebhook and snaps the radio back if the switch failed.
    if (status) renderIncoming(status);
  }
}

/** Explains ?connected=1 / ?error=… left by the OAuth callback, then tidies the URL. */
function handleCallbackResult(): void {
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  if (params.get('connected') === '1') show('connect-msg', 'ok', 'Connected to GoTo.');
  else if (error === 'goto_login')
    show('connect-msg', 'bad', 'GoTo refused the login. ' + GOTO_LOGIN);
  else if (error === 'bad_state') {
    show('connect-msg', 'bad', 'That login link expired or was already used. Click Connect again.');
  } else if (error) show('connect-msg', 'bad', 'Connecting failed (' + error + '). Try again.');
  if (params.has('connected') || error) history.replaceState(null, '', location.pathname);
}

function wire(): void {
  $('cred-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void busy($<HTMLButtonElement>('save-cred'), saveCredentials);
  });
  $('copy-redirect').addEventListener('click', () => {
    const uri = status?.redirectUri ?? '';
    navigator.clipboard.writeText(uri).then(
      () => announce('Redirect URI copied'),
      () => {
        // No clipboard (e.g. plain http): select it so the admin can copy by hand.
        const range = document.createRange();
        range.selectNodeContents($('redirect-uri'));
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        announce('Copy failed; the redirect URI is selected, copy it manually');
      },
    );
  });
  for (const id of ['connect', 'reconnect']) {
    const b = $<HTMLButtonElement>(id);
    b.addEventListener('click', () => void busy(b, connect));
  }
  $('disconnect').addEventListener('click', () => {
    const b = $<HTMLButtonElement>('disconnect');
    void busy(b, async () => {
      try {
        render(await api<Status>('api/disconnect', {}));
        show('connect-msg', 'ok', 'Disconnected from GoTo.');
      } catch (err) {
        showError('connect-msg', err);
      }
    });
  });
  $('account').addEventListener('change', () => clear('number-msg'));
  $('number').addEventListener('change', () => {
    // Picking a number picks its account too.
    const picked = numbers.find((n) => n.number === $<HTMLSelectElement>('number').value);
    const account = $<HTMLSelectElement>('account');
    if (picked && !account.disabled) account.value = picked.accountKey;
    renderSmsHint();
  });
  $('load-numbers').addEventListener('click', () => {
    const b = $<HTMLButtonElement>('load-numbers');
    if (status) void busy(b, () => loadNumbers(status!));
  });
  $('number-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void busy($<HTMLButtonElement>('save-number'), saveNumber);
  });
  $('test-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void busy($<HTMLButtonElement>('send-test'), sendTest);
  });
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="incoming"]')) {
    r.addEventListener('change', () => void setIncoming(r.value as Mode));
  }
  $('refresh-log').addEventListener('click', () => {
    const b = $<HTMLButtonElement>('refresh-log');
    void busy(b, () => loadLog().catch(() => announce('Could not load messages')));
  });
  $('optout-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const number = $<HTMLInputElement>('optout-number').value.trim();
    const b = (e.target as HTMLFormElement).querySelector('button')!;
    if (number) void changeOptOut(b, number, 'add');
  });
}

async function main(): Promise<void> {
  wire();
  handleCallbackResult();
  let s: Status;
  try {
    s = await refreshStatus();
  } catch (err) {
    $('banner-title').textContent = 'Could not load status';
    $('banner-detail').textContent =
      err instanceof ApiError ? err.message : 'The server did not answer.';
    $('status').className = 'card banner span bad';
    announce('Could not load status');
    return;
  }
  if (s.startupError) return;
  // Activity and numbers need a working instance; failures show inline, not as a crash.
  void loadLog().catch(() => {});
  void loadOptOuts().catch(() => {});
  if (s.connected) void loadNumbers(s);
}

void main();
