import { describe, expect, it } from 'vitest';
import { toJsonSafe } from '../src/lib/serialize';

const fakeNode = (id: string) => ({ id, name: `n${id}`, type: 'FRAME', remove() {}, secret: 'x' });

describe('toJsonSafe', () => {
  it('passes plain JSON through', () => {
    expect(toJsonSafe({ a: [1, 'b', null, true] })).toEqual({ a: [1, 'b', null, true] });
  });
  it('turns nodes into {id, name, type}, also nested', () => {
    expect(toJsonSafe(fakeNode('1'))).toEqual({ id: '1', name: 'n1', type: 'FRAME' });
    expect(toJsonSafe({ list: [fakeNode('2')] })).toEqual({ list: [{ id: '2', name: 'n2', type: 'FRAME' }] });
  });
  it('maps undefined to null', () => {
    expect(toJsonSafe(undefined)).toBeNull();
  });
});
