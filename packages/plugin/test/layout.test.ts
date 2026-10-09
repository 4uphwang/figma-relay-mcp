import { describe, expect, it } from 'vitest';
import { COLUMNS, GAP, gridPosition } from '../src/lib/layout';

describe('gridPosition', () => {
  const size = { width: 100, height: 50 };
  const origin = { x: 1000, y: 0 };
  it('fills a row of 5 then wraps', () => {
    expect(COLUMNS).toBe(5);
    expect(GAP).toBe(40);
    expect(gridPosition(0, origin, size)).toEqual({ x: 1000, y: 0 });
    expect(gridPosition(4, origin, size)).toEqual({ x: 1000 + 4 * 140, y: 0 });
    expect(gridPosition(5, origin, size)).toEqual({ x: 1000, y: 90 });
    expect(gridPosition(7, origin, size)).toEqual({ x: 1280, y: 90 });
  });
});
