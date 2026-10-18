import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { ledgerKeys, newLedgerLines } from '../src/digest.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  LedgerEntry,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  // The idle-compaction protection: Claude Code compacts an idle session
  // before its prompt cache expires, often right after the person's last
  // instructions; their recent turns stay verbatim.
  preserveRecentHumanTurns: 3,
  stubMode: 'digest' as const,
  onNothingToDrop: 'skip' as const,
};

/** Relative to the home directory, unless the `ledgerDir` option names one. */
export const LEDGER_SUBDIR = '.claude/state/compaction-ledger';

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
  /** Absolute ledger directory; unset, `$HOME/` + `LEDGER_SUBDIR`. */
  ledgerDir?: string;
  /**
   * When the recent-human-turn window leaves nothing (or too little) to drop:
   * 'skip' leaves the conversation as it is (`{ skip }`), 'native' hands it to
   * the built-in summary, as below `minReductionRatio` otherwise.
   */
  onNothingToDrop: 'skip' | 'native';
};

/** Jev normally answers a compaction batch in under 3 s; a stalled origin hangs for 18 s+. */
export const FAIL_FAST = { timeoutMs: 8_000, retries: 1 };

/** Resolves after `ms`: `$.clock.sleep` in the engine, a timer in tests. */
export type Sleep = (ms: number) => Promise<void>;

/**
 * Wraps a fetch so one Jev request cannot outlast `timeoutMs`: a timeout or a
 * 5xx is retried `retries` times, then the last failure is thrown and the hook
 * falls back to the built-in summary. The engine's `HttpInit` has no signal,
 * so an abandoned request is simply left to finish on its own.
 */
