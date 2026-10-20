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

/**
 * Message `index` of shift `shift`, with the shared matrix attached. A message that carries `twists` is
 * played with them applied (see applyTwists); `rand` picks the day's random choices.
 */
export function prepare(act, shift, index, rand = Math.random) {
  const tx = { ...act.shifts[shift].transmissions[index], matrix: act.matrix };
  return tx.twists?.length ? applyTwists(tx, tx.twists, rand) : tx;
}

/** The reply of shift `shift`, with the shared matrix attached. */
export function prepareReply(act, shift) {
  return { ...act.shifts[shift].reply, matrix: act.matrix };
}

/** What is known about the agents when shift `shift` starts: the list, updated by every briefing so far. */
export function crewAt(act, shift) {
  return act.shifts[shift].crew ?? act.shifts.slice(0, shift + 1).reduce((crew, s) => applyCrew(crew, s.briefing), act.crew);
}

// --- Twists: the same cipher, read by different rules ---
//
// A twist changes how the day's message is presented, not what it says, so every message stays solvable:
//   mask     groups start with another letter than Z (Z and that letter trade places in the key and the noise)
//   scramble the rows and columns of the table are in a shuffled order (the digits on the edges say which is which)
//   shift    a Caesar shift: every letter of the signal arrived N places further along the alphabet
//   mirror   the signal arrives with a mirrored alphabet: A is Z, B is Y, ... (a shift of the whole alphabet, reversed)
//   axis     the two letters of a group come in either order; the letter's own key says whether it is the row or the column
//   smudge   some letters arrive smudged, showing two candidates (F/P); only one is right, and the other one is a phrase
//            the message cannot take once the clear groups are decoded
//   swap     the first letter of a group gives the column and the second the row; the table is shown turned over
// Cell ids stay canonical ("rc" of the shared matrix); only what the player sees changes.

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const IDENTITY_VIEW = { transpose: false, rowLabels: DIGITS, colLabels: DIGITS };

/** Wrong table clicks a message allows before the signal is lost. */
export const MAX_ERRORS = 3;

/** How many wrong clicks a message allows: unlimited in the first shift, which teaches the game. */
export function errorLimit(isLevel, shift) {
  return isLevel || shift >= 1 ? MAX_ERRORS : Infinity;
}

const TWIST_NAMES = {
  mask: 'start letter', scramble: 'scrambled table', shift: 'Caesar shift', mirror: 'mirrored alphabet',
  axis: 'letter sets the axis', smudge: 'smudged letters', swap: 'swapped axes',
};

export const LEVELS = [
  {
    title: 'New start letter', twists: ['mask'],
    advice: 'Today the groups do not begin with Z. The rules panel names the letter that starts every group. Z is now an ordinary letter, so do not trust your eye for it.',
  },
  {
    title: 'Scrambled table', twists: ['scramble'],
    advice: 'The edges of the table are shuffled. Do not count on the rows going 0 to 9: find the digit on the edge first, then read along it.',
  },
  {
    title: 'Caesar shift', twists: ['shift'],
    advice: 'The whole signal is turned along the alphabet by an amount nobody tells you. The rules panel says which letter the groups start with, and which letter that should be in the clear. Turn the wheel until the first lands on the second. Then switch on the pencil and click letters: they are translated with the wheel as you set it. Set it wrong, and the translations are wrong too.',
  },
  {
    title: 'Mirrored alphabet', twists: ['mirror'],
    advice: 'The alphabet of the signal is mirrored. Press FLIP on the wheel, then check that the start letter lands on the right one. Switch on the pencil and click letters to translate them with the wheel.',
  },
  {
    title: 'Smudged letters', twists: ['smudge'],
    advice: 'Some letters arrived smudged and show two candidates, like F/P. Only one is right. Decode the clear groups first: a candidate that points at a phrase the message already has, or cannot take, is the wrong one. Careful, three wrong guesses lose the message.',
  },
  {
    title: 'Cipher day', twists: ['mask', 'shift', 'smudge'],
    advice: 'A new start letter, a turned alphabet and smudged letters. Set the wheel from the start letter first, translate with the pencil, then deal with the smudges by elimination.',
  },
  {
    title: 'Everything', note: 'Four twists at once', twists: ['mask', 'scramble', 'shift', 'smudge'],
    advice: 'Four changes at once. Set the wheel from the start letter, translate the signal with the pencil, find the digits on the shuffled edges, and leave the smudged groups for last.',
  },
].map((level) => ({ ...level, note: level.note ?? level.twists.map((t) => TWIST_NAMES[t]).join(' + ') }));

