// What a dropped tool call or result leaves behind: a one-line stub or a
// 1-3 line digest, plus the ledger entry that keeps its full output. Pure and
// deterministic: built from the call and its result text only, no model call,
// no file access (the caller writes the ledger), so the hook can use it too.
import { sliceOnCodePoints } from './state.js';
import type { LedgerEntry, Message, ToolCall } from './types.js';

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${sliceOnCodePoints(flat, 0, limit - 1)}…`;
}

const INPUT_KEYS = [
  'command',
  'file_path',
  'notebook_path',
  'description',
  'prompt',
  'message',
  'query',
  'pattern',
  'url',
  'path',
] as const;

/** The most telling string of a tool input (command, path, description, ...), whitespace collapsed. */
export function inputHead(tool: string, input: Record<string, unknown>, limit: number): string {
  const value = (key: string): string | undefined =>
    typeof input[key] === 'string' ? (input[key] as string) : undefined;
  let head =
    INPUT_KEYS.map(value).find((text) => text !== undefined) ??
    Object.values(input).find((text): text is string => typeof text === 'string') ??
    safeJson(input);
  // a leading `cd <dir> &&` says nothing about what the command did
  if (tool === 'Bash') head = head.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '');
  if (tool === 'SendMessage' && typeof input['to'] === 'string') head = `to=${input['to']} ${head}`;
  return clip(head, limit);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable input]';
  }
}

/** `ok` or `error`, with ` exit N` when the result starts like a failed shell command. */
export function outcome(text: string, isError: boolean): string {
  const exit = /^\s*Exit code (\d+)/.exec(text)?.[1];
  return `${isError ? 'error' : 'ok'}${exit !== undefined ? ` exit ${exit}` : ''}`;
}

const AGENT_TOOLS = new Set(['Agent', 'Task', 'SendMessage', 'TaskOutput', 'TaskStop']);
const AGENT_ID = /agent_?id\W{0,3}([0-9a-z][0-9a-z-]{7,})/i;

/**
 * The agent id a call concerns: from its result (`agentId: …`, `"resumedAgentId":"…"`),
 * else from its input (`to`, `agentId`, `task_id`, `resume`). Undefined for tools
 * that do not address an agent.
 */
export function agentIdOf(call: Pick<ToolCall, 'tool' | 'input'>, text: string): string | undefined {
  if (!AGENT_TOOLS.has(call.tool)) return undefined;
  const fromResult = AGENT_ID.exec(text)?.[1];
  if (fromResult) return fromResult;
  for (const key of ['to', 'agentId', 'agent_id', 'task_id', 'resume']) {
    const value = call.input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'unknown';
}

/** Boilerplate lines of agent launches that carry no evidence of their own. */
const BOILERPLATE =
  /internal (metadata|ID)|working in the background|notified automatically|Do not duplicate this agent|^agentId:/i;

/** Receipt patterns, strongest first: the first line matching the earliest pattern wins. */
const RECEIPTS: readonly RegExp[] = [
  /agent_?id\W{0,3}[0-9a-z]{8,}/i,
  /\/pull\/\d+|\bPR\s*#?\d+|\bpull request #?\d+/i,
  /\binvoice\b|\bINV-[A-Za-z0-9-]+/i,
  /(^|[\s'"(=:])(~|\/)[\w.@-]+\/[\w./@-]+/,
  /\b[0-9a-f]{7,40}\b/,
  /#\d+|\b\d{3,}\b/,
];

function resultLines(text: string): string[] {
  return text
    .split('\n')
    // the `   12→` prefix Read puts on every line
    .map((line) => line.replace(/^\s*\d+[\t→]\s?/, '').trim())
    .filter((line) => line.length > 0 && !BOILERPLATE.test(line));
}

/**
 * Up to two result lines, in result order: the first non-empty line, and the
 * first other line matching an id, path, number, PR, invoice or agentId
 * pattern (strongest pattern first), when there is one.
 */
export function keyLines(text: string, width = 100): string[] {
  const lines = resultLines(text);
  const first = lines[0];
  if (first === undefined) return [];
  let receipt = -1;
  for (const pattern of RECEIPTS) {
    receipt = lines.findIndex((line, index) => index > 0 && pattern.test(line));
    if (receipt >= 0) break;
  }
  return [first, ...(receipt > 0 ? [lines[receipt]!] : [])].map((line) => clip(line, width));
}

/** 64-bit FNV-1a, as hex; deterministic and dependency-free (no node:crypto in the hook engine). */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** The ledger key of one call: 12 hex of a hash of session and tool_use_id, stable across compactions. */
export function ledgerKey(sessionId: string, toolUseId: string): string {
  return fnv1a64(`${sessionId}:${toolUseId}`).slice(0, 12);
}

function tail(agent: string | undefined, key: string | undefined): string {
  return `${agent ? ` | agent:${agent}` : ''}${key ? ` | ledger:${key}` : ''}`;
}

/** 'line' mode: `[pruned <tool> "<input head 60>" → <outcome>, <n> chars | agent:… | ledger:…]`. */
export function stubLine(call: ToolCall, text: string, key?: string): string {
  return `[pruned ${call.tool} "${inputHead(call.tool, call.input, 60)}" → ${outcome(
    text,
    call.isError,
  )}, ${call.resultChars} chars${tail(agentIdOf(call, text), key)}]`;
}

/**
 * 'digest' mode, 1-3 lines: `~<tool> | <input head> | <outcome> | <n>ch | agent:… | ledger:…`,
 * then up to two `~ <key line>` lines from the result.
 */
export function digestText(call: ToolCall, text: string, key?: string): string {
  const head = inputHead(call.tool, call.input, 70);
  return [
    `~${call.tool} | ${head} | ${outcome(text, call.isError)} | ${call.resultChars}ch${tail(
      agentIdOf(call, text),
      key,
    )}`,
    ...keyLines(text).map((line) => `~ ${line}`),
  ].join('\n');
}

/** The full text of a call's result, from its tool_result block (else the tool_use mirror). */
export function resultTextOf(messages: readonly Message[], call: ToolCall): string {
  return (
    messages[call.resultIndex]?.toolResults?.find((r) => r.tool_use_id === call.tool_use_id)
      ?.text ??
    messages[call.callIndex]?.toolUses.find((t) => t.tool_use_id === call.tool_use_id)?.text ??
    ''
  );
}

/** Keys already in a ledger file's text; a torn line is skipped. */
export function ledgerKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const key = (JSON.parse(line) as { key?: unknown }).key;
      if (typeof key === 'string') keys.add(key);
    } catch {
      /* a torn line holds no key */
    }
  }
  return keys;
}

/** The JSONL lines of the entries whose key `existing` does not hold yet. */
export function newLedgerLines(entries: readonly LedgerEntry[], existing: Set<string>): string {
  const seen = new Set(existing);
  let out = '';
  for (const entry of entries) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    out += `${JSON.stringify(entry)}\n`;
  }
  return out;
}

export function ledgerEntry(
  call: ToolCall,
  text: string,
  key: string,
  sessionId: string,
  ts: string,
): LedgerEntry {
  return {
    key,
    ts,
    session: sessionId,
    tool_use_id: call.tool_use_id,
    tool: call.tool,
    input: call.input,
    result: text,
    isError: call.isError,
  };
}

/** Text a hook or script prefixes to recognise machine-made user messages. */
const MACHINE_USER_TEXT = /^\s*<(task-notification|system-reminder|local-command-)/;

/**
 * A human turn: a user message with text and no tool_result. Task
 * notifications, system reminders and local-command output are user messages
 * the engine writes, not the person, and do not count.
 */
export function isHumanTurn(message: Message): boolean {
  return (
    message.role === 'user' &&
    (message.toolResults ?? []).length === 0 &&
    message.text.trim().length > 0 &&
    !MACHINE_USER_TEXT.test(message.text)
  );
}

/**
 * Index of the `turns`-th most recent human turn, and how many human turns
 * that window holds (fewer when the transcript has fewer). `index` is
 * `messages.length` when `turns` is 0 or there is no human turn.
 */
export function recentHumanTurns(
  messages: readonly Message[],
  turns: number,
): { index: number; count: number } {
  let count = 0;
  let index = messages.length;
  for (let i = messages.length - 1; i >= 0 && count < turns; i--) {
    if (isHumanTurn(messages[i]!)) {
      count += 1;
      index = i;
    }
  }
  return { index, count };
}
