// Pure game logic: no DOM, no fetch. Ports 1:1 to C# later.
//
// The code table is a fixed 10x10 matrix (like the real duty-radio-operator table): row digits 0-9,
// column letters a-j. Every cell holds a phrase, a letter, or a service marker, and its position can
// also be read as a number (row digit + column index, so "0g" is 06).
//
// A transmission is a grid "dump" of single characters. A key is a digit touching a letter a-j
// (side by side or stacked, either order), which names a cell. The real message is a sequence of keys
// hidden in the dump; the radio answers Fallout-style with a Likeness count. Once the keys are right,
// ambiguous phrases are resolved by context.

export const ORDERS = ['continue', 'wait', 'back', 'hurry', 'base'];
export const MAX_INTUITION = 5;
export const MAX_TRIES = 5;

/** A transmission with the shared matrix attached. */
export function prepare(act, index) {
  return { ...act.transmissions[index], matrix: act.matrix };
}

// --- The matrix and the key ---

export function cellById(tx, id) {
  return tx.matrix.cells[id] ?? null;
}

const COLUMNS = 'abcdefghij';

/** The number a cell stands for when read as a number: row digit + column index ("0g" -> "06"). */
export function numberOf(id) {
  return id[0] + COLUMNS.indexOf(id[1]);
}

// --- Phase 1: finding keys in the dump ---
//
// A pick is {a, b}: two cell indices of the dump.

export function areAdjacent(tx, a, b) {
  const d = Math.abs(a - b);
  if (d === tx.cols) return true;
  return d === 1 && Math.floor(a / tx.cols) === Math.floor(b / tx.cols);
}

/** What a pair of cells spells: {id, cell}, or null if it is not a digit touching a letter a-j. */
export function tokenOfCells(tx, a, b) {
  if (a === b || !areAdjacent(tx, a, b)) return null;
  for (const [d, l] of [[tx.dump[a], tx.dump[b]], [tx.dump[b], tx.dump[a]]]) {
    if (d >= '0' && d <= '9' && d.length === 1 && COLUMNS.includes(l)) {
      const id = d + l;
      return { id, cell: cellById(tx, id) };
    }
  }
  return null;
}

export function minCell(p) {
  return Math.min(p.a, p.b);
}

/** Every pair of adjacent cells that is a valid key, in reading order. */
export function findOccurrences(tx) {
  const out = [];
  const n = tx.dump.length;
  for (let i = 0; i < n; i++) {
    for (const j of [i + 1, i + tx.cols]) {
      if (j >= n) continue;
      const t = tokenOfCells(tx, i, j);
      if (t) out.push({ id: t.id, a: i, b: j });
    }
  }
  return out.sort((p, q) => minCell(p) - minCell(q));
}

/** The first key in the dump after `pick` in reading order (what follows a marker). */
export function nextOccurrence(tx, pick) {
  return findOccurrences(tx).find((o) => minCell(o) > minCell(pick)) ?? null;
}

export function overlaps(p, q) {
  return p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b;
}

/** Picks ordered by their first cell in reading order. */
export function sortPicks(picks) {
  return [...picks].sort((p, q) => minCell(p) - minCell(q));
}

export function samePick(p, q) {
  return (p.a === q.a && p.b === q.b) || (p.a === q.b && p.b === q.a);
}

/** Can this token fill a slot of the given kind? A number slot takes any pair (it is read as digits). */
export function slotAccepts(slot, token) {
  if (!token) return false;
  if (slot === 'number') return true;
  return token.cell?.kind === slot;
}

/**
 * Do the picks, in reading order, form the message grammar (tx.slots)?
 * Number and letter slots must directly follow the previous pick in the dump:
 * a marker is followed by its number, and spelled letters follow one by one.
 */
export function parses(tx, picks) {
  const sorted = sortPicks(picks);
  if (sorted.length !== tx.slots.length) return false;
  return sorted.every((p, i) => {
    if (!slotAccepts(tx.slots[i], tokenOfCells(tx, p.a, p.b))) return false;
    if ((tx.slots[i] === 'number' || tx.slots[i] === 'letter') && i > 0) {
      const next = nextOccurrence(tx, sorted[i - 1]);
      if (!next || !samePick(next, p)) return false;
    }
    return true;
  });
}

/** Cell ids of the picks, in reading order. */
export function pickedKeys(tx, picks) {
  return sortPicks(picks).map((p) => tokenOfCells(tx, p.a, p.b).id);
}

/** The real pair of cells of message key `i`. */
export function realPick(tx, i) {
  return { a: tx.cells[i][0], b: tx.cells[i][1] };
}

/** Fallout "Likeness": how many picks are exactly a real key's pair of cells. */
export function likeness(tx, picks) {
  return picks.filter((p) => tx.cipher.some((_, i) => samePick(p, realPick(tx, i)))).length;
}

export function isLocked(tx, picks) {
  return picks.length === tx.cipher.length && likeness(tx, picks) === tx.cipher.length;
}

// --- Phase 2: reading the message ---

/** Words a key can stand for at message position `i`. A number slot reads the cell number itself. */
export function meaningsOf(tx, i, id) {
  if (tx.slots[i] === 'number') return [numberOf(id)];
  return cellById(tx, id).meanings;
}

export function isAmbiguous(tx, i, keys = null) {
  return meaningsOf(tx, i, keys?.[i] ?? tx.cipher[i]).length > 1;
}

/**
 * selection: { [messageIndex]: string[] } chosen words per key.
 * Returns 'incomplete' | 'correct' | 'hedged' | 'wrong'.
 * `keys` are the cell ids the player found (defaults to the true ones).
 */
export function judgeReading(tx, selection, keys = null) {
  let hedged = false;
  for (let i = 0; i < tx.cipher.length; i++) {
    const chosen = selection[i] ?? [];
    if (chosen.length === 0) return 'incomplete';
    const key = keys?.[i] ?? tx.cipher[i];
    const meanings = meaningsOf(tx, i, key);
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
