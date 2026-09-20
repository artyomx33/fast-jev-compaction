import { describe, expect, it } from 'vitest';
import {
  compact,
  guardRefuses,
  minSurvivingCandidates,
  questionsFor,
  resolveOptions,
  type JevAsker,
  type JevQuestions,
  type Message,
  type ToolCall,
} from '../src/index.js';
import { compactSession, register, resolveHookConfig } from '../hooks/fast-jev.ts';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

function transcript(): Message[] {
  return [
    message('user', 'Review the example module.'),
    call('tool-1', 'Read', { file_path: 'src/example/foo.ts' }, 'export const foo = 1;'),
    result('tool-1', 'export const foo = 1;'),
    call('tool-2', 'Bash', { command: 'example-cli check' }, 'checked 7 files'),
    result('tool-2', 'checked 7 files'),
    call('tool-3', 'Read', { file_path: 'src/example/bar.ts' }, 'export const bar = 2;'),
    result('tool-3', 'export const bar = 2;'),
    message('assistant', 'done looking'),
    message('user', 'continue'),
    message('assistant', 'continuing'),
  ];
}

/** 10 candidate calls followed by 3 messages that pin the newest calls. */
function wideTranscript(): Message[] {
  const messages: Message[] = [message('user', 'Review every example file.')];
  for (let i = 1; i <= 10; i++) {
    messages.push(call(`tool-${i}`, 'Read', { file_path: `src/example/f${i}.ts` }, `const f${i} = ${i};`));
    messages.push(result(`tool-${i}`, `const f${i} = ${i};`));
  }
  messages.push(call('tool-p1', 'Read', { file_path: 'src/example/p1.ts' }, 'pinned one'));
  messages.push(result('tool-p1', 'pinned one'));
  messages.push(call('tool-p2', 'Bash', { command: 'example-cli status' }, 'pinned two'));
  messages.push(result('tool-p2', 'pinned two'));
  messages.push(call('tool-p3', 'Read', { file_path: 'src/example/p3.ts' }, 'pinned three'));
  messages.push(result('tool-p3', 'pinned three'));
  return messages;
}

type Seen = { questions: string[]; instructions: string[] };

function fakeJev(answer: number, seen: Seen[] = []): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      seen.push({
        questions: Object.keys(questions),
        instructions: Object.values(questions).map((q) => q.instructions),
      });
      return {
        answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: answer }])),
      };
    },
  };
}

function jevFetch(answer: number) {
  return async (_url: string, init?: { body?: string }) => {
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    return {
      status: 200,
      ok: true,
      text: JSON.stringify({
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer }]),
        ),
      }),
    };
  };
}

describe('backward compatibility', () => {
  it('defaults reproduce upstream output and upstream question text', async () => {
    const options = resolveOptions();
    expect(options.maxDropRatio).toBe(1);
    expect(options.questionStyle).toBe('default');

    const seen: Seen[] = [];
    const output = await compact(transcript(), fakeJev(0.05, seen), { preserveRecentMessages: 1 });
    const explicit = await compact(transcript(), fakeJev(0.05), {
      preserveRecentMessages: 1,
      maxDropRatio: 1,
      questionStyle: 'default',
    });
    expect(output.messages).toEqual(explicit.messages);
    expect(output.compacted).toBe(true);
    expect(output.guard).toBeUndefined();
    expect(seen[0].instructions[0]).toMatch(/still matters for what the assistant does next/);
  });
});

describe('max-drop guard', () => {
  it('counts candidates only: 10 candidates, 3 pinned, 0 kept is refused', async () => {
    const messages = wideTranscript();
    const output = await compact(messages, fakeJev(0.05), {
      preserveRecentMessages: 6,
      maxDropRatio: 0.8,
    });
    expect(output.stats.pinned).toBe(3);
    expect(output.stats.kept).toBe(0);
    expect(output.decisions.filter((d) => d.reason !== 'pinned')).toHaveLength(10);
    expect(output.guard).toBe('max_drop');
    expect(output.compacted).toBe(false);
    expect(output.messages).toEqual(messages);
  });

  it('floors at three candidates and rounds the share up', () => {
    expect(minSurvivingCandidates(10, 0.8)).toBe(3);
    expect(minSurvivingCandidates(100, 0.8)).toBe(20);
    expect(minSurvivingCandidates(7, 0.9)).toBe(3);
    expect(minSurvivingCandidates(2, 0.8)).toBe(1);
    expect(guardRefuses(0, 0, 0.8)).toBe(false);
    expect(guardRefuses(0, 10, 1)).toBe(false);
  });

  it('refuses and returns the original messages unchanged', async () => {
    const messages = transcript();
    const output = await compact(messages, fakeJev(0.05), {
      preserveRecentMessages: 1,
      maxDropRatio: 0.8,
    });
    expect(output.guard).toBe('max_drop');
    expect(output.compacted).toBe(false);
    expect(output.messages).toEqual(messages);
    expect(output.stats.charsAfter).toBe(output.stats.charsBefore);
  });

  it('does not fire when enough candidates survive', async () => {
    const output = await compact(transcript(), fakeJev(0.95), {
      preserveRecentMessages: 1,
      maxDropRatio: 0.8,
    });
    expect(output.guard).toBeUndefined();
    expect(output.compacted).toBe(true);
    expect(output.stats.kept).toBeGreaterThan(0);
  });

  it('stays off when disabled, however much is dropped', async () => {
    const output = await compact(transcript(), fakeJev(0.05), {
      preserveRecentMessages: 1,
      maxDropRatio: 1,
    });
    expect(output.guard).toBeUndefined();
    expect(output.compacted).toBe(true);
    expect(output.stats.callsDropped).toBeGreaterThan(0);
  });
});

