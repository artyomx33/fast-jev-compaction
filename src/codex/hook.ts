#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../request.js';
import type { JevQuestions, JevResponse, JevState } from '../types.js';
import {
  beginGeneration,
  buildAdditionalContext,
  CarryoverError,
  claimGeneration,
  finishGeneration,
  scoreEvidence,
  type EvidenceAsker,
  type GenerationHandle,
} from './carryover.js';
import {
  canonicalIdentity,
  parseTranscript,
  readTranscriptBytes,
  TranscriptError,
} from './transcript.js';

export const MAX_HOOK_INPUT_BYTES = 64 * 1024;
export const MAX_HTTP_RESPONSE_BYTES = 256 * 1024;
export const OPERATION_TIMEOUT_MS = 20_000;

export interface HookConfig {
  stateDir?: string;
  keyFile?: string;
  model?: string;
  baseUrl?: string;
  keepThreshold?: number;
  operationTimeoutMs?: number;
}

export interface HookDeps {
  asker?: EvidenceAsker;
  fetch?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
}

type ResolvedHookDeps = HookDeps & {
  now: () => number;
  uuid: () => string;
  env: NodeJS.ProcessEnv;
  stderr: (line: string) => void;
};

export type HookOutput =
  | Record<string, never>
  | { systemMessage: string }
  | {
      hookSpecificOutput: {
        hookEventName: 'SessionStart';
        additionalContext: string;
      };
    };

interface CommonHookInput {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: string;
  model?: string;
}

interface PreCompactInput extends CommonHookInput {
  hook_event_name: 'PreCompact';
  turn_id: string;
  trigger: 'manual' | 'auto';
}

interface SessionStartInput extends CommonHookInput {
  hook_event_name: 'SessionStart';
  source: string;
}

class HookFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function localCode(error: unknown): string {
  if (error instanceof HookFailure || error instanceof CarryoverError || error instanceof TranscriptError) {
    return error.code;
  }
  return 'INTERNAL';
}

function visibleError(code: string, stderr: (line: string) => void): HookOutput {
  const message = `[jev-codex:${code}] native compaction continues without carried evidence`;
  stderr(message);
  return { systemMessage: message };
}

function parseCommon(event: unknown): CommonHookInput {
  if (
    !isRecord(event) || typeof event.session_id !== 'string' ||
    typeof event.cwd !== 'string' || typeof event.hook_event_name !== 'string' ||
    !(typeof event.transcript_path === 'string' || event.transcript_path === null)
  ) throw new HookFailure('INPUT_SCHEMA');
  return event as unknown as CommonHookInput;
}

function parsePreCompact(event: CommonHookInput): PreCompactInput {
  if (
    event.hook_event_name !== 'PreCompact' || !isRecord(event) ||
    typeof event.turn_id !== 'string' ||
    (event.trigger !== 'manual' && event.trigger !== 'auto')
  ) throw new HookFailure('INPUT_SCHEMA');
  return event as unknown as PreCompactInput;
}

function parseSessionStart(event: CommonHookInput): SessionStartInput {
  if (event.hook_event_name !== 'SessionStart' || !isRecord(event) || typeof event.source !== 'string') {
    throw new HookFailure('INPUT_SCHEMA');
  }
  return event as unknown as SessionStartInput;
}

async function loadApiKey(config: HookConfig, env: NodeJS.ProcessEnv): Promise<string> {
  if (!config.keyFile) return env.TYPESAFE_API_KEY ?? '';
  let source: string;
  try {
    source = await readFile(config.keyFile, 'utf8');
  } catch {
    throw new HookFailure('KEY_FILE');
  }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[1]!;
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) value = value.slice(1, -1);
    return value;
  }
  return '';
}

async function readResponseText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new CarryoverError('DEADLINE');
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_HTTP_RESPONSE_BYTES) throw new CarryoverError('JEV_RESPONSE_TOO_LARGE');
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch {
    throw new CarryoverError('JEV_SCHEMA');
  }
}

export function boundedJevAsker(
  apiKey: string,
  config: HookConfig,
  fetcher: typeof fetch,
): EvidenceAsker {
  return {
    async ask(state: JevState, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse> {
      if (!apiKey) throw new CarryoverError('API_KEY_MISSING');
      if (!signal) throw new CarryoverError('DEADLINE');
      const request = buildJevRequest(
        { apiKey, model: config.model ?? DEFAULT_MODEL, baseUrl: config.baseUrl },
        state,
        questions,
      );
      let response: Response;
      try {
        response = await fetcher(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal,
        });
      } catch {
        throw new CarryoverError(signal.aborted ? 'DEADLINE' : 'JEV_REQUEST');
      }
      const text = await readResponseText(response, signal);
      if (!response.ok) throw new CarryoverError('JEV_HTTP');
      try {
        return parseJevResponse(response.status, response.ok, text);
      } catch {
        throw new CarryoverError('JEV_SCHEMA');
      }
    },
  };
}