/** Messages 2-4 of a shift: no ambiguity yet, so the crew list is the same as at the start of that shift. */
const LEVEL_MESSAGES = [1, 2, 3];

/** The test levels as a game of their own: one level per twist, a few messages each, no reply. */
export function buildLevels(act) {
  return {
    ...act,
    shifts: LEVELS.map((level, i) => {
      const source = i % act.shifts.length;
      return {
        title: level.title, note: level.note, advice: level.advice, twists: level.twists,
        briefing: [], crew: crewAt(act, source),
        transmissions: LEVEL_MESSAGES.map((m) => ({ ...act.shifts[source].transmissions[m], twists: level.twists })),
      };
    }),
  };
}

export function mirrorLetter(ch) {
  const i = ALPHABET.indexOf(ch);
  return i < 0 ? ch : ALPHABET[ALPHABET.length - 1 - i];
}

/** `ch` moved `n` places along the alphabet (back for a negative n); anything that is not a letter stays. */
export function shiftLetter(ch, n) {
  const i = ALPHABET.indexOf(ch);
  return i < 0 ? ch : ALPHABET[(((i + n) % 26) + 26) % 26];
}

/** A true letter as it arrives in the signal: mirrored, then shifted. */
export function toReceived(tx, ch) {
  let c = tx.mirror ? mirrorLetter(ch) : ch;
  if (tx.shift) c = shiftLetter(c, tx.shift);
  return c;
}

/**
 * What the cipher wheel says a letter of the signal stands for, with the wheel turned by `wheel.shift` and flipped
 * if `wheel.mirror`. The player sets the wheel; the true setting is the message's own shift and mirror.
 */
export function wheelLetter(wheel, ch) {
  const c = wheel.shift ? shiftLetter(ch, -wheel.shift) : ch;
  return wheel.mirror ? mirrorLetter(c) : c;
}

/** A letter of the signal as the key knows it: the shift and the mirror undone. */
export function realLetter(tx, ch) {
  return wheelLetter({ shift: tx.shift, mirror: tx.mirror }, ch);
}

