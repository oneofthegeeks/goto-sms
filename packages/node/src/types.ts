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