async function withDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HookFailure('DEADLINE'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handlePreCompact(
  event: PreCompactInput,
  config: HookConfig,
  deps: ResolvedHookDeps & { signal: AbortSignal },
): Promise<HookOutput> {
  if (event.transcript_path === null) throw new HookFailure('IDENTITY_MISSING');
  const identity = await canonicalIdentity(event.session_id, event.cwd, event.transcript_path);
  const stateDir = config.stateDir ?? join(homedir(), '.local', 'state', 'jev-codex');
  let generation: GenerationHandle | undefined;
  const startedAt = deps.now();
  try {
    generation = await beginGeneration(stateDir, identity, startedAt, deps.uuid);
    const apiKey = await loadApiKey(config, deps.env);
    const bytes = await readTranscriptBytes(identity.transcriptPath, undefined, undefined, deps.signal);
    const parsed = parseTranscript(bytes, identity, apiKey);
    const asker = deps.asker ?? boundedJevAsker(apiKey, config, deps.fetch ?? fetch);
    const scored = parsed.candidates.length === 0
      ? { selected: [], receipt: { candidates: 0, selected: 0, requests: 0, scores: [] } }
      : await scoreEvidence(parsed.candidates, parsed.task, asker, {
          keepThreshold: config.keepThreshold,
          signal: deps.signal,
        });
    if (deps.signal.aborted) throw new CarryoverError('DEADLINE');
    const built = buildAdditionalContext(scored.selected);
    await finishGeneration(generation, {
      status: 'ready',
      context: built.context,
      receipt: {
        candidates: parsed.candidates.length,
        eligible: scored.selected.length,
        selected: built.delivered,
        requests: scored.receipt.requests,
        excluded: parsed.excluded,
        clipped: parsed.clipped,
        durationMs: Math.max(0, deps.now() - startedAt),
        transcriptHash: createHash('sha256').update(bytes).digest('hex'),
      },
    }, deps.signal);
    if (deps.signal.aborted) throw new CarryoverError('DEADLINE');
    return {};
  } catch (error) {
    const code = localCode(error);
    if (generation) {
      try {
        await finishGeneration(generation, {
          status: 'error',
          code,
          receipt: { durationMs: Math.max(0, deps.now() - startedAt) },
        });
      } catch {
        return visibleError('STATE_IO', deps.stderr);
      }
    }
    return visibleError(code, deps.stderr);
  }
}

async function handleSessionStart(
  event: SessionStartInput,
  config: HookConfig,
  deps: ResolvedHookDeps,
): Promise<HookOutput> {
  if (event.source !== 'compact') return {};
  if (event.transcript_path === null) throw new HookFailure('IDENTITY_MISSING');
  const identity = await canonicalIdentity(event.session_id, event.cwd, event.transcript_path);
  const stateDir = config.stateDir ?? join(homedir(), '.local', 'state', 'jev-codex');
  const claim = await claimGeneration(stateDir, identity, deps.now(), undefined, deps.uuid);
  if (claim.outcome === 'none' || claim.outcome === 'empty') return {};
  if (claim.outcome === 'skip') return visibleError(claim.code, deps.stderr);
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: claim.context,
    },
  };
}

/** Handles one documented Codex hook event. Every failure remains local and non-blocking. */
export async function handleHook(
  input: unknown,
  config: HookConfig = {},
  deps: HookDeps = {},
): Promise<HookOutput> {
  const resolved: ResolvedHookDeps = {
    ...deps,
    now: deps.now ?? Date.now,
    uuid: deps.uuid ?? randomUUID,
    env: deps.env ?? process.env,
    stderr: deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`)),
  };
  try {
    const event = parseCommon(input);
    if (event.hook_event_name === 'PreCompact') {
      return await withDeadline(config.operationTimeoutMs ?? OPERATION_TIMEOUT_MS, (signal) =>
        handlePreCompact(parsePreCompact(event), config, { ...resolved, signal }));
    }
    if (event.hook_event_name === 'SessionStart') {
      return await withDeadline(config.operationTimeoutMs ?? OPERATION_TIMEOUT_MS, () =>
        handleSessionStart(parseSessionStart(event), config, resolved));
    }
    return visibleError('UNSUPPORTED_EVENT', resolved.stderr);
  } catch (error) {
    return visibleError(localCode(error), resolved.stderr);
  }
}

export async function readBoundedHookInput(
  source: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of source) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_HOOK_INPUT_BYTES) throw new HookFailure('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

export function parseCliArgs(args: readonly string[]): HookConfig {
  const config: HookConfig = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !flag) throw new HookFailure('CLI_ARGS');
    if (flag === '--state-dir') config.stateDir = value;
    else if (flag === '--key-file') config.keyFile = value;
    else if (flag === '--model') config.model = value;
    else throw new HookFailure('CLI_ARGS');
    index += 1;
  }
  return config;
}

async function main(): Promise<void> {
  let output: HookOutput;
  try {
    const bytes = await readBoundedHookInput(process.stdin);
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new HookFailure('INPUT_SCHEMA');
    }
    output = await handleHook(input, parseCliArgs(process.argv.slice(2)));
  } catch (error) {
    output = visibleError(localCode(error), (line) => process.stderr.write(`${line}\n`));
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
