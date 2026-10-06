// Pure game logic: no DOM, no fetch. Ports 1:1 to C# later.
//
// The code table (like the real duty-radio-operator table, "TDR") is a fixed 10x10 matrix: cell "rc" is
// row r, column c, and holds a phrase, a letter, or a service marker. Its position doubles as a number.
//
// A transmission is a list of groups "Z" + two letters. Z is a mask and means nothing. The daily key says
// which digits the two letters stand for: a vertical key gives the row digit, a horizontal key gives the
// column digit (each digit owns 2-3 letters, every letter belongs to one digit). Row + column = a cell.
// Once the cells are found, ambiguous phrases are resolved by context.

export const ORDERS = ['continue', 'wait', 'back', 'hurry', 'base'];
export const MAX_INTUITION = 5;
export const MASK = 'Z';

/** A transmission with the shared matrix attached. */
export function prepare(act, index) {
  return { ...act.transmissions[index], matrix: act.matrix };
}

export function cellById(tx, id) {
  return tx.matrix.cells[id] ?? null;
}

/** The number a cell stands for when read as a number: its own id ("06"). */
export function numberOf(id) {
  return id;
}

// --- Phase 1: decoding the groups ---

/** The digit a letter stands for in a key (an array of 10 letter strings), or -1. */
export function digitOf(keyHalf, letter) {
  return keyHalf.findIndex((letters) => letters.includes(letter));
}

/** A group "ZEQ" -> {rowLetter, colLetter, row, col, id}; null if it is not a valid group. */
export function decodeGroup(tx, group) {
  if (group.length !== 3 || group[0] !== MASK) return null;
  const row = digitOf(tx.key.rows, group[1]);
  const col = digitOf(tx.key.cols, group[2]);
  if (row < 0 || col < 0) return null;
  return { rowLetter: group[1], colLetter: group[2], row, col, id: `${row}${col}` };
}

/** The true cell id of group `i`. */
export function trueCell(tx, i) {
  return tx.cipher[i];
}

/**
 * Check the player's guess (a cell id) for group `i`.
 * Returns {ok, row, col}: whether the guess is right and whether its row / column digit is right.
 */
export function checkGuess(tx, i, id) {
  const real = tx.cipher[i];
  return { ok: id === real, row: id[0] === real[0], col: id[1] === real[1] };
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
