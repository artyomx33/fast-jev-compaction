import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseTranscript,
  readTranscriptBytes,
  type TranscriptIdentity,
} from '../src/codex/transcript.js';

const identity: TranscriptIdentity = {
  sessionId: 'session-1',
  cwd: '/fixture',
  transcriptPath: '/fixture/session.jsonl',
};

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: '2026-09-20T00:00:00Z', type, payload });
}

function fixture(lines: string[]): Uint8Array {
  return Buffer.from(`${lines.join('\n')}\n`);
}

describe('Codex transcript extraction', () => {
  it('parses only verified response items and preserves exact call/result text', () => {
    const original = fixture([
      line('session_meta', { id: identity.sessionId, cwd: identity.cwd, cli_version: '0.155.1' }),
      line('response_item', {
        type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'hidden developer' }],
      }),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>hidden bootstrap</environment_context>' },
          { type: 'input_text', text: 'Investigate lease slot Q7 exactly.' },
        ],
      }),
      line('response_item', {
        type: 'function_call', call_id: 'call-1', namespace: 'collaboration', name: 'list_agents', arguments: '{"scope":"all"}',
      }),
      line('response_item', {
        type: 'function_call_output', call_id: 'call-1', output: 'agent alpha\nagent beta',
      }),
      line('response_item', {
        type: 'reasoning', summary: [{ type: 'summary_text', text: 'hidden reasoning' }],
      }),
      line('response_item', {
        type: 'custom_tool_call', call_id: 'call-2', name: 'exec', input: 'run status --exact', status: 'completed',
      }),
      line('response_item', {
        type: 'custom_tool_call_output',
        call_id: 'call-2',
        output: [
          { type: 'input_text', text: 'Script completed\nOutput:\n' },
          { type: 'input_text', text: 'FATAL spindle lease expired at slot Q7.' },
        ],
      }),
    ]);
    const before = createHash('sha256').update(original).digest('hex');

    const parsed = parseTranscript(original, identity);

    expect(parsed.task).toBe('Investigate lease slot Q7 exactly.');
    expect(parsed.candidates).toEqual([
      expect.objectContaining({
        callId: 'call-1',
        tool: 'collaboration.list_agents',
        input: '{"scope":"all"}',
        result: 'agent alpha\nagent beta',
      }),
      expect.objectContaining({
        callId: 'call-2',
        tool: 'exec',
        input: 'run status --exact',
        result: 'Script completed\nOutput:\n\nFATAL spindle lease expired at slot Q7.',
      }),
    ]);
    expect(createHash('sha256').update(original).digest('hex')).toBe(before);
  });

  it('excludes bootstrap, memory, and credential reads before redacting remaining secrets', () => {
    const activeKey = 'typesafe-private-key-value';
    const records = [
      line('session_meta', { id: identity.sessionId, cwd: identity.cwd }),
      line('response_item', {
        type: 'message', role: 'user', content: [
          { type: 'input_text', text: '# AGENTS.md instructions for /tmp\n<INSTRUCTIONS>private bootstrap</INSTRUCTIONS>' },
          { type: 'input_text', text: 'Continue.' },
        ],
      }),
      ...[
        ['a', 'cat "AGENTS.md"'],
        ['b', 'cat ~/.claude/knowledge/RULINGS.md'],
        ['c', "cat '.env'"],
        ['e', 'mcp__graphiti__search_memory_facts'],
        ['d', 'printf ordinary'],
      ].flatMap(([callId, input]) => [
        line('response_item', { type: 'custom_tool_call', call_id: callId, name: 'exec', input }),
        line('response_item', {
          type: 'custom_tool_call_output', call_id: callId,
          output: [{
            type: 'input_text',
            text: `value ${activeKey} ghp_abcdefghijklmnopqrstuvwxyz123456 github_pat_abcdefghijklmnopqrstuvwxyz ` +
              'apikey_abcdefghijklmnopqrstuvwxyz eyJabcdefghijk.abcdefghijkl.abcdefghijkl ' +
              '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY----- ' +
              '{"password":"long-secret-value","API_KEY":"other-long-key"}',
          }],
        }),
      ]),
    ];

    const parsed = parseTranscript(fixture(records), identity, activeKey);

    expect(parsed.task).toBe('Continue.');
    expect(parsed.excluded).toMatchObject({ bootstrap: 1, memory: 2, credential: 1 });
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]!.result).not.toContain('private-material');
    expect(parsed.candidates[0]!.result).not.toContain('long-secret-value');
    expect(parsed.candidates[0]!.result).not.toContain('other-long-key');
    expect(parsed.candidates[0]!.result.match(/\[REDACTED_SECRET\]/g)).toHaveLength(7);
    expect(JSON.stringify(parsed)).not.toContain(activeKey);
  });

  it('rejects identity drift, duplicate session metadata, and unsupported tool output shapes', () => {
    expect(() => parseTranscript(fixture([
      line('session_meta', { id: 'other', cwd: identity.cwd }),
    ]), identity)).toThrowError('TRANSCRIPT_IDENTITY');

    expect(() => parseTranscript(fixture([
      line('session_meta', { id: identity.sessionId, cwd: identity.cwd }),
      line('session_meta', { id: identity.sessionId, cwd: identity.cwd }),
    ]), identity)).toThrowError('TRANSCRIPT_IDENTITY');

    const parsed = parseTranscript(fixture([
      line('session_meta', { id: identity.sessionId, cwd: identity.cwd }),
      line('response_item', { type: 'custom_tool_call', call_id: 'x', name: 'exec', input: 'ok' }),
      line('response_item', {
        type: 'custom_tool_call_output', call_id: 'x', output: [{ type: 'image', data: 'secret' }],
      }),
    ]), identity);
    expect(parsed.candidates).toEqual([]);
    expect(parsed.excluded.malformed).toBe(1);
    expect(parsed.excluded.unpaired).toBe(1);
  });

  it('enforces streamed transcript and per-line byte ceilings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jev-transcript-'));
    const path = join(directory, 'session.jsonl');
    await writeFile(path, '1234\n5678\n', 'utf8');
    await expect(readTranscriptBytes(path, 8, 10)).rejects.toThrowError('TRANSCRIPT_TOO_LARGE');
    await expect(readTranscriptBytes(path, 20, 3)).rejects.toThrowError('TRANSCRIPT_LINE_TOO_LARGE');
    await expect(readTranscriptBytes(path, 20, 10)).resolves.toEqual(await readFile(path));
  });

  it('keeps only the newest 64 pairs and clips by Unicode characters without splitting', () => {
    const records = [line('session_meta', { id: identity.sessionId, cwd: identity.cwd })];
    for (let index = 0; index < 66; index += 1) {
      records.push(
        line('response_item', { type: 'function_call', call_id: `x${index}`, name: 'tool', arguments: `input-${index}` }),
        line('response_item', { type: 'function_call_output', call_id: `x${index}`, output: `${'🙂'.repeat(2100)}-${index}` }),
      );
    }
    const parsed = parseTranscript(fixture(records), identity);
    expect(parsed.candidates).toHaveLength(64);
    expect(parsed.candidates[0]!.callId).toBe('x2');
    expect(Array.from(parsed.candidates[0]!.result)).toHaveLength(2_000);
    expect(parsed.candidates[0]!.result).not.toContain('\uFFFD');
  });
});
