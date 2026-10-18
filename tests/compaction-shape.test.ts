import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentIdOf,
  appendLedger,
  collectToolCalls,
  compact,
  digestText,
  isHumanTurn,
  keyLines,
  ledgerKey,
  outcome,
  recentHumanTurns,
  stubLine,
  type JevAsker,
  type JevQuestions,
  type LedgerEntry,
  type Message,
  type ToolCall,
} from '../src/index.js';
import {
  appendLedgerFs,
  compactionNotice,
  NOTICE_PREFIX,
  register,
  withNotice,
} from '../hooks/fast-jev.ts';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text = ''): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

const agentResult = [
  'Async agent launched successfully.',
  'agentId: a6779c2b76fe06ebb (internal ID - do not mention to user.)',
  'The agent is working in the background. You will be notified automatically when it completes.',
  'output_file: /private/tmp/tasks/a6779c2b76fe06ebb.output',
].join('\n');

const bigRead = Array.from({ length: 80 }, (_, i) => `${String(i + 1).padStart(6)}→const line${i} = ${i};`).join('\n');

function transcript(): Message[] {
  return [
    message('user', 'Ship the invoice fix.'),
    call('u-agent', 'Agent', { description: 'Research muxin project and security', prompt: 'go' }),
    result('u-agent', agentResult),
    call('u-bash', 'Bash', { command: 'cd /repo && gh pr create --title "Fix invoices" --body x' }),
    result('u-bash', 'Exit code 1\nerror: a pull request for branch fix already exists\nhttps://github.com/o/r/pull/42', true),
    call('u-read', 'Read', { file_path: '/Users/me/projects/app/src/invoice.ts' }),
    result('u-read', bigRead),
    message('assistant', 'Dispatched the research agent; PR 42 exists.'),
    message('user', 'continue'),
    message('assistant', 'continuing'),
  ];
}

function fakeJev(answer: (name: string) => number): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }]),
        ),
      };
    },
  };
}

/** Drops every call except the Read, whose result alone is dropped. */
const dropAll = fakeJev((name) => (name === 'call_t3' ? 0.9 : 0.05));
const base = { preserveRecentMessages: 1, sessionId: 'sess-1', ledgerTs: '2026-10-18T07:00:00.000Z' };

function textOf(messages: readonly Message[]): string {
  return messages
    .map((m) => [m.text, ...(m.toolResults ?? []).map((r) => r.text)].join('\n'))
    .join('\n');
}

const asCall = (messages: Message[], id: string): ToolCall =>
  collectToolCalls(messages, 0).find((c) => c.tool_use_id === id)!;

describe('stub and digest text', () => {
  it('reads the outcome and exit code from the result', () => {
    expect(outcome('Exit code 2\nboom', true)).toBe('error exit 2');
    expect(outcome('fine', false)).toBe('ok');
    expect(outcome('broken', true)).toBe('error');
  });

  it('builds a one-line stub with the input head capped at 60 chars', () => {
    const messages = transcript();
    const stub = stubLine(asCall(messages, 'u-bash'), messages[4]!.toolResults![0]!.text, 'abc');
    expect(stub).toMatch(/^\[pruned Bash "gh pr create --title "Fix invoices" --body x" → error exit 1, \d+ chars \| ledger:abc\]$/);
    const long = call('u-long', 'Bash', { command: 'x'.repeat(200) });
    const longMessages = [message('user', 'go'), long, result('u-long', 'ok')];
    const head = /"(x+…)"/.exec(stubLine(asCall(longMessages, 'u-long'), 'ok'))![1]!;
    expect(head.length).toBe(60);
    expect(stub.includes('\n')).toBe(false);
  });

  it('always carries the agent id for agent tools, from the result or the input', () => {
    const messages = transcript();
    const agent = asCall(messages, 'u-agent');
    expect(agentIdOf(agent, agentResult)).toBe('a6779c2b76fe06ebb');
    expect(stubLine(agent, agentResult)).toMatch(/agent:a6779c2b76fe06ebb/);
    expect(digestText(agent, agentResult, 'k1')).toMatch(/agent:a6779c2b76fe06ebb \| ledger:k1/);
    const send = { ...agent, tool: 'SendMessage', input: { to: 'a876e8afb4fd89240', message: 'hi' } };
    expect(agentIdOf(send, '{"success":true,"resumedAgentId":"a876e8afb4fd89240"}')).toBe('a876e8afb4fd89240');
    expect(agentIdOf(send, 'queued')).toBe('a876e8afb4fd89240');
    expect(agentIdOf({ ...agent, input: {} }, 'no id here')).toBe('unknown');
    expect(agentIdOf({ ...agent, tool: 'Read' }, agentResult)).toBeUndefined();
  });

  it('picks the first non-empty line and the strongest receipt line, deterministically', () => {
    expect(keyLines('\n\nfirst line\nnothing\nsee https://github.com/o/r/pull/42\ncommit abcdef1')).toEqual([
      'first line',
      'see https://github.com/o/r/pull/42',
    ]);
    expect(keyLines('only line')).toEqual(['only line']);
    expect(keyLines('')).toEqual([]);
    // Read's line-number prefixes are stripped; agent boilerplate is skipped
    expect(keyLines(agentResult)).toEqual([
      'Async agent launched successfully.',
      'output_file: /private/tmp/tasks/a6779c2b76fe06ebb.output',
    ]);
    const digest = digestText(asCall(transcript(), 'u-read'), bigRead, 'k2');
    const lines = digest.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toMatch(/^~Read \| \/Users\/me\/projects\/app\/src\/invoice\.ts \| ok \| \d+ch \| ledger:k2$/);
    expect(lines[1]).toBe('~ const line0 = 0;');
  });

  it('derives a stable 12-hex ledger key from session and tool_use_id', () => {
    expect(ledgerKey('s', 'u1')).toMatch(/^[0-9a-f]{12}$/);
    expect(ledgerKey('s', 'u1')).toBe(ledgerKey('s', 'u1'));
    expect(ledgerKey('s', 'u1')).not.toBe(ledgerKey('s', 'u2'));
    expect(ledgerKey('s', 'u1')).not.toBe(ledgerKey('t', 'u1'));
  });
});

