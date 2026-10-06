// Pure game logic: no DOM, no fetch. Ports 1:1 to C# later.
//
// A transmission is a continuous "dump" (tx.stream). The real message is a sequence of code keys
// hidden in it (tx.cipher, at tx.positions). The player finds keys from the code table in the dump
// (a "pick" = a span of the stream that equals a table key), and the radio answers Fallout-style
// with a Likeness count. Once the keys are right, ambiguous keys are resolved by context.

export const ORDERS = ['continue', 'wait', 'back', 'hurry', 'base'];
export const MAX_INTUITION = 5;
export const MAX_TRIES = 5;

export function entryFor(tx, key) {
  return tx.table.find((e) => e.key === key) ?? null;
}

// --- Phase 1: finding keys in the dump ---

/** Every place in the dump where a table key appears (overlaps allowed). */
export function findOccurrences(tx) {
  const out = [];
  for (const { key } of tx.table) {
    for (let i = tx.stream.indexOf(key); i !== -1; i = tx.stream.indexOf(key, i + 1)) {
      out.push({ key, start: i, end: i + key.length });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The table entry a span of the dump spells, or null if it is not a code key. */
export function keyAtSpan(tx, start, end) {
  return entryFor(tx, tx.stream.slice(start, end));
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** Picks are {start, end} spans. Returns them ordered by position in the dump. */
export function sortPicks(picks) {
  return [...picks].sort((a, b) => a.start - b.start);
}

/** Do the picks, in stream order, form the message grammar (tx.slots)? */
export function parses(tx, picks) {
  const sorted = sortPicks(picks);
  if (sorted.length !== tx.slots.length) return false;
  return sorted.every((p, i) => keyAtSpan(tx, p.start, p.end)?.type === tx.slots[i]);
}

/** The keys picked, in stream order. */
export function pickedKeys(tx, picks) {
  return sortPicks(picks).map((p) => tx.stream.slice(p.start, p.end));
}

/** Fallout "Likeness": how many picks are exactly a real key at its real position. */
export function likeness(tx, picks) {
  return picks.filter((p) => tx.positions.some((pos, i) => pos === p.start && tx.cipher[i].length === p.end - p.start)).length;
}

export function isLocked(tx, picks) {
  return picks.length === tx.cipher.length && likeness(tx, picks) === tx.cipher.length;
}

/** The real span of message key `i`. */
export function realSpan(tx, i) {
  return { start: tx.positions[i], end: tx.positions[i] + tx.cipher[i].length };
}

// --- Phase 2: reading the message ---

/** Ambiguity of the key the player ended up with at message index `i`. */
export function isAmbiguous(tx, i, keys = null) {
  return entryFor(tx, keys?.[i] ?? tx.cipher[i]).meanings.length > 1;
}

/**
 * selection: { [messageIndex]: string[] } chosen words per key.
 * Returns 'incomplete' | 'correct' | 'hedged' | 'wrong'.
 * `keys` are the keys the player found (defaults to the true ones).
 */
export function judgeReading(tx, selection, keys = null) {
  let hedged = false;
  for (let i = 0; i < tx.cipher.length; i++) {
    const chosen = selection[i] ?? [];
    if (chosen.length === 0) return 'incomplete';
    const key = keys?.[i] ?? tx.cipher[i];
    const meanings = entryFor(tx, key).meanings;
    if (!chosen.every((w) => meanings.includes(w))) return 'wrong';
    if (key !== tx.cipher[i]) return 'wrong'; // misread signal
    const truth = tx.truth[i];
    if (truth === undefined) continue; // unambiguous key
    if (!chosen.includes(truth)) return 'wrong';
    if (chosen.length > 1) hedged = true;
  }
  return hedged ? 'hedged' : 'correct';
}

/** Render the decoded sentence(s). Hedged keys render as "a / b". */
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
export function resolve(tx, selection, order, keys = null) {
  const reading = judgeReading(tx, selection, keys);
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
