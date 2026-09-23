import { describe, expect, it } from 'vitest';
import { sliceOnCodePoints, truncate } from '../src/state.js';

const WELL_FORMED = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('surrogate-safe truncation', () => {
  it('never leaves a lone surrogate when the cut lands inside an emoji', () => {
    const text = 'abc🟢def';
    for (let i = 0; i <= text.length; i++) {
      expect(WELL_FORMED(sliceOnCodePoints(text, 0, i))).toBe(true);
      expect(WELL_FORMED(sliceOnCodePoints(text, i))).toBe(true);
    }
    expect(sliceOnCodePoints(text, 0, 4)).toBe('abc');
    expect(sliceOnCodePoints(text, 4)).toBe('🟢def');
  });
  it('truncate keeps the ellipsis and stays well-formed', () => {
    const text = 'x'.repeat(10) + '🟢🟡🔴' + 'y'.repeat(10);
    for (let limit = 1; limit < text.length; limit++) expect(WELL_FORMED(truncate(text, limit))).toBe(true);
  });
  it('is a plain slice on ordinary text', () => {
    expect(sliceOnCodePoints('hello world', 0, 5)).toBe('hello');
    expect(sliceOnCodePoints('hello world', 6)).toBe('world');
  });
});
