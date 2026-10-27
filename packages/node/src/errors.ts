import type { SendResult } from './types.js';

export class GoToSmsError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class LoginExpiredError extends GoToSmsError {
  constructor(message = 'GoTo login expired; re-run setup') {
    super(message, 'login_expired');
  }
}

export class TemporaryError extends GoToSmsError {
  /**
   * True when the API request had already gone out (network error or timeout after
   * sending), so it may have taken effect. Absent when it never left (e.g. no token).
   */
  readonly requestSent?: boolean;
  constructor(message = 'Temporary failure', o: { requestSent?: boolean } = {}) {
    super(message, 'temporary');
    if (o.requestSent !== undefined) this.requestSent = o.requestSent;
  }
}

export class NotConfiguredError extends GoToSmsError {
  constructor(message = 'GoTo SMS is not configured') {
    super(message, 'not_configured');
  }
}

export class GoToApiError extends GoToSmsError {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`GoTo API error ${status}`, 'api');
    this.status = status;
    this.body = body.slice(0, 500);
  }
}

export class SendFailedError extends GoToSmsError {
  readonly result: SendResult;
  constructor(result: SendResult) {
    super(
      `Send failed: ${result.status}${result.reason ? ` (${result.reason})` : ''}`,
      'send_failed',
    );
    this.result = result;
  }
}

/** A sealed secret could not be opened: wrong key, tampering, or a malformed string. */
export class DecryptError extends GoToSmsError {
  constructor(message = 'Could not decrypt stored secret (wrong key or corrupted data)') {
    super(message, 'decrypt_failed');
  }
}