describe('stubMode', () => {
  it("'none' reproduces the upstream silent drop and writes no ledger", async () => {
    const output = await compact(transcript(), dropAll, { ...base, stubMode: 'none' });
    expect(output.ledger).toEqual([]);
    expect(output.stats.stubs + output.stats.digests).toBe(0);
    expect(textOf(output.messages)).not.toMatch(/pruned|~Agent|ledger:/);
    expect(textOf(output.messages)).toMatch(/fast-jev-compaction truncated/);
  });

  it("'line' leaves one stub per dropped call in the assistant message that held it", async () => {
    const output = await compact(transcript(), dropAll, { ...base, stubMode: 'line' });
    expect(output.stats.stubs).toBe(2);
    const stubs = output.messages.flatMap((m) => m.text.split('\n')).filter((t) => t.startsWith('[pruned'));
    expect(stubs).toHaveLength(2);
    expect(stubs[0]).toMatch(/^\[pruned Agent "Research muxin project and security" → ok, \d+ chars \| agent:a6779c2b76fe06ebb \| ledger:[0-9a-f]{12}\]$/);
    expect(stubs[1]).toMatch(/^\[pruned Bash "gh pr create/);
    // the truncated Read keeps its head, and its note names the ledger key
    expect(textOf(output.messages)).toMatch(/re-run the tool if needed\] ledger:[0-9a-f]{12}/);
    expect(output.ledger.map((e) => e.tool)).toEqual(['Agent', 'Bash', 'Read']);
  });

  it("'digest' (the default) replaces dropped calls and dropped results with digests", async () => {
    const output = await compact(transcript(), dropAll, base);
    expect(output.stats.stubs).toBe(2);
    expect(output.stats.digests).toBe(1);
    const all = textOf(output.messages);
    expect(all).toMatch(/^~Agent \| Research muxin project and security \| ok \| \d+ch \| agent:a6779c2b76fe06ebb \| ledger:/m);
    expect(all).toMatch(/^~Bash \| gh pr create .* \| error exit 1 \| \d+ch \| ledger:/m);
    expect(all).toMatch(/^~ https:\/\/github\.com\/o\/r\/pull\/42$/m);
    expect(all).not.toMatch(/const line40/);
    for (const entry of output.ledger) expect(all).toContain(`ledger:${entry.key}`);
    // the Read call itself survives, its result became the digest
    expect(output.messages.some((m) => m.toolUses.some((t) => t.tool_use_id === 'u-read'))).toBe(true);
    // text messages keep their text
    expect(output.messages.map((m) => m.text)).toContain('Dispatched the research agent; PR 42 exists.');
  });

  it('keeps a short dropped result verbatim, with no ledger entry', async () => {
    const messages = [
      message('user', 'go'),
      call('u-1', 'Bash', { command: 'git status' }),
      result('u-1', 'nothing to commit'),
      message('assistant', 'done'),
    ];
    const output = await compact(messages, fakeJev((n) => (n.startsWith('call_') ? 0.9 : 0.1)), base);
    expect(output.ledger).toEqual([]);
    expect(textOf(output.messages)).toContain('nothing to commit');
  });
});

describe('ledger', () => {
  it('holds the full result, input, tool, error flag and the key the digest carries', async () => {
    const output = await compact(transcript(), dropAll, base);
    const read = output.ledger.find((e) => e.tool === 'Read')!;
    expect(read).toEqual<LedgerEntry>({
      key: ledgerKey('sess-1', 'u-read'),
      ts: '2026-10-18T07:00:00.000Z',
      session: 'sess-1',
      tool_use_id: 'u-read',
      tool: 'Read',
      input: { file_path: '/Users/me/projects/app/src/invoice.ts' },
      result: bigRead,
      isError: false,
    });
    expect(output.ledger.find((e) => e.tool === 'Bash')!.isError).toBe(true);
  });

  it('appends only new keys to <dir>/<session>.jsonl and never rewrites old lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ledger-'));
    const output = await compact(transcript(), dropAll, base);
    const first = appendLedger(dir, 'sess-1', output.ledger);
    expect(first).toEqual({ path: path.join(dir, 'sess-1.jsonl'), added: 3 });
    const before = fs.readFileSync(first.path, 'utf8');
    expect(appendLedger(dir, 'sess-1', output.ledger).added).toBe(0);
    const extra = { ...output.ledger[0]!, key: 'ffffffffffff' };
    expect(appendLedger(dir, 'sess-1', [extra]).added).toBe(1);
    const after = fs.readFileSync(first.path, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split('\n').map((l) => JSON.parse(l).key)).toHaveLength(4);
  });

  it('writes the same way through the engine fs', async () => {
    const files = new Map<string, string>([['/l/s.jsonl', '{"key":"old"}']]);
    const engineFs = {
      exists: async (p: string) => files.has(p),
      read: async (p: string) => files.get(p)!,
      write: async (p: string, t: string) => void files.set(p, t),
    };
    const entry = { key: 'new', ts: 't', session: 's', tool_use_id: 'u', tool: 'Bash', input: {}, result: 'r', isError: false };
    expect(await appendLedgerFs(engineFs, '/l/s.jsonl', [entry, { ...entry, key: 'old' }])).toBe(1);
    expect(files.get('/l/s.jsonl')!.split('\n')).toEqual(['{"key":"old"}', JSON.stringify(entry), '']);
  });
});

