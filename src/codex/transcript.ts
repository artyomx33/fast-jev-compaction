import { realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

export const TRANSCRIPT_VERSION = 1;
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
export const MAX_TRANSCRIPT_LINE_BYTES = 512 * 1024;
export const MAX_CANDIDATES = 64;
export const MAX_INPUT_CHARS = 500;
export const MAX_RESULT_CHARS = 2_000;
export const MAX_TASK_CHARS = 3_000;

export interface TranscriptIdentity {
  sessionId: string;
  cwd: string;
  transcriptPath: string;
}

export interface EvidenceCandidate {
  id: string;
  callId: string;
  tool: string;
  input: string;
  result: string;
  sourceLine: number;
  clipped: {
    input: boolean;
    result: boolean;
  };
}

export interface TranscriptExclusions {
  bootstrap: number;
  credential: number;
  memory: number;
  malformed: number;
  unpaired: number;
}

export interface ParsedTranscript {
  task: string;
  candidates: EvidenceCandidate[];
  excluded: TranscriptExclusions;
  clipped: number;
}

export class TranscriptError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function charLength(value: string): number {
  return Array.from(value).length;
}

function clipEnd(value: string, limit: number): { text: string; clipped: boolean } {
  const chars = Array.from(value);
  if (chars.length <= limit) return { text: value, clipped: false };
  const marker = '\n[... clipped ...]';
  const markerLength = charLength(marker);
  return {
    text: `${chars.slice(0, Math.max(0, limit - markerLength)).join('')}${marker}`,
    clipped: true,
  };
}

function clipMiddle(value: string, limit: number): { text: string; clipped: boolean } {
  const chars = Array.from(value);
  if (chars.length <= limit) return { text: value, clipped: false };
  const marker = '\n[... clipped ...]\n';
  const remaining = Math.max(0, limit - charLength(marker));
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return {
    text: `${chars.slice(0, head).join('')}${marker}${chars.slice(chars.length - tail).join('')}`,
    clipped: true,
  };
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bapikey_[A-Za-z0-9_-]{16,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
];

export function redactSecrets(value: string, apiKey = ''): string {
  let redacted = value;
  if (apiKey) redacted = redacted.split(apiKey).join('[REDACTED_ACTIVE_API_KEY]');
  redacted = redacted.replace(
    /\b(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)\b(['"]?\s*[=:]\s*['"]?)[^\s'";,}]{8,}/gi,
    '$1$2[REDACTED_SECRET]',
  );
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED_SECRET]');
  }
  return redacted;
}

type Exclusion = 'bootstrap' | 'credential' | 'memory';

