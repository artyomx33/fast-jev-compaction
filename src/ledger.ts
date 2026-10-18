// Node-side ledger writer for `compactMessages`. The Claude Code hook writes
// the same file through the engine's `$.fs` instead (hooks/fast-jev.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ledgerKeys, newLedgerLines } from './digest.js';
import type { LedgerEntry } from './types.js';

/** Where the per-session ledgers live unless `ledgerDir` says otherwise. */
export function defaultLedgerDir(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'state', 'compaction-ledger');
}

export function ledgerPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.jsonl`);
}

/**
 * Appends the entries not yet in `<dir>/<sessionId>.jsonl`; never truncates
 * or deletes. Returns the file path and how many lines were added.
 */
export function appendLedger(
  dir: string,
  sessionId: string,
  entries: readonly LedgerEntry[],
): { path: string; added: number } {
  const file = ledgerPath(dir, sessionId);
  if (entries.length === 0) return { path: file, added: 0 };
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(file) ? ledgerKeys(fs.readFileSync(file, 'utf8')) : new Set<string>();
  const lines = newLedgerLines(entries, existing);
  if (lines) fs.appendFileSync(file, lines);
  return { path: file, added: lines.split('\n').length - 1 };
}