describe('preserveRecentHumanTurns', () => {
  function turns(n: number): Message[] {
    const messages: Message[] = [message('user', 'start')];
    for (let i = 1; i <= n; i++) {
      messages.push(call(`u-${i}`, 'Bash', { command: `step ${i}` }));
      messages.push(result(`u-${i}`, `output ${i}`));
      messages.push(message('assistant', `did ${i}`));
      messages.push(message('user', i % 2 ? `<task-notification>agent ${i} done</task-notification>` : `human ${i}`));
    }
    return messages;
  }

  it('counts user text without tool results, and not engine-written notices', () => {
    expect(isHumanTurn(message('user', 'please go'))).toBe(true);
    expect(isHumanTurn(message('user', '<task-notification>x</task-notification>'))).toBe(false);
    expect(isHumanTurn(message('user', `${NOTICE_PREFIX}now`))).toBe(false);
    expect(isHumanTurn(message('assistant', 'hi'))).toBe(false);
    expect(isHumanTurn(result('u', 'x'))).toBe(false);
  });

  it('finds the N-th most recent human turn, or the oldest when there are fewer', () => {
    const messages = turns(8); // human turns at i = 2, 4, 6, 8 plus 'start'
    expect(recentHumanTurns(messages, 2)).toEqual({ index: 4 * 6, count: 2 });
    expect(recentHumanTurns(messages, 10)).toEqual({ index: 0, count: 5 });
    expect(recentHumanTurns(messages, 0)).toEqual({ index: messages.length, count: 0 });
  });

  it('pins every call from that turn to the end, alongside preserveRecentMessages', async () => {
    const messages = turns(8);
    const asked: string[] = [];
    const jev: JevAsker = {
      async ask(_s, q) {
        asked.push(...Object.keys(q));
        return { answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.05 }])) };
      },
    };
    const output = await compact(messages, jev, { ...base, preserveRecentHumanTurns: 2 });
    // human 6 sits at index 24: steps 7 and 8 are pinned, steps 1-6 are candidates
    expect(output.stats.pinnedFromIndex).toBe(24);
    expect(output.stats.humanTurnsPinned).toBe(2);
    expect(asked.filter((k) => k.startsWith('call_'))).toHaveLength(6);
    const verbatim = output.messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.text));
    expect(verbatim).toEqual(['output 7', 'output 8']);
    // older pairs survive only as digests
    expect(textOf(output.messages)).toMatch(/^~Bash \| step 6 \| ok .*\n~ output 6$/m);
    // the wider window wins
    const wide = await compact(messages, jev, { ...base, preserveRecentHumanTurns: 1, preserveRecentMessages: 20 });
    expect(wide.stats.pinnedFromIndex).toBe(messages.length - 20);
  });

  it('is off by default in the library', async () => {
    const output = await compact(turns(4), fakeJev(() => 0.05), base);
    expect(output.stats.humanTurnsPinned).toBe(0);
    expect(output.stats.pinnedFromIndex).toBe(turns(4).length - 1);
  });
});

