import { describe, expect, it } from 'vitest';
import { nextDelay } from '../src/lib/backoff';

describe('nextDelay', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(nextDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});
