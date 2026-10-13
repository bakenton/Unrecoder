// Pure game logic: no DOM, no fetch. Ports 1:1 to C# later.
//
// The code table (like the real duty-radio-operator table, "TDR") is a fixed 10x10 matrix: cell "rc" is
// row r, column c, and holds a phrase, a letter, or a service marker.
//
// A message is a set of groups "Z" + two letters. Z is a mask and means nothing. The daily key says
// which digits the two letters stand for: a vertical key gives the row digit, a horizontal key gives the
// column digit (each digit owns 2-3 letters, every letter belongs to one digit). Row + column = a cell.
// Every message has the same grammar: one phrase of each kind (who, place, action, state, result), though the
// kinds come in a different order from message to message. A decoded phrase finds its own blank by its kind,
// whatever order the groups are decoded in.
// The game is a run of shifts: a shift is a few messages to decode and, at the end, one reply to encode.
// Once the blanks are filled, ambiguous phrases are resolved by context, and the decoded message is filed:
// what others do with it depends on how it was read.

export const MAX_INTUITION = 5;
export const MASK = 'Z';
export const LOST = '?';
export const NOISE = 'ABCDEFGHIJKLMNOPQRSTUVWXY';
export const SENTENCE_KINDS = ['who', 'place', 'action', 'state', 'result'];

/** Message `index` of shift `shift`, with the shared matrix attached. */
export function prepare(act, shift, index) {
  return { ...act.shifts[shift].transmissions[index], matrix: act.matrix };
}

/** The reply of shift `shift`, with the shared matrix attached. */
export function prepareReply(act, shift) {
  return { ...act.shifts[shift].reply, matrix: act.matrix };
}

/** What is known about the agents when shift `shift` starts: the list, updated by every briefing so far. */
export function crewAt(act, shift) {
  return act.shifts.slice(0, shift + 1).reduce((crew, s) => applyCrew(crew, s.briefing), act.crew);
}

export function cellById(tx, id) {
  return tx.matrix.cells[id] ?? null;
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

/** The true cell id of message group `i` (the real groups, in message order). */
export function trueCell(tx, i) {
  return tx.cipher[i];
}

/**
 * Check the player's guess (a cell id) against the group's true cell id.
 * Returns {ok, row, col}: whether the guess is right and whether its row / column digit is right.
 */
export function checkGuess(real, id) {
  return { ok: id === real, row: id[0] === real[0], col: id[1] === real[1] };
}

// --- Phase 1: the signal ---
//
// The signal is a grid of letters. Every Z starts a group (Z + two letters); the rest is noise. A group is named
// by the cell it stands for. The message groups are tx.cipher (tx.cipher[k] fills blank k, at position tx.real[k]);
// tx.strayCipher / tx.stray are groups of other traffic that fit no blank. Groups sit in no particular order.
// In a damaged group one letter is lost and shows as "?": the other letter still gives the row or the column,
// and the grammar and the context have to give the rest.

/** The cell ids of every group in the signal: the message groups first, then the stray ones. */
export function groupIds(tx) {
  return [...tx.cipher, ...tx.strayCipher];
}

/** The blank (message index) that group `id` fills, or -1 for a stray group. */
export function blankOf(tx, id) {
  return tx.cipher.indexOf(id);
}

/** Where group `id` starts in the signal. */
export function posOf(tx, id) {
  const k = blankOf(tx, id);
  return k >= 0 ? tx.real[k] : tx.stray[tx.strayCipher.indexOf(id)];
}

/** The three letters of group `id` as received, e.g. "ZSD" or "Z?D". */
export function shownOf(tx, id) {
  const p = posOf(tx, id);
  return tx.dump.slice(p, p + 3).join('');
}

/** The group that covers signal position `i`, or null for noise. */
export function groupIdAt(tx, i) {
  return groupIds(tx).find((id) => i >= posOf(tx, id) && i < posOf(tx, id) + 3) ?? null;
}

/** Which half of group `id` is lost in the signal: 'row', 'col' or null. */
export function lostHalf(tx, id) {
  const shown = shownOf(tx, id);
  return shown[1] === LOST ? 'row' : shown[2] === LOST ? 'col' : null;
}

/** Do the letters of group `id` that did arrive point at its cell under the daily key? */
export function fitsKey(tx, id) {
  const [mask, a, b] = shownOf(tx, id);
  return mask === MASK
    && (a === LOST || digitOf(tx.key.rows, a) === Number(id[0]))
    && (b === LOST || digitOf(tx.key.cols, b) === Number(id[1]));
}

/**
 * Lay groups (three-letter strings) out among noise letters in a cols x rows grid. No group wraps a row or
 * touches another. `fixed` pins some groups (by index) to a position. `rand` is a () => [0, 1) source.
 * Returns {dump, at}: the grid and the start position of every group.
 */
export function scatter(groups, cols, rows, rand, fixed = {}) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let attempt = 0; attempt < 200; attempt++) {
    const dump = Array.from({ length: cols * rows }, () => pick(NOISE));
    const at = groups.map((_, i) => fixed[i] ?? null);
    const taken = () => at.filter((p) => p !== null);
    for (let i = 0; i < groups.length && at[i] !== undefined; i++) {
      if (at[i] === null) {
        const free = dump.map((_, p) => p).filter((p) => p % cols <= cols - 3 && taken().every((q) => Math.abs(q - p) >= 4));
        at[i] = free.length ? pick(free) : undefined;
      }
    }
    if (at.includes(undefined)) continue;
    groups.forEach((g, i) => [...g].forEach((ch, d) => { dump[at[i] + d] = ch; }));
    return { dump, at };
  }
  throw new Error('Could not place the groups');
}