describe('post-compaction notice', () => {
  it('reads as three lines with the counts and the ledger path, no intent list', () => {
    const notice = compactionNotice({ ts: '2026-10-18T07:00:00.000Z', results: 3, humanTurns: 10, ledgerPath: '/h/l/s.jsonl' });
    expect(notice.split('\n')).toEqual([
      '<system-reminder>Compacted by Jev at 2026-10-18T07:00:00.000Z: 3 tool results → digests, 10 recent human turns kept verbatim,',
      'full results in /h/l/s.jsonl.',
      'Nothing above is verified until read back this turn.</system-reminder>',
    ]);
  });

  it('replaces an earlier notice instead of stacking them', () => {
    const messages = [message('user', 'go'), message('user', `${NOTICE_PREFIX}old`), message('assistant', 'ok')];
    const out = withNotice(messages, `${NOTICE_PREFIX}new`);
    expect(out.map((m) => m.text)).toEqual(['go', 'ok', `${NOTICE_PREFIX}new`]);
    expect(out.at(-1)!.role).toBe('user');
  });

  it('session.compact writes the ledger under HOME and ends the history with the notice', async () => {
    const handlers: Record<string, Function> = {};
    register(((event: string, handler: Function) => {
      handlers[event] = handler;
    }) as never, { apiKey: 'k', preserveRecentMessages: 1, preserveRecentHumanTurns: 1, minReductionRatio: 0 } as never);
    const files = new Map<string, string>();
    const logs: string[] = [];
    const $ = {
      http: {
        fetch: async (_url: string, init?: { body?: string }) => {
          const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
          const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0.05 }]));
          return { status: 200, ok: true, text: JSON.stringify({ answers }) };
        },
      },
      clock: { sleep: () => new Promise<void>(() => undefined), now: async () => Date.parse('2026-10-18T07:00:00Z') },
      session: { id: async () => 'sess-9' },
      fs: {
        exists: async (p: string) => files.has(p),
        read: async (p: string) => files.get(p)!,
        write: async (p: string, t: string) => void files.set(p, t),
      },
      ui: { log: (t: string) => logs.push(t), toast: () => undefined },
      env: { get: async (name: string) => (name === 'HOME' ? '/home/me' : undefined) },
      settings: { read: async () => ({}) },
    };
    const next = Object.assign(() => ({ fellBack: true }), { signal: new AbortController().signal });
    const out = await handlers['session.compact']($, { messages: transcript() }, next as never);
    const ledgerFile = '/home/me/.claude/state/compaction-ledger/sess-9.jsonl';
    expect(files.get(ledgerFile)!.trim().split('\n')).toHaveLength(3);
    const last = out.messages.at(-1);
    expect(last.role).toBe('user');
    expect(last.text).toBe(
      compactionNotice({ ts: '2026-10-18T07:00:00.000Z', results: 3, humanTurns: 1, ledgerPath: ledgerFile }),
    );
    expect(out.messages.map((m: Message) => m.text).join('\n')).toMatch(/agent:a6779c2b76fe06ebb/);
  });
});
