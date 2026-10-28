import type { Keyword } from '../types.js';

export interface KeywordReplies {
  stop: string;
  start: string;
  help: string;
}

export const DEFAULT_REPLIES: KeywordReplies = {
  stop: "You're unsubscribed and won't get more texts from this number. Reply START to resubscribe.",
  start: "You're resubscribed. Reply STOP to unsubscribe.",
  help: 'Reply STOP to unsubscribe. Msg & data rates may apply.',
};

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_WORDS = new Set(['START', 'UNSTOP']);
const HELP_WORDS = new Set(['HELP', 'INFO']);

/**
 * The keyword a text is, if any. Only a whole-message match counts ("Stop." and " stop "
 * do; "Unsubscribe please" doesn't), so ordinary messages that mention a word aren't
 * mistaken for an opt-out.
 */
export function detectKeyword(text: string, o: { yesIsOptIn: boolean }): Keyword | undefined {
  const word = text
    .trim()
    .toUpperCase()
    .replace(/[.!?,]+$/, '');
  if (STOP_WORDS.has(word)) return 'STOP';
  if (START_WORDS.has(word) || (o.yesIsOptIn && word === 'YES')) return 'START';
  if (HELP_WORDS.has(word)) return 'HELP';
  return undefined;
}
