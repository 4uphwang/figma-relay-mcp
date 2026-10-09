function isNodeLike(v: unknown): v is { id: string; name: string; type: string } {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.type === 'string' && typeof o.remove === 'function';
}

// execute 반환값을 JSON으로 보낼 수 있게 만든다. 노드는 {id, name, type}으로 줄인다.
export function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  const text = JSON.stringify(value, (_key, v) => (isNodeLike(v) ? { id: v.id, name: v.name, type: v.type } : v));
  return text === undefined ? null : JSON.parse(text);
}
