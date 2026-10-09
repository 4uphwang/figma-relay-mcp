import { describe, expect, it } from 'vitest';
import { keyOf, planCell, unknownKeys } from '../src/lib/template';

describe('keyOf', () => {
  it('reads {{key}} names, tolerating inner spaces', () => {
    expect(keyOf('{{name}}')).toBe('name');
    expect(keyOf('{{ 회사 }}')).toBe('회사');
  });
  it('ignores other names', () => {
    expect(keyOf('name')).toBeNull();
    expect(keyOf('Title {{name}}')).toBeNull();
    expect(keyOf('{{}}')).toBeNull();
  });
});

describe('planCell', () => {
  it('text layers take strings, numbers, booleans; null clears', () => {
    expect(planCell('text', '홍길동')).toEqual({ kind: 'text', text: '홍길동' });
    expect(planCell('text', 3)).toEqual({ kind: 'text', text: '3' });
    expect(planCell('text', false)).toEqual({ kind: 'text', text: 'false' });
    expect(planCell('text', null)).toEqual({ kind: 'text', text: '' });
  });
  it('text layers show the source of image-like values', () => {
    expect(planCell('text', { asset: 0, src: 'https://x/a.png' })).toEqual({ kind: 'text', text: 'https://x/a.png' });
    expect(planCell('text', { imageError: 'HTTP 404', src: '/a.png' })).toEqual({ kind: 'text', text: '/a.png' });
  });
  it('shape layers take assets', () => {
    expect(planCell('shape', { asset: 2, src: 's' })).toEqual({ kind: 'image', asset: 2 });
    expect(planCell('shape', { imageError: 'HTTP 404', src: 's' })).toEqual({ kind: 'warn', code: 'IMAGE_FAILED', detail: 'HTTP 404' });
    expect(planCell('shape', null)).toEqual({ kind: 'skip' });
    expect(planCell('shape', 'plain')).toMatchObject({ kind: 'warn', code: 'NOT_FILLABLE' });
  });
  it('missing values and unsupported layers warn', () => {
    expect(planCell('text', undefined)).toEqual({ kind: 'warn', code: 'MISSING_VALUE' });
    expect(planCell('other', 'x')).toMatchObject({ kind: 'warn', code: 'NOT_FILLABLE' });
  });
});

describe('unknownKeys', () => {
  it('lists row keys with no matching layer', () => {
    expect(unknownKeys({ name: 'a', extra: 1 }, new Set(['name']))).toEqual(['extra']);
  });
});
