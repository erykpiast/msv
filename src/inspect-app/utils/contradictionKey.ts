// Mirror of src/forum.js#contradictionKey — keep the two in sync.
// Forum-contradictions verdicts are keyed by sorted `<claim_id_a>|<claim_id_b>`.
export function contradictionKey(claimA: string, claimB: string): string {
  return claimA < claimB ? `${claimA}|${claimB}` : `${claimB}|${claimA}`;
}

export function parseContradictionKey(key: string): [string, string] {
  const idx = key.indexOf('|');
  if (idx < 0) return [key, ''];
  return [key.slice(0, idx), key.slice(idx + 1)];
}
