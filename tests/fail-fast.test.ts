import { describe, expect, it } from 'vitest';
import { failFast, type HookFetchResponse } from '../hooks/fast-jev.ts';

const ok: HookFetchResponse = { status: 200, ok: true, text: '{"answers":{}}' };
const hang = () => new Promise<HookFetchResponse>(() => {});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const after = (ms: number, value: HookFetchResponse) =>
  new Promise<HookFetchResponse>((resolve) => setTimeout(() => resolve(value), ms));

describe('failFast', () => {
  it('passes a fast answer through untouched', async () => {
    let calls = 0;
    const fetchFn = failFast(async () => (calls++, ok), sleep, { timeoutMs: 50, retries: 1 });
    await expect(fetchFn('u')).resolves.toEqual(ok);
    expect(calls).toBe(1);
  });

  it('retries once after a timeout, then succeeds', async () => {
    let calls = 0;
    const fetchFn = failFast(async () => (calls++ === 0 ? hang() : ok), sleep, { timeoutMs: 20, retries: 1 });
    await expect(fetchFn('u')).resolves.toEqual(ok);
    expect(calls).toBe(2);
  });

  it('gives up after the retry with a timeout error', async () => {
    let calls = 0;
    const fetchFn = failFast(() => (calls++, hang()), sleep, { timeoutMs: 20, retries: 1 });
    const started = Date.now();
    await expect(fetchFn('u')).rejects.toThrow(/timed out after 20 ms \(after 2 attempts\)/);
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('retries a 5xx but not a 4xx', async () => {
    let calls = 0;
    const five = failFast(async () => (calls++ === 0 ? { status: 520, ok: false, text: 'origin' } : ok), sleep, { timeoutMs: 50, retries: 1 });
    await expect(five('u')).resolves.toEqual(ok);
    expect(calls).toBe(2);
    calls = 0;
    const four = failFast(async () => (calls++, { status: 400, ok: false, text: 'bad' }), sleep, { timeoutMs: 50, retries: 1 });
    await expect(four('u')).resolves.toMatchObject({ status: 400 });
    expect(calls).toBe(1);
  });

  it('does not treat a slow-but-in-time answer as a timeout', async () => {
    const fetchFn = failFast(() => after(10, ok), sleep, { timeoutMs: 50, retries: 0 });
    await expect(fetchFn('u')).resolves.toEqual(ok);
  });
});
