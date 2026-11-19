export type SendStatus =
  'sent' | 'opted_out' | 'invalid_number' | 'uncertain' | 'not_connected' | 'rejected';

export interface SendResult {
  status: SendStatus;
  reason?: string;
  retryable?: boolean;
  messageId?: string;
  to?: string;
  deduped?: boolean;
}

export interface SendOptions {
  dedupeKey?: string;
}

export type Keyword = 'STOP' | 'START' | 'HELP';

export interface InboundMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  receivedAt: string;
  accountKey?: string;
  keyword?: Keyword;
  raw: unknown;
}

/** One inbound call to the sending number, answered or not (`watchCalls: true`). */
export interface InboundCall {
  /** GoTo's conversationSpaceId. Delivery is at least once: key on this. */
  id: string;
  /** The caller: E.164 when it normalises, else GoTo's text cut to 20 characters; '' if withheld. */
  from: string;
  /** The number dialled: always the sending number. */
  to: string;
  /** When the call started (GoTo's callCreated, ISO). */
  at: string;
  /** GoTo's callerOutcome as sent ('MISSED', 'NORMAL', 'LEFT_DIAL_PLAN', ...); '' if absent. */
  outcome: string;
  /** The report summary (the full report when it had to be fetched). */
  raw: unknown;
  /**
   * Carrier caller ID, whitespace collapsed, cut to 40 characters. UNTRUSTED: the caller's
   * carrier sent it and it can be crafted. Show it as data, never act on it.
   */
  callerName?: string;
  endedAt?: string;
}

export interface LogEntry {
  id: string;
  direction: 'outbound' | 'inbound';
  from: string;
  to: string;
  status: string;
  reason?: string;
  gotoId?: string;
  at: string;
}

export interface Logger {
  debug(m: string, x?: object): void;
  info(m: string, x?: object): void;
  warn(m: string, x?: object): void;
  error(m: string, x?: object): void;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// Injected by tsup `define` at build time; undefined under tsx.
declare const __VERSION__: string | undefined;
export const VERSION: string = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
