// Builds a connected createGoToSms instance on the fake GoTo for poller/facade tests.
import { createGoToSms, type GoToSms, type GoToSmsOptions } from '../../src/client.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { Logger } from '../../src/types.js';
import type { FakeGoTo } from './fake-goto.js';

export const FROM = '+18015550100'; // our sending number
export const PEER = '+18015550123'; // the person texting in
export const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A logger that records every line, for asserting warnings and what never gets logged. */
export function recorder() {
  const lines: Array<{ level: string; m: string; x?: object }> = [];
  const at =
    (level: string) =>
    (m: string, x?: object): void => {
      lines.push({ level, m, ...(x ? { x } : {}) });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
  return { logger, lines };
}

/**
 * createGoToSms on the fake with a MemoryStore, configured (client id/secret, from number)
 * and connected through ConfigResolver.save + GoToAuth.finishConnect.
 */
export async function connectedSms(
  fake: FakeGoTo,
  o: Partial<GoToSmsOptions> & { connect?: boolean } = {},
): Promise<GoToSms> {
  const { connect = true, ...rest } = o;
  const sms = createGoToSms({
    store: new MemoryStore(rest.now),
    encryptionKey: 'test-key',
    publicUrl: 'https://app.example',
    env: {},
    logger: silent,
    authBaseUrl: fake.url,
    apiBaseUrl: fake.url,
    ...rest,
  });
  await sms.ready;
  if (connect) {
    await sms.core.config.save({ clientId: 'cid', clientSecret: 'csecret', fromNumber: FROM });
    const state = new URL(await sms.core.auth.startConnect()).searchParams.get('state')!;
    await sms.core.auth.finishConnect('code-ok', state);
  }
  return sms;
}