function shuffled(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Which axis letter `pos` (1 or 2) of group `id` gives: positional, unless the axis twist mixed the order. */
export function roleOf(tx, id, pos) {
  const order = tx.axisOrder?.[id] ?? 'rc';
  return (pos === 1) === (order === 'rc') ? 'row' : 'col';
}

/** The axis twist: every key letter belongs to one key only, and a group's two letters come in either order. */
function rekeyByAxis(out, rand) {
  const letters = shuffled([...out.key.rows.join('')], rand);
  const half = Math.ceil(letters.length / 2);
  const spread = (list) => { // the letters over ten digits, at least one each
    const buckets = DIGITS.map((d) => [list[d]]);
    list.slice(10).forEach((ch) => buckets[Math.floor(rand() * 10)].push(ch));
    return buckets;
  };
  const rows = spread(letters.slice(0, half));
  const cols = spread(letters.slice(half));
  const pickIn = (bucket) => bucket[Math.floor(rand() * bucket.length)];
  const dump = [...out.dump];
  const order = {};
  for (const id of groupIds(out)) {
    const p = posOf(out, id);
    const lost = lostHalf(out, id); // still positional: row letter first
    const rowLetter = lost === 'row' ? LOST : pickIn(rows[Number(id[0])]);
    const colLetter = lost === 'col' ? LOST : pickIn(cols[Number(id[1])]);
    order[id] = rand() < 0.5 ? 'rc' : 'cr';
    [dump[p + 1], dump[p + 2]] = order[id] === 'rc' ? [rowLetter, colLetter] : [colLetter, rowLetter];
  }
  out.dump = dump;
  out.key = { rows: rows.map((b) => b.join('')), cols: cols.map((b) => b.join('')) };
  out.axis = true;
  out.axisOrder = order;
}

/**
 * The smudge twist: up to two clear groups get one letter that shows two candidates. The wrong candidate always
 * points at a phrase the message cannot take once the clear groups are decoded: not a phrase of the sentence at all,
 * or the kind of a blank that a clear group (which is never smudged) already fills.
 */
function smudge(out, rand) {
  const dump = [...out.dump];
  const smudged = {};
  const sureOf = new Set(); // clear groups that a smudge relies on: they stay clear
  const kindOf = (id) => cellById(out, id).kind;
  const isClear = (id) => !shownOf(out, id).includes(LOST) && !smudged[id];
  for (const k of shuffled(out.cipher.map((_, i) => i), rand)) {
    if (Object.keys(smudged).length >= 2) break;
    const id = out.cipher[k];
    if (!isClear(id) || sureOf.has(id)) continue;
    const pos = 1 + Math.floor(rand() * 2);
    const row = roleOf(out, id, pos) === 'row';
    const keyHalf = row ? out.key.rows : out.key.cols;
    const own = Number(id[row ? 0 : 1]);
    const options = [];
    keyHalf.forEach((letters, d) => {
      if (d === own) return;
      const decoy = row ? `${d}${id[1]}` : `${id[0]}${d}`;
      const kind = kindOf(decoy);
      if (!SENTENCE_KINDS.includes(kind)) return options.push({ letters, anchor: null });
      const j = out.slots.findIndex((slot, n) => slot === kind && n !== k);
      if (j >= 0 && isClear(out.cipher[j])) options.push({ letters, anchor: out.cipher[j] });
    });
    if (!options.length) continue;
    const { letters, anchor } = options[Math.floor(rand() * options.length)];
    if (anchor) sureOf.add(anchor);
    const decoyLetter = toReceived(out, [...letters][Math.floor(rand() * letters.length)]);
    const p = posOf(out, id);
    const truth = dump[p + pos];
    const [primary, alt] = rand() < 0.5 ? [truth, decoyLetter] : [decoyLetter, truth];
    dump[p + pos] = primary;
    smudged[id] = { pos, alt };
  }
  out.dump = dump;
  out.smudged = smudged;
}

/** The message with `twists` applied: its signal, key and view are rewritten, its meaning is not. */
export function applyTwists(tx, twists, rand = Math.random) {
  const out = { ...tx, mask: MASK, mirror: false, shift: 0, axis: false, axisOrder: {}, smudged: {}, view: IDENTITY_VIEW, twists };
  if (twists.includes('axis')) rekeyByAxis(out, rand);
  if (twists.includes('mask')) {
    const letter = NOISE[Math.floor(rand() * NOISE.length)];
    const swap = (ch) => (ch === MASK ? letter : ch === letter ? MASK : ch);
    out.mask = letter;
    out.dump = out.dump.map(swap);
    out.key = { rows: out.key.rows.map((s) => [...s].map(swap).join('')), cols: out.key.cols.map((s) => [...s].map(swap).join('')) };
  }
  if (twists.includes('mirror')) out.mirror = true;
  if (twists.includes('shift')) out.shift = 2 + Math.floor(rand() * 22);
  if (out.mirror || out.shift) out.dump = out.dump.map((ch) => toReceived(out, ch));
  if (twists.includes('smudge')) smudge(out, rand);
  if (twists.includes('swap')) out.view = { ...out.view, transpose: true };
  if (twists.includes('scramble')) {
    const mixed = () => { let l; do l = shuffled(DIGITS, rand); while (l.every((d, i) => d === i)); return l; };
    out.view = { ...out.view, rowLabels: mixed(), colLabels: mixed() };
  }
  return out;
}

/** The letter every group starts with, as it arrives in the signal. */
export function receivedMask(tx) {
  return toReceived(tx, tx.mask ?? MASK);
}

export function viewOf(tx) {
  return tx.view ?? IDENTITY_VIEW;
}

/** The two keys as the player sees them: which one is labelled vertical (rows) and which horizontal (columns). */
export function displayedKeys(tx) {
  return viewOf(tx).transpose ? { vertical: tx.key.cols, horizontal: tx.key.rows } : { vertical: tx.key.rows, horizontal: tx.key.cols };
}

/** The cell id behind the table position with row label `rowLabel` and column label `colLabel`. */
export function canonicalAt(tx, rowLabel, colLabel) {
  return viewOf(tx).transpose ? `${colLabel}${rowLabel}` : `${rowLabel}${colLabel}`;
}

/** Decode a group as it arrives, by the day's rules: the cell id it points at, or null. (Smudged letters: the first candidate.) */
export function decodeShown(tx, shown) {
  const [mask, a, b] = shown;
  if (mask !== receivedMask(tx)) return null;
  if (tx.axis) { // the letter's own key says which axis it gives
    const [x, y] = [realLetter(tx, a), realLetter(tx, b)];
    const first = digitOf(tx.key.rows, x);
    const [row, col] = first >= 0 ? [first, digitOf(tx.key.cols, y)] : [digitOf(tx.key.rows, y), digitOf(tx.key.cols, x)];
    return row < 0 || col < 0 ? null : `${row}${col}`;
  }
  const keys = displayedKeys(tx);
  const turned = viewOf(tx).transpose;
  const first = digitOf(turned ? keys.horizontal : keys.vertical, realLetter(tx, a));
  const second = digitOf(turned ? keys.vertical : keys.horizontal, realLetter(tx, b));
  if (first < 0 || second < 0) return null;
  return turned ? canonicalAt(tx, second, first) : canonicalAt(tx, first, second);
}

/** Every cell group `id` could point at: one, or two while a letter is smudged. */
export function candidatesOf(tx, id) {
  const p = posOf(tx, id);
  const smear = tx.smudged?.[id];
  const letters = (pos) => (smear?.pos === pos ? [tx.dump[p + pos], smear.alt] : [tx.dump[p + pos]]);
  const out = [];
  for (const a of letters(1)) {
    for (const b of letters(2)) {
      const cell = decodeShown(tx, `${tx.dump[p]}${a}${b}`);
      if (cell && !out.includes(cell)) out.push(cell);
    }
  }
  return out;
}

/** The three letters of group `id` as the player reads them, with smudged letters as "F/P". */
export function labelOf(tx, id) {
  const p = posOf(tx, id);
  const smear = tx.smudged?.[id];
  return [0, 1, 2].map((o) => (smear?.pos === o ? `${tx.dump[p + o]}/${smear.alt}` : tx.dump[p + o])).join(' ');
}

/** The day's rules as lines of text for the rules panel; empty when nothing is twisted. */
export function describeTwists(tx) {
  const twists = tx.twists ?? [];
  const lines = [];
  const turned = twists.includes('mirror') || twists.includes('shift');
  const mask = tx.mask ?? MASK;
  if (turned) lines.push(`Groups arrive starting with ${receivedMask(tx)}. In the clear they start with ${mask}.`);
  else if (twists.includes('mask')) lines.push(`Every group starts with the letter ${receivedMask(tx)}.`);
  if (twists.includes('shift')) lines.push(`The alphabet of the signal is turned by an amount you must find: turn the wheel until ${receivedMask(tx)} lands on ${mask}.`);
  if (twists.includes('mirror')) lines.push('The alphabet of the signal is mirrored: flip the wheel.');
  if (twists.includes('axis')) lines.push('The two letters of a group come in either order. A letter in the VERTICAL key gives the row, a letter in the HORIZONTAL key gives the column.');
  if (twists.includes('swap')) lines.push('The FIRST letter of a group gives the COLUMN (horizontal key). The SECOND gives the ROW (vertical key).');
  if (twists.includes('smudge')) lines.push('Some letters are smudged and show two candidates, like F/P. Only one is right: decode the clear groups first, then see which candidate still fits.');
  if (twists.includes('scramble')) lines.push('The rows and columns of the table are in a scrambled order. Go by the digits on its edges.');
  return lines;
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
  return shown[1] === LOST ? roleOf(tx, id, 1) : shown[2] === LOST ? roleOf(tx, id, 2) : null;
}

/** Do the letters of group `id` that did arrive point at its cell under the daily key? */
export function fitsKey(tx, id) {
  const p = posOf(tx, id);
  if (tx.dump[p] !== receivedMask(tx)) return false;
  const smear = tx.smudged?.[id];
  return [1, 2].every((pos) => {
    const shown = tx.dump[p + pos];
    if (shown === LOST) return true;
    const row = roleOf(tx, id, pos) === 'row';
    const digit = Number(id[row ? 0 : 1]);
    return (smear?.pos === pos ? [shown, smear.alt] : [shown]).some((ch) => digitOf(row ? tx.key.rows : tx.key.cols, realLetter(tx, ch)) === digit);
  });
}

/**
 * Lay groups (three-letter strings) out among noise letters in a cols x rows grid. No group wraps a row or
 * touches another. `fixed` pins some groups (by index) to a position. `rand` is a () => [0, 1) source.
 * Returns {dump, at}: the grid and the start position of every group.
 */
export function scatter(groups, cols, rows, rand, fixed = {}, noise = NOISE) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let attempt = 0; attempt < 200; attempt++) {
    const dump = Array.from({ length: cols * rows }, () => pick(noise));
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
  const noise = [...ALPHABET].filter((ch) => ch !== receivedMask(tx)).join(''); // the start letter never appears as noise
  const { dump, at } = scatter(ids.map((id) => shownOf(tx, id)), tx.cols, tx.dump.length / tx.cols, rand, fixed, noise);
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
