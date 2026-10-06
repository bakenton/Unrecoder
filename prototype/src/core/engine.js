// Pure game logic: no DOM, no fetch. Ports 1:1 to C# later.

export const ORDERS = ['continue', 'wait', 'back', 'hurry', 'base'];
export const MAX_INTUITION = 5;

/** Candidate words for one cipher symbol, from the transmission's code table. */
export function entryFor(tx, symbol) {
  return tx.table.find((e) => e.symbol === symbol) ?? null;
}

/** The glyph the player currently believes sits at `index` (falls back to the true one). */
function glyphAt(tx, glyphs, index) {
  return glyphs?.[index] ?? tx.cipher[index];
}

export function isAmbiguous(tx, index, glyphs = null) {
  return entryFor(tx, glyphAt(tx, glyphs, index)).meanings.length > 1;
}

// --- Phase 1: tuning the noisy signal (Fallout-style) ---

export const MAX_TRIES = 4;

/** Glyphs that the noise could be hiding at `index`. A clean position has one candidate. */
export function noiseCandidates(tx, index) {
  return tx.noise?.[index] ?? [tx.cipher[index]];
}

/** Does this glyph's table entry have the type the message grammar expects at `index`? */
export function typeFits(tx, index, glyph) {
  return entryFor(tx, glyph)?.type === tx.slots[index];
}

/** Fallout "Likeness": how many positions of the guess are the real glyph. Says nothing about which. */
export function likeness(tx, glyphs) {
  return tx.cipher.reduce((n, g, i) => n + (glyphs[i] === g ? 1 : 0), 0);
}

export function isLocked(tx, glyphs) {
  return likeness(tx, glyphs) === tx.cipher.length;
}

/**
 * selection: { [cipherIndex]: string[] } chosen words per reel.
 * Returns 'incomplete' | 'correct' | 'hedged' | 'wrong'.
 * Unambiguous reels must hold their single meaning; truth only lists ambiguous reels.
 */
export function judgeReading(tx, selection, glyphs = null) {
  let hedged = false;
  for (let i = 0; i < tx.cipher.length; i++) {
    const chosen = selection[i] ?? [];
    if (chosen.length === 0) return 'incomplete';
    const meanings = entryFor(tx, glyphAt(tx, glyphs, i)).meanings;
    if (!chosen.every((w) => meanings.includes(w))) return 'wrong';
    if (glyphs && glyphs[i] !== tx.cipher[i]) return 'wrong'; // misread signal
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
export function resolve(tx, selection, order, glyphs = null) {
  const reading = judgeReading(tx, selection, glyphs);
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
