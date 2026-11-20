// Only deterministic file-format errors can be quarantined until the file changes.
// The same bytes may still succeed after an I/O error or a temporarily unavailable store.
export class InvalidCapacityDrain extends Error {}

export function parseCapacityDrain(raw) {
  let delta;
  try { delta = JSON.parse(raw); }
  catch { throw new InvalidCapacityDrain('Invalid drain JSON'); }
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new InvalidCapacityDrain('Invalid capacity drain');
  return delta;
}
