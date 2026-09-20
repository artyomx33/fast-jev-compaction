import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  beginGeneration,
  buildAdditionalContext,
  claimGeneration,
  finishGeneration,
  scoreEvidence,
  type PendingReceipt,
} from '../src/codex/carryover.js';
import type { EvidenceCandidate, TranscriptIdentity } from '../src/codex/transcript.js';

const uuids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
];

function candidate(index: number, result = `result-${index}`): EvidenceCandidate {
  return {
    id: `c${index}`,
    callId: `call-${index}`,
    tool: 'exec',
    input: `input-${index}`,
    result,
    sourceLine: index * 10,
    clipped: { input: false, result: false },
  };
}

const identity: TranscriptIdentity = {
  sessionId: 'session',
  cwd: '/cwd',
  transcriptPath: '/cwd/transcript.jsonl',
};

const receipt: PendingReceipt = {
  candidates: 1,
  eligible: 1,
  selected: 1,
  requests: 1,
  excluded: { bootstrap: 0, credential: 0, memory: 0, malformed: 0, unpaired: 0 },
  clipped: 0,
  durationMs: 2,
  transcriptHash: 'abc',
};

describe('Jev evidence scoring', () => {
  it('shows Jev the actual excerpt and names each target in its question', async () => {
    const candidates = Array.from({ length: 9 }, (_, index) => candidate(index + 1));
    const calls: Array<{ state: unknown; questions: Record<string, { instructions: string }> }> = [];
    const result = await scoreEvidence(candidates, 'repair the lease', {
      async ask(state, questions) {
        calls.push({ state, questions: questions as Record<string, { instructions: string }> });
        return {
          answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { noul: id === 'c9' ? 0.9 : 0.1 }])),
        };
      },
    });

    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0]!.state)).toContain('result-1');
    expect(calls[0]!.questions.c1!.instructions).toContain('Candidate c1');
    expect(calls[0]!.questions.c1!.instructions).toContain('call-1');
    expect(result.selected.map((item) => item.id)).toEqual(['c9']);
  });

  it.each([
    ['missing', {}],
    ['unknown', { c1: { noul: 0.5 }, surprise: { noul: 0.4 } }],
    ['negative', { c1: { noul: -0.1 } }],
    ['large', { c1: { noul: 1.1 } }],
    ['nan', { c1: { noul: Number.NaN } }],
  ])('rejects %s Jev answers', async (_name, answers) => {
    await expect(scoreEvidence([candidate(1)], 'task', {
      async ask() { return { answers }; },
    })).rejects.toMatchObject({ code: expect.stringMatching(/^JEV_ANSWER_/) });
  });

  it('checks cancellation after the final response', async () => {
    const controller = new AbortController();
    await expect(scoreEvidence([candidate(1)], 'task', {
      async ask() {
        controller.abort();
        return { answers: { c1: { noul: 1 } } };
      },
    }, { signal: controller.signal })).rejects.toMatchObject({ code: 'DEADLINE' });
  });

  it('fits only whole JSON excerpts in the Unicode-aware output budget', () => {
    const big = { ...candidate(1, '🙂'.repeat(500)), score: 1 };
    const small = { ...candidate(2, 'slot Q7'), score: 0.9 };
    const built = buildAdditionalContext([big, small], 500);
    expect(Array.from(built.context).length).toBeLessThanOrEqual(500);
    expect(built.context).not.toContain('🙂');
    expect(built.context).toContain('slot Q7');
    expect(built.delivered).toBe(1);
  });
});