export function failFast(
  fetchFn: HookFetch,
  sleep: Sleep,
  options: { timeoutMs: number; retries: number } = FAIL_FAST,
): HookFetch {
  return async (url, init) => {
    let lastError = new Error('unreachable');
    for (let attempt = 0; attempt <= options.retries; attempt++) {
      const timeout = sleep(options.timeoutMs).then(() => {
        throw new Error(`Jev request timed out after ${options.timeoutMs} ms`);
      });
      try {
        const response = await Promise.race([fetchFn(url, init), timeout]);
        if (response.status < 500) return response;
        lastError = new Error(`Jev request failed (${response.status}): ${response.text.slice(0, 200)}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      timeout.catch(() => undefined);
    }
    throw new Error(`${lastError.message} (after ${options.retries + 1} attempts)`);
  };
}

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'maxDropRatio',
    'preserveRecentHumanTurns',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const stubMode = optionString(options, 'stubMode');
  const onNothingToDrop = optionString(options, 'onNothingToDrop');
  const config: HookConfig = {
    preserveRecentHumanTurns: HOOK_DEFAULTS.preserveRecentHumanTurns,
    ...numbers,
    stubMode:
      stubMode === 'none' || stubMode === 'line' || stubMode === 'digest'
        ? stubMode
        : HOOK_DEFAULTS.stubMode,
    onNothingToDrop: onNothingToDrop === 'native' ? 'native' : HOOK_DEFAULTS.onNothingToDrop,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  // Only set when configured, so an untouched config resolves to the upstream defaults.
  if (optionString(options, 'questionStyle') === 'evidence') config.questionStyle = 'evidence';
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  const ledgerDir = optionString(options, 'ledgerDir');
  if (ledgerDir) config.ledgerDir = ledgerDir;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
    stats.stubs + stats.digests > 0 ? `${stats.stubs + stats.digests} digested` : '',
    stats.humanTurnsPinned > 0 ? `${stats.humanTurnsPinned} human turns kept` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

/**
 * True when the recent-human-turn window is why the compaction cannot reach
 * `minReductionRatio`: no candidate is left, or the window pinned more than
 * `preserveRecentMessages` alone would and the reduction stays below it.
 */
export function nothingToDrop(result: CompactResult, config: HookConfig): boolean {
  const { stats } = result;
  if (stats.humanTurnsPinned === 0) return false;
  if (stats.calls - stats.pinned === 0) return true;
  const widened =
    stats.pinnedFromIndex < stats.messagesBefore - resolveOptions(config).preserveRecentMessages;
  return widened && reductionRatio(result) < config.minReductionRatio;
}

/** The one line a skipped compaction shows. */
export function skipNotice(ts: string, humanTurns: number): string {
  return `Compaction skipped by Jev at ${ts}: ${humanTurns} recent human turns pinned, nothing older to drop.`;
}

/** First words of the post-compaction notice; earlier notices are replaced, not stacked. */
export const NOTICE_PREFIX = '<system-reminder>Compacted by Jev at ';

/** The three-line notice the compacted history ends with. */
export function compactionNotice(args: {
  ts: string;
  results: number;
  humanTurns: number;
  ledgerPath: string;
}): string {
  return [
    `${NOTICE_PREFIX}${args.ts}: ${args.results} tool results → digests, ${args.humanTurns} recent human turns kept verbatim,`,
    `full results in ${args.ledgerPath}.`,
    'Nothing above is verified until read back this turn.</system-reminder>',
  ].join('\n');
}

/** The messages without earlier notices, ending with `notice` as a user message. */
export function withNotice(messages: readonly SessionMessage[], notice: string): SessionMessage[] {
  return [
    ...messages.filter(
      (message) =>
        !(
          message.role === 'user' &&
          message.text.startsWith(NOTICE_PREFIX) &&
          message.toolUses.length === 0 &&
          (message.toolResults ?? []).length === 0
        ),
    ),
    { role: 'user', text: notice, toolUses: [] },
  ];
}

/**
 * The ledger file's new text: `existing` with the lines of the entries whose
 * key it does not hold yet appended (`$.fs` has no append, so the file is read
 * and written whole). Existing lines are never changed or removed.
 */
export function appendedLedger(
  existing: string,
  entries: readonly LedgerEntry[],
): { text: string; added: number } {
  const lines = newLedgerLines(entries, ledgerKeys(existing));
  if (!lines) return { text: existing, added: 0 };
  const joint = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  return { text: `${existing}${joint}${lines}`, added: lines.split('\n').length - 1 };
}

/** Writes the ledger and returns the notice's ledger wording (the path, or why there is none). */
async function writeLedger(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    fs: {
      exists: (path: string) => Promise<boolean>;
      read: (path: string) => Promise<string>;
      write: (path: string, text: string) => Promise<void>;
    };
    ui: { log: (text: string) => void };
  },
  config: HookConfig,
  sessionId: string,
  entries: readonly LedgerEntry[],
): Promise<string> {
  const home = config.ledgerDir ? undefined : await $.env.get('HOME');
  const dir = config.ledgerDir ?? (home ? `${home.replace(/\/$/, '')}/${LEDGER_SUBDIR}` : undefined);
  if (!dir) {
    $.ui.log('ledger not written: no ledgerDir and no HOME');
    return '(no ledger: HOME unknown)';
  }
  const path = `${dir}/${sessionId}.jsonl`;
  try {
    const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
    const { text, added } = appendedLedger(existing, entries);
    if (added > 0) await $.fs.write(path, text);
    $.ui.log(`ledger: ${added} new of ${entries.length} entries in ${path}`);
    return path;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    $.ui.log(`ledger write failed (${reason}): ${path}`);
    return `${path} (write failed: ${reason})`;
  }
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const sessionId = await $.session.id();
      const ts = new Date(await $.clock.now()).toISOString();
      const config: HookConfig = {
        ...configured,
        apiKey: await getApiKey($, configured),
        sessionId,
        ledgerTs: ts,
      };
      const { result, messages } = await compactSession(
        event.messages,
        config,
        failFast(
          async (url, init) => {
            const response = await $.http.fetch(url, init);
            return { status: response.status, ok: response.ok, text: response.text };
          },
          (ms) => $.clock.sleep(ms, { signal: next.signal }),
        ),
      );
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (!result.compacted) {
        notify($, `fallback to built-in summary (max-drop guard refused: ${summarize(result)})`);
        return next(event);
      }
      if (config.onNothingToDrop === 'skip' && nothingToDrop(result, config)) {
        const skip = skipNotice(ts, result.stats.humanTurnsPinned);
        notify($, `${skip} (${summarize(result)})`);
        return { skip };
      }
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      const ledgerWhere =
        config.stubMode === 'none'
          ? '(no ledger: stubMode none)'
          : await writeLedger($, config, sessionId, result.ledger);
      const notice = compactionNotice({
        ts,
        results: result.stats.stubs + result.stats.digests,
        humanTurns: result.stats.humanTurnsPinned,
        ledgerPath: ledgerWhere,
      });
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages: withNotice(messages, notice) };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
