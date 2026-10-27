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
  constructor(message = 'Temporary failure') {
    super(message, 'temporary');
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
