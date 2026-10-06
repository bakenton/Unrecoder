// Pure game logic: no DOM, no fetch. Ports 1:1 to C# later.

export const ORDERS = ['continue', 'wait', 'back', 'hurry', 'base'];
export const MAX_INTUITION = 5;

/** Candidate words for one cipher symbol, from the transmission's code table. */
export function entryFor(tx, symbol) {
  return tx.table.find((e) => e.symbol === symbol) ?? null;
}

export function isAmbiguous(tx, index) {
  return entryFor(tx, tx.cipher[index]).meanings.length > 1;
}

/**
 * selection: { [cipherIndex]: string[] } chosen words per reel.
 * Returns 'incomplete' | 'correct' | 'hedged' | 'wrong'.
 * Unambiguous reels must hold their single meaning; truth only lists ambiguous reels.
 */
export function judgeReading(tx, selection) {
  let hedged = false;
  for (let i = 0; i < tx.cipher.length; i++) {
    const chosen = selection[i] ?? [];
    if (chosen.length === 0) return 'incomplete';
    const meanings = entryFor(tx, tx.cipher[i]).meanings;
    if (!chosen.every((w) => meanings.includes(w))) return 'wrong';
    const truth = tx.truth[i];
    if (truth === undefined) {
      // Unambiguous reel: any selection from its single meaning is right.
      continue;
    }
    if (!chosen.includes(truth)) return 'wrong';
    if (chosen.length > 1) hedged = true;
  }
  return hedged ? 'hedged' : 'correct';
}

/** Render the decoded sentence(s). Hedged reels render as "a / b". */
export function renderSentence(tx, selection) {
  return tx.clauses
    .map((clause) => {
      const text = clause.pattern.replace(/\{(\d+)\}/g, (_, n) => {
        const words = selection[Number(n)] ?? [];
        return words.length ? words.join(' / ') : '___';
      });
      return text.charAt(0).toUpperCase() + text.slice(1);
    })
    .join(' ');
}

/**
 * Resolve the player's reading + order into the next transmission.
 * The world outcome depends on truth x order. Reading affects feedback and Intuition:
 *  - correct reading, no harm  -> +1 Intuition
 *  - hedged (contains truth)   -> harm softened to a near miss, no Intuition
 *  - wrong reading             -> full outcome, no Intuition
 */
export function resolve(tx, selection, order) {
  const reading = judgeReading(tx, selection);
  if (reading === 'incomplete') throw new Error('Reading is incomplete');
  const outcome = tx.outcomes[order];
  if (!outcome) throw new Error(`Unknown order: ${order}`);

  const softened = reading === 'hedged' && outcome.severity === 'harm';
  const text = softened ? outcome.nearMiss : outcome.text;
  const crew = softened ? [] : outcome.crew;
  const harmed = !softened && outcome.severity === 'harm';
  const intuitionGain = reading === 'correct' && !harmed ? 1 : 0;

  return { reading, order, severity: softened ? 'delay' : outcome.severity, text, crew, intuitionGain };
}

export function applyCrew(crew, changes) {
  return crew.map((m) => {
    const c = changes.find((x) => x.id === m.id);
    return c ? { ...m, status: c.status, note: c.note ?? m.note } : m;
  });
}

export function spendIntuition(points, cost = 1) {
  if (points < cost) return null;
  return points - cost;
}

export function gainIntuition(points, gain) {
  return Math.min(MAX_INTUITION, points + gain);
}