describe('questionStyle', () => {
  const toolCall: ToolCall = {
    id: 't1',
    tool_use_id: 'tool-1',
    tool: 'Read',
    input: { file_path: 'src/example/foo.ts' },
    callIndex: 1,
    resultIndex: 2,
    resultChars: 21,
    isError: false,
    pinned: false,
  };

  it('asks the evidence questions when selected', () => {
    const questions = questionsFor(toolCall, 'evidence');
    expect(questions.call_t1.instructions).toMatch(/to trust or reproduce a later claim/);
    expect(questions.result_t1.instructions).toMatch(/costly to re-derive/);
  });

  it('reaches Jev through compact', async () => {
    const seen: Seen[] = [];
    await compact(transcript(), fakeJev(0.05, seen), {
      preserveRecentMessages: 1,
      maxDropRatio: 1,
      questionStyle: 'evidence',
    });
    expect(seen[0].instructions.join(' ')).toMatch(/costly to re-derive/);
  });
});

describe('hook wiring', () => {
  it('passes questionStyle and maxDropRatio from userConfig to the library', async () => {
    const config = resolveHookConfig({ questionStyle: 'evidence', maxDropRatio: 0.8 });
    expect(config.questionStyle).toBe('evidence');
    expect(config.maxDropRatio).toBe(0.8);

    const bodies: string[] = [];
    await compactSession(transcript(), { ...config, apiKey: 'k', model: 'jev-x', preserveRecentMessages: 1 }, async (url, init) => {
      bodies.push(init?.body ?? '');
      return jevFetch(0.95)(url, init);
    });
    expect(bodies.join(' ')).toMatch(/costly to re-derive/);
  });

  it('leaves both unset when userConfig does not mention them', () => {
    const config = resolveHookConfig({});
    expect(config.questionStyle).toBeUndefined();
    expect(config.maxDropRatio).toBeUndefined();
  });

  it('does not replace the compaction when the guard refused, even at minReductionRatio 0', async () => {
    const handlers: Record<string, Function> = {};
    const on = (event: string, handler: Function) => {
      handlers[event] = handler;
    };
    register(on as never, { apiKey: 'k', maxDropRatio: 0.8, minReductionRatio: 0, preserveRecentMessages: 1 } as never);

    const logs: string[] = [];
    const $ = {
      http: { fetch: async (url: string, init?: { body?: string }) => jevFetch(0.05)(url, init) },
      ui: { log: (t: string) => logs.push(t), toast: (t: string) => logs.push(t) },
      env: { get: async () => undefined },
      settings: { read: async () => ({}) },
    };
    const event = { messages: transcript() };
    const next = (passed: unknown) => ({ nextCalledWith: passed });

    const outcome = await handlers['session.compact']($, event, next as never);

    // the native compaction runs: the handler hands the event to next(), it does
    // not return a { messages } replacement
    expect(outcome).toEqual({ nextCalledWith: event });
    expect(logs.join(' ')).toMatch(/max-drop guard refused/);
  });

  it('reports a refused compaction as not compacted, whatever minReductionRatio says', async () => {
    const messages = transcript();
    const { result: output, messages: session } = await compactSession(
      messages,
      { ...resolveHookConfig({ maxDropRatio: 0.8, minReductionRatio: 0 }), apiKey: 'k', preserveRecentMessages: 1 },
      jevFetch(0.05),
    );
    expect(output.compacted).toBe(false);
    expect(output.guard).toBe('max_drop');
    // the hook branches on result.compacted before it ever looks at the ratio
    expect(session).toHaveLength(messages.length);
    expect(output.stats.charsAfter).toBe(output.stats.charsBefore);
  });
});