function exclusionFor(tool: string, input: string): Exclusion | undefined {
  const target = `${tool}\n${input}`;
  if (
    /(?:^|[/\\\s'"])(?:AGENTS|CLAUDE|FLEET-LAW|MAP|soul)\.md\b/i.test(target) ||
    /(?:^|\s)(?:system|developer)\s+(?:prompt|message)\b/i.test(target)
  ) return 'bootstrap';
  if (
    /(?:^|[/\\\s'"])MEMORY\.md\b/i.test(target) ||
    /[/\\](?:\.claude[/\\])?(?:knowledge|memory)(?:[/\\]|$)/i.test(target) ||
    /\b(?:mcp__)?(?:graphiti|memory)(?:__|[._-])(?:search|read|get|list)[A-Za-z0-9_.-]*\b/i.test(target) ||
    /\b(?:search_memory_facts|get_episodes|search_nodes)\b/i.test(target)
  ) return 'memory';
  if (
    /(?:^|[/\\\s'"])\.env(?:\.[^/\\\s'"]+)?\b/i.test(target) ||
    /(?:^|[/\\\s'"])(?:auth|credentials?|secrets?|tokens?)\.json\b/i.test(target) ||
    /\b(?:printenv|security\s+find-|op\s+read|pass\s+show)\b/i.test(target) ||
    /\b(?:keychain|credential|private[_ -]?key)\b/i.test(target)
  ) return 'credential';
  return undefined;
}

function textContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const blocks: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || item.type !== 'input_text' || typeof item.text !== 'string') {
      return undefined;
    }
    blocks.push(item.text);
  }
  return blocks.join('\n');
}

interface PendingCall {
  callId: string;
  tool: string;
  input: string;
  sourceLine: number;
}

interface PendingOutput {
  callId: string;
  result: string;
}

function callFrom(payload: Record<string, unknown>, sourceLine: number): PendingCall | undefined {
  if (payload.type === 'function_call') {
    if (
      typeof payload.call_id !== 'string' ||
      typeof payload.name !== 'string' ||
      typeof payload.arguments !== 'string'
    ) return undefined;
    const tool = typeof payload.namespace === 'string'
      ? `${payload.namespace}.${payload.name}`
      : payload.name;
    return { callId: payload.call_id, tool, input: payload.arguments, sourceLine };
  }
  if (payload.type === 'custom_tool_call') {
    if (
      typeof payload.call_id !== 'string' ||
      typeof payload.name !== 'string' ||
      typeof payload.input !== 'string'
    ) return undefined;
    return { callId: payload.call_id, tool: payload.name, input: payload.input, sourceLine };
  }
  return undefined;
}

function outputFrom(payload: Record<string, unknown>): PendingOutput | undefined {
  if (payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') {
    return undefined;
  }
  if (typeof payload.call_id !== 'string') return undefined;
  const result = textContent(payload.output);
  if (result === undefined) return undefined;
  return { callId: payload.call_id, result };
}

function userText(payload: Record<string, unknown>): string | undefined {
  if (payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of payload.content) {
    if (isRecord(block) && block.type === 'input_text' && typeof block.text === 'string') {
      const trimmed = block.text.trimStart();
      if (
        !trimmed.startsWith('<recommended_plugins>') &&
        !trimmed.startsWith('<environment_context>') &&
        !trimmed.startsWith('# AGENTS.md instructions') &&
        !trimmed.startsWith('<INSTRUCTIONS>') &&
        !trimmed.includes('\n# AGENTS.md instructions')
      ) parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export async function canonicalIdentity(
  sessionId: string,
  cwd: string,
  transcriptPath: string,
): Promise<TranscriptIdentity> {
  if (!sessionId || !cwd || !transcriptPath) throw new TranscriptError('IDENTITY_MISSING');
  try {
    const [canonicalCwd, canonicalTranscript] = await Promise.all([
      realpath(cwd),
      realpath(transcriptPath),
    ]);
    return { sessionId, cwd: canonicalCwd, transcriptPath: canonicalTranscript };
  } catch {
    throw new TranscriptError('IDENTITY_INVALID');
  }
}

/** Reads without modifying the transcript and enforces byte and JSONL-line ceilings while streaming. */
export async function readTranscriptBytes(
  transcriptPath: string,
  maxBytes = MAX_TRANSCRIPT_BYTES,
  maxLineBytes = MAX_TRANSCRIPT_LINE_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let lineBytes = 0;
  const stream = createReadStream(transcriptPath);
  const abort = () => stream.destroy(new TranscriptError('DEADLINE'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const raw of stream) {
      if (signal?.aborted) throw new TranscriptError('DEADLINE');
      const chunk = raw as Buffer;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new TranscriptError('TRANSCRIPT_TOO_LARGE');
      for (const byte of chunk) {
        if (byte === 0x0a) lineBytes = 0;
        else {
          lineBytes += 1;
          if (lineBytes > maxLineBytes) throw new TranscriptError('TRANSCRIPT_LINE_TOO_LARGE');
        }
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof TranscriptError) throw error;
    throw new TranscriptError('TRANSCRIPT_OPEN');
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  return Buffer.concat(chunks, bytes);
}

/** Parses only the version-scoped Codex JSONL records documented in codex/README.md. */
export function parseTranscript(
  bytes: Uint8Array,
  identity: TranscriptIdentity,
  apiKey = '',
): ParsedTranscript {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TranscriptError('TRANSCRIPT_SCHEMA');
  }
  const lines = source.split('\n');
  const calls = new Map<string, PendingCall>();
  const outputs = new Map<string, PendingOutput>();
  const duplicateIds = new Set<string>();
  const userMessages: string[] = [];
  const excluded: TranscriptExclusions = {
    bootstrap: 0,
    credential: 0,
    memory: 0,
    malformed: 0,
    unpaired: 0,
  };
  let sessionMetaCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new TranscriptError('TRANSCRIPT_SCHEMA');
    }
    if (!isRecord(record) || typeof record.type !== 'string' || !isRecord(record.payload)) {
      throw new TranscriptError('TRANSCRIPT_SCHEMA');
    }
    const payload = record.payload;
    if (record.type === 'session_meta') {
      sessionMetaCount += 1;
      if (
        sessionMetaCount !== 1 ||
        payload.id !== identity.sessionId ||
        typeof payload.cwd !== 'string' ||
        payload.cwd !== identity.cwd
      ) throw new TranscriptError('TRANSCRIPT_IDENTITY');
      continue;
    }
    if (record.type !== 'response_item') continue;

    const text = userText(payload);
    if (text !== undefined) userMessages.push(text);

    const call = callFrom(payload, index + 1);
    if (call) {
      if (calls.has(call.callId)) duplicateIds.add(call.callId);
      else calls.set(call.callId, call);
      continue;
    }
    const output = outputFrom(payload);
    if (output) {
      if (outputs.has(output.callId)) duplicateIds.add(output.callId);
      else outputs.set(output.callId, output);
      continue;
    }
    if (
      payload.type === 'function_call' || payload.type === 'custom_tool_call' ||
      payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output'
    ) excluded.malformed += 1;
  }
  if (sessionMetaCount !== 1) throw new TranscriptError('TRANSCRIPT_IDENTITY');

  const paired: Array<{ call: PendingCall; output: PendingOutput }> = [];
  for (const call of calls.values()) {
    const output = outputs.get(call.callId);
    if (!output || duplicateIds.has(call.callId)) {
      excluded.unpaired += 1;
      continue;
    }
    const exclusion = exclusionFor(call.tool, call.input);
    if (exclusion) {
      excluded[exclusion] += 1;
      continue;
    }
    paired.push({ call, output });
  }
  for (const callId of outputs.keys()) {
    if (!calls.has(callId)) excluded.unpaired += 1;
  }

  const recent = paired.slice(-MAX_CANDIDATES);
  const candidates = recent.map(({ call, output }, index): EvidenceCandidate => {
    const safeInput = redactSecrets(call.input, apiKey);
    const safeResult = redactSecrets(output.result, apiKey);
    const input = clipEnd(safeInput, MAX_INPUT_CHARS);
    const result = clipMiddle(safeResult, MAX_RESULT_CHARS);
    return {
      id: `c${index + 1}`,
      callId: call.callId,
      tool: call.tool,
      input: input.text,
      result: result.text,
      sourceLine: call.sourceLine,
      clipped: { input: input.clipped, result: result.clipped },
    };
  });
  const safeTask = redactSecrets(userMessages.slice(-3).join('\n\n'), apiKey);
  const task = clipEnd(safeTask, MAX_TASK_CHARS).text;
  return {
    task,
    candidates,
    excluded,
    clipped: candidates.filter((candidate) => candidate.clipped.input || candidate.clipped.result).length,
  };
}
