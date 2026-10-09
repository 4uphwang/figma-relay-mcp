import { z } from 'zod';

const BinaryHeaderSchema = z.object({ id: z.string(), part: z.number().int().nonnegative() });
export type BinaryHeader = z.infer<typeof BinaryHeaderSchema>;

// 프레임 = [u32 BE 헤더 길이][헤더 JSON UTF-8][payload]
export function encodeFrame(header: BinaryHeader, payload: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + payload.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(payload, 4 + head.length);
  return out;
}

export function decodeFrame(data: Uint8Array): { header: BinaryHeader; payload: Uint8Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = view.getUint32(0);
  const header = BinaryHeaderSchema.parse(JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + len))));
  return { header, payload: data.subarray(4 + len) };
}
