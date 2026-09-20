import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  boundedJevAsker,
  handleHook,
  MAX_HOOK_INPUT_BYTES,
  readBoundedHookInput,
} from '../src/codex/hook.js';

const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

async function hookFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jev-hook-')));
  const transcriptPath = join(directory, 'session.jsonl');
  const sessionId = 'session-hook';
  const records = [
    { type: 'session_meta', payload: { id: sessionId, cwd: directory, cli_version: '0.155.1' } },
    {
      type: 'response_item',
      payload: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'Continue the Q7 deployment investigation.' }],
      },
    },
    {
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: 'python status.py' },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output', call_id: 'call-1',
        output: [{ type: 'input_text', text: 'lease slot Q7; retry 137 seconds' }],
      },
    },
  ];
  await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return {
    directory,
    stateDir: join(directory, 'state'),
    transcriptPath,
    sessionId,
    pre: {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: directory,
      hook_event_name: 'PreCompact',
      model: 'gpt-test',
      turn_id: 'turn-1',
      trigger: 'auto',
    },
    start: {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: directory,
      hook_event_name: 'SessionStart',
      model: 'gpt-test',
      source: 'compact',
    },
  };
}

describe('Codex hook lifecycle', () => {
  it('stages selected evidence and delivers it once after compact', async () => {
    const fixture = await hookFixture();
    const errors: string[] = [];
    const asker = {
      async ask(_state: unknown, questions: Record<string, unknown>) {
        return { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { noul: 0.9 }])) };
      },
    };
    await expect(handleHook(fixture.pre, { stateDir: fixture.stateDir }, {
      asker, env: {}, uuid: () => uuid(1), now: () => 1_000, stderr: (line) => errors.push(line),
    })).resolves.toEqual({});

    const delivered = await handleHook(fixture.start, { stateDir: fixture.stateDir }, {
      uuid: () => uuid(2), now: () => 1_001, stderr: (line) => errors.push(line),
    });
    expect(delivered).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: expect.stringContaining('lease slot Q7; retry 137 seconds'),
      },
    });
    expect('hookSpecificOutput' in delivered ? delivered.hookSpecificOutput.additionalContext : '').toContain('"source_line"');
    await expect(handleHook(fixture.start, { stateDir: fixture.stateDir }, {
      uuid: () => uuid(3), now: () => 1_002, stderr: (line) => errors.push(line),
    })).resolves.toEqual({});
    expect(errors).toEqual([]);
  });

  it('makes a failed newer PreCompact generation supersede stale ready evidence', async () => {
    const fixture = await hookFixture();
    const errors: string[] = [];
    const good = { async ask() { return { answers: { c1: { noul: 1 } } }; } };
    await handleHook(fixture.pre, { stateDir: fixture.stateDir }, {
      asker: good, env: {}, uuid: () => uuid(1), now: () => 1_000, stderr: (line) => errors.push(line),
    });
    const secret = 'sk-this-must-never-be-reflected-123456';
    const failed = await handleHook(fixture.pre, { stateDir: fixture.stateDir }, {
      asker: { async ask() { throw new Error(`remote body ${secret}`); } },
      env: {}, uuid: () => uuid(2), now: () => 1_001, stderr: (line) => errors.push(line),
    });
    expect(failed).toEqual({
      systemMessage: '[jev-codex:JEV_REQUEST] native compaction continues without carried evidence',
    });
    const start = await handleHook(fixture.start, { stateDir: fixture.stateDir }, {
      uuid: () => uuid(3), now: () => 1_002, stderr: (line) => errors.push(line),
    });
    expect(start).toEqual({
      systemMessage: '[jev-codex:JEV_REQUEST] native compaction continues without carried evidence',
    });
    expect(JSON.stringify([failed, start, errors])).not.toContain(secret);
  });

  it('never publishes a late final Jev answer after the total deadline', async () => {
    const fixture = await hookFixture();
    let resolveAnswer!: (value: { answers: { c1: { noul: number } } }) => void;
    const answer = new Promise<{ answers: { c1: { noul: number } } }>((resolve) => { resolveAnswer = resolve; });
    const pre = await handleHook(fixture.pre, { stateDir: fixture.stateDir, operationTimeoutMs: 5 }, {
      asker: { async ask() { return answer; } },
      env: {}, uuid: () => uuid(1), now: () => 1_000, stderr: () => undefined,
    });
    expect(pre).toEqual({
      systemMessage: '[jev-codex:DEADLINE] native compaction continues without carried evidence',
    });
    resolveAnswer({ answers: { c1: { noul: 1 } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const start = await handleHook(fixture.start, { stateDir: fixture.stateDir }, {
      uuid: () => uuid(2), now: () => 1_001, stderr: () => undefined,
    });
    expect(start).toEqual({
      systemMessage: '[jev-codex:DEADLINE] native compaction continues without carried evidence',
    });
  });

  it('does nothing on startup/resume and visibly skips null identity or unsupported events', async () => {
    const fixture = await hookFixture();
    await expect(handleHook({ ...fixture.start, source: 'startup' })).resolves.toEqual({});
    await expect(handleHook({ ...fixture.start, source: 'resume' })).resolves.toEqual({});
    await expect(handleHook({ ...fixture.start, transcript_path: null }, {}, { stderr: () => undefined })).resolves.toEqual({
      systemMessage: '[jev-codex:IDENTITY_MISSING] native compaction continues without carried evidence',
    });
    await expect(handleHook({ ...fixture.start, hook_event_name: 'PostCompact' }, {}, { stderr: () => undefined })).resolves.toEqual({
      systemMessage: '[jev-codex:UNSUPPORTED_EVENT] native compaction continues without carried evidence',
    });
  });
});

describe('bounded hook transport', () => {
  it('enforces the stdin ceiling across chunks', async () => {
    async function* input() {
      yield Buffer.alloc(MAX_HOOK_INPUT_BYTES);
      yield Buffer.from('x');
    }
    await expect(readBoundedHookInput(input())).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
  });

  it('bounds HTTP responses and maps status/schema failures to local codes only', async () => {
    const signal = new AbortController().signal;
    let cancelled = false;
    const largeBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
      cancel() { cancelled = true; },
    });
    const large = boundedJevAsker('key', {}, async () => new Response(largeBody));
    await expect(large.ask('state', {}, signal)).rejects.toMatchObject({ code: 'JEV_RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);

    const remoteSecret = 'remote-secret-body';
    const failed = boundedJevAsker('key', {}, async () => new Response(remoteSecret, { status: 500 }));
    const failure = await failed.ask('state', {}, signal).catch((error: unknown) => error as Error & { code: string });
    expect(failure.code).toBe('JEV_HTTP');
    expect(failure.message).not.toContain(remoteSecret);

    const malformed = boundedJevAsker('key', {}, async () => new Response('{'));
    await expect(malformed.ask('state', {}, signal)).rejects.toMatchObject({ code: 'JEV_SCHEMA' });
  });
});
