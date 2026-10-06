// Pure game logic: no DOM, no fetch. Ports 1:1 to C# later.
//
// A transmission is a grid "dump" (tx.stream, tx.cols wide). The real message is a sequence of code keys
// hidden in it (tx.cipher, at tx.cells). The player finds keys from the code table in the dump
// (a "pick" = two adjacent cells spelling a table key), and the radio answers Fallout-style
// with a Likeness count. Once the keys are right, ambiguous keys are resolved by context.

export const ORDERS = ['continue', 'wait', 'back', 'hurry', 'base'];
export const MAX_INTUITION = 5;
export const MAX_TRIES = 5;

export function entryFor(tx, key) {
  return tx.table.find((e) => e.key === key) ?? null;
}

// --- Phase 1: finding keys in the dump ---

// The dump is a grid (tx.cols wide). A key is a pair of orthogonally adjacent cells holding a row
// digit and a column letter of the code table, in either order, horizontally or vertically.
// A pick is {a, b}: the two cell indices.

export function areAdjacent(tx, a, b) {
  const d = Math.abs(a - b);
  if (d === tx.cols) return true;
  return d === 1 && Math.floor(a / tx.cols) === Math.floor(b / tx.cols);
}

/** The table entry a pair of cells spells (row digit + column letter, either order), or null. */
export function keyOfCells(tx, a, b) {
  if (a === b || !areAdjacent(tx, a, b)) return null;
  const ca = tx.stream[a];
  const cb = tx.stream[b];
  return entryFor(tx, ca + cb) ?? entryFor(tx, cb + ca);
}

/** Every pair of adjacent cells that spells a table key. */
export function findOccurrences(tx) {
  const out = [];
  const n = tx.stream.length;
  for (let i = 0; i < n; i++) {
    for (const j of [i + 1, i + tx.cols]) {
      if (j >= n) continue;
      const e = keyOfCells(tx, i, j);
      if (e) out.push({ key: e.key, a: i, b: j });
    }
  }
  return out;
}

export function overlaps(p, q) {
  return p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b;
}

/** Picks ordered by their first cell in reading order. */
export function sortPicks(picks) {
  return [...picks].sort((p, q) => Math.min(p.a, p.b) - Math.min(q.a, q.b));
}

/** Do the picks, in reading order, form the message grammar (tx.slots)? */
export function parses(tx, picks) {
  const sorted = sortPicks(picks);
  if (sorted.length !== tx.slots.length) return false;
  return sorted.every((p, i) => keyOfCells(tx, p.a, p.b)?.type === tx.slots[i]);
}

/** The keys picked, in reading order. */
export function pickedKeys(tx, picks) {
  return sortPicks(picks).map((p) => keyOfCells(tx, p.a, p.b).key);
}

/** The real pair of cells of message key `i`. */
export function realPick(tx, i) {
  return { a: tx.cells[i][0], b: tx.cells[i][1] };
}

export function samePick(p, q) {
  return (p.a === q.a && p.b === q.b) || (p.a === q.b && p.b === q.a);
}

/** Fallout "Likeness": how many picks are exactly a real key's pair of cells. */
export function likeness(tx, picks) {
  return picks.filter((p) => tx.cipher.some((_, i) => samePick(p, realPick(tx, i)))).length;
}

export function isLocked(tx, picks) {
  return picks.length === tx.cipher.length && likeness(tx, picks) === tx.cipher.length;
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
