import { JevClient, type JevClientOptions } from './client.js';
import { compact } from './compact.js';
import { appendLedger, defaultLedgerDir } from './ledger.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions &
  JevClientOptions & {
    /** Ledger directory; default `~/.claude/state/compaction-ledger`. Written only with a `sessionId`. */
    ledgerDir?: string;
  };

export type CompactMessagesResult = CompactResult & {
  /** The ledger file written, when a `sessionId` was given and something was dropped. */
  ledgerPath?: string;
};

/**
 * `compact` with a `JevClient` built from the options (key from
 * `TYPESAFE_API_KEY` by default). With a `sessionId`, the full outputs of
 * stubbed and digested calls are appended to `<ledgerDir>/<sessionId>.jsonl`.
 */
export async function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactMessagesResult> {
  const result = await compact(messages, new JevClient(options), options);
  if (!options.sessionId || result.ledger.length === 0) return result;
  const written = appendLedger(options.ledgerDir ?? defaultLedgerDir(), options.sessionId, result.ledger);
  return { ...result, ledgerPath: written.path };
}