/** The same message with its signal shuffled: groups move, noise changes. Groups in `keep` stay where they are. */
export function relayout(tx, keep, rand) {
  const ids = groupIds(tx);
  const fixed = {};
  ids.forEach((id, i) => { if (keep.includes(id)) fixed[i] = posOf(tx, id); });
  const { dump, at } = scatter(ids.map((id) => shownOf(tx, id)), tx.cols, tx.dump.length / tx.cols, rand, fixed);
  return { ...tx, dump, real: at.slice(0, tx.cipher.length), stray: at.slice(tx.cipher.length) };
}

// --- Phase 2: reading the message ---

/** Words a cell can stand for: more than one for an ambiguous phrase. */
export function meaningsOf(tx, id) {
  return cellById(tx, id).meanings;
}

export function isAmbiguous(tx, i) {
  return meaningsOf(tx, tx.cipher[i]).length > 1;
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
    const meanings = meaningsOf(tx, key);
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
 * File the decoded message: what happens next depends only on how the player read it.
 *  - correct -> tx.outcomes.correct, +1 Intuition
 *  - hedged (both meanings reported, the true one among them) -> tx.outcomes.hedged, no Intuition
 *  - wrong   -> tx.outcomes.wrong, no Intuition
 * A message with no ambiguous phrase can only be read correctly.
 */
export function resolve(tx, selection) {
  const reading = judgeReading(tx, selection);
  if (reading === 'incomplete') throw new Error('Reading is incomplete');
  const outcome = tx.outcomes[reading];
  return { reading, severity: outcome.severity, text: outcome.text, crew: outcome.crew, intuitionGain: reading === 'correct' ? 1 : 0 };
}

export function applyCrew(crew, changes) {
  return crew.map((m) => {
    const c = changes.find((x) => x.id === m.id);
    return c ? { ...m, status: c.status ?? m.status, note: c.note ?? m.note, location: c.location ?? m.location } : m;
  });
}

export function spendIntuition(points, cost = 1) {
  if (points < cost) return null;
  return points - cost;
}

export function gainIntuition(points, gain) {
  return Math.min(MAX_INTUITION, points + gain);
}

// --- The reply: encoding a message from command for the agents ---
//
// The other way round: a phrase is found in the table, its row digit and column digit are turned into letters
// with the reply key (a = one of the row digit's letters, b = one of the column digit's letters), and the group
// Z + a + b goes out. The one rule: a letter may be used once in the whole reply, in either place. Every digit
// owns only 2-3 letters and the same letter sits in both halves of the key, so a careless choice early on can
// leave a later phrase with no letters at all.

/** The letter pairs [a, b] still free for cell `id`, given the letters already `used` (a string or an array). */
export function replyOptions(key, id, used = '') {
  const pairs = [];
  for (const a of key.rows[Number(id[0])]) {
    for (const b of key.cols[Number(id[1])]) if (a !== b && !used.includes(a) && !used.includes(b)) pairs.push([a, b]);
  }
  return pairs;
}

/** How many ways are left to encode all the cells in `ids` without repeating a letter. */
export function countReplies(key, ids, used = '') {
  if (ids.length === 0) return 1;
  return replyOptions(key, ids[0], used).reduce((n, [a, b]) => n + countReplies(key, ids.slice(1), used + a + b), 0);
}

/** Can the cells in `ids` still all be encoded, given the letters already `used`? */
export function canFinishReply(key, ids, used = '') {
  if (ids.length === 0) return true;
  return replyOptions(key, ids[0], used).some(([a, b]) => canFinishReply(key, ids.slice(1), used + a + b));
}
