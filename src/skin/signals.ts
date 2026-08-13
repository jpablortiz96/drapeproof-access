export function absoluteDelta(original: number, comparison: number): number {
  if (!Number.isFinite(original) || !Number.isFinite(comparison)) {
    throw new Error("Signal delta inputs must be finite.");
  }
  return Math.abs(original - comparison);
}
