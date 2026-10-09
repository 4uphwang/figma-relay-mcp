export const GAP = 40;
export const COLUMNS = 5;

export function gridPosition(
  index: number,
  origin: { x: number; y: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const col = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  return { x: origin.x + col * (size.width + GAP), y: origin.y + row * (size.height + GAP) };
}
