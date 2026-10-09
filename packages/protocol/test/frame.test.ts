import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame } from '../src';

describe('binary frame', () => {
  it('round-trips header and payload', () => {
    const payload = new Uint8Array([0, 1, 2, 255]);
    const frame = encodeFrame({ id: 'req-1', part: 3 }, payload);
    const { header, payload: out } = decodeFrame(frame);
    expect(header).toEqual({ id: 'req-1', part: 3 });
    expect([...out]).toEqual([0, 1, 2, 255]);
  });

  it('decodes a frame that is a view into a larger buffer', () => {
    const frame = encodeFrame({ id: 'x', part: 0 }, new Uint8Array([9, 9]));
    const big = new Uint8Array(frame.length + 10);
    big.set(frame, 10);
    const { header, payload } = decodeFrame(big.subarray(10));
    expect(header.id).toBe('x');
    expect([...payload]).toEqual([9, 9]);
  });

  it('handles an empty payload', () => {
    const { payload } = decodeFrame(encodeFrame({ id: 'e', part: 0 }, new Uint8Array()));
    expect(payload.length).toBe(0);
  });

  it('rejects a malformed header', () => {
    const head = new TextEncoder().encode('{"id":1}');
    const bad = new Uint8Array(4 + head.length);
    new DataView(bad.buffer).setUint32(0, head.length);
    bad.set(head, 4);
    expect(() => decodeFrame(bad)).toThrow();
  });
});
