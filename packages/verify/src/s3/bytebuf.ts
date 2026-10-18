/**
 * Byte builders that do not spread: `out.push(...bytes)` passes every byte as an argument and fails with a RangeError once a record (a root
 * proof of thousands of elements, a transaction of kilobytes) is large enough, which would turn a document Go accepts into a TypeError here.
 */
export function app(out: number[], ...parts: ArrayLike<number>[]): void {
  for (const p of parts) for (let i = 0; i < p.length; i++) out.push(p[i]!);
}

export function cat(...parts: ArrayLike<number>[]): number[] {
  const out: number[] = [];
  app(out, ...parts);
  return out;
}