describe('pending generation lifecycle', () => {
  it('scopes state by full identity and consumes a ready generation once', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jev-state-'));
    const handle = await beginGeneration(stateDir, identity, 1_000, () => uuids[0]!);
    await finishGeneration(handle, { status: 'ready', context: 'quoted evidence', receipt });
    expect((await stat(handle.scopeDir)).mode & 0o777).toBe(0o700);
    expect((await stat(handle.generationPath)).mode & 0o777).toBe(0o600);

    await expect(claimGeneration(stateDir, identity, 1_001, undefined, () => uuids[1]!)).resolves.toMatchObject({
      outcome: 'ready', context: 'quoted evidence',
    });
    await expect(readFile(join(handle.scopeDir, 'status.json'), 'utf8').then(JSON.parse)).resolves.toMatchObject({
      outcome: 'consumed', eligible: 1, selected: 1, requests: 1, durationMs: 2, transcriptHash: 'abc',
    });
    await expect(claimGeneration(stateDir, identity, 1_002, undefined, () => uuids[2]!)).resolves.toEqual({ outcome: 'none' });
    await expect(claimGeneration(
      stateDir,
      { ...identity, sessionId: 'different' },
      1_003,
      undefined,
      () => uuids[3]!,
    )).resolves.toEqual({ outcome: 'none' });
    await expect(claimGeneration(
      stateDir,
      { ...identity, cwd: '/different' },
      1_003,
      undefined,
      () => uuids[4]!,
    )).resolves.toEqual({ outcome: 'none' });
    await expect(claimGeneration(
      stateDir,
      { ...identity, transcriptPath: '/different.jsonl' },
      1_003,
      undefined,
      () => '00000000-0000-4000-8000-000000000007',
    )).resolves.toEqual({ outcome: 'none' });
  });

  it('does not let a late old writer replace the current generation', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jev-state-'));
    const old = await beginGeneration(stateDir, identity, 1_000, () => uuids[0]!);
    const current = await beginGeneration(stateDir, identity, 1_001, () => uuids[1]!);
    await finishGeneration(old, { status: 'ready', context: 'stale evidence', receipt });

    await expect(claimGeneration(stateDir, identity, 1_002, undefined, () => uuids[2]!)).resolves.toMatchObject({
      outcome: 'skip', code: 'STATE_NOT_READY', generation: current.pointer.generation,
    });
    await finishGeneration(current, { status: 'ready', context: 'late current evidence', receipt });
    await expect(claimGeneration(stateDir, identity, 1_003, undefined, () => uuids[3]!)).resolves.toEqual({ outcome: 'none' });
  });

  it('expires old state and rejects tampered identities, path components, and oversized payloads', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jev-state-'));
    const expired = await beginGeneration(stateDir, identity, 1_000, () => uuids[0]!);
    await finishGeneration(expired, { status: 'ready', context: 'old', receipt });
    await expect(claimGeneration(stateDir, identity, 1_000 + 30 * 60 * 1_000 + 1, undefined, () => uuids[1]!)).resolves.toMatchObject({
      outcome: 'skip', code: 'STATE_EXPIRED',
    });

    await expect(beginGeneration(stateDir, identity, 2_000, () => '../escape')).rejects.toMatchObject({ code: 'STATE_IO' });

    const tampered = await beginGeneration(stateDir, identity, 3_000, () => uuids[2]!);
    const currentPath = join(tampered.scopeDir, 'current.json');
    const pointer = JSON.parse(await readFile(currentPath, 'utf8')) as Record<string, unknown>;
    await writeFile(currentPath, JSON.stringify({ ...pointer, identity: { ...identity, cwd: '/other' } }));
    await expect(claimGeneration(stateDir, identity, 3_001, undefined, () => uuids[3]!)).resolves.toMatchObject({
      outcome: 'skip', code: 'STATE_IDENTITY',
    });

    const oversized = await beginGeneration(stateDir, identity, 4_000, () => uuids[4]!);
    await writeFile(oversized.generationPath, 'x'.repeat(70 * 1024));
    await expect(claimGeneration(
      stateDir, identity, 4_001, undefined,
      () => '00000000-0000-4000-8000-000000000006',
    )).resolves.toMatchObject({ outcome: 'skip', code: 'STATE_PAYLOAD' });
  });

  it('does not reflect arbitrary error text loaded from pending state', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'jev-state-'));
    const handle = await beginGeneration(stateDir, identity, 1_000, () => uuids[0]!);
    await writeFile(handle.generationPath, JSON.stringify({
      ...handle.pointer,
      status: 'error',
      code: 'SECRET_REMOTE_BODY',
    }));
    await expect(claimGeneration(stateDir, identity, 1_001, undefined, () => uuids[1]!)).resolves.toMatchObject({
      outcome: 'skip', code: 'STATE_PAYLOAD',
    });
  });
});
