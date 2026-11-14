// Two-key sequences such as "g p". The first key still runs its own shortcut; if the second key follows
// within `timeout` ms, the sequence runs instead of the second key's shortcut.
export function makeChords(seqs, { timeout = 1000, now = () => Date.now() } = {}) {
  let prev = null, at = 0;
  return key => {
    if (key === 'Shift') return null;   // typing a capital letter should not break a sequence
    const hit = prev !== null && now() - at <= timeout ? seqs[`${prev} ${key}`] || null : null;
    prev = hit ? null : key; at = now();
    return hit;
  };
}
