// Converts content/campaign/act1.json to the "Z + two letters" format and (re)generates each
// transmission's daily key and signal (real groups, decoys, damage) from its cipher. Seeded, so safe to run again.
// Usage: node content/tools/make_keys.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, candidates, groupAt, parses } from '../../prototype/src/core/engine.js';

const path = resolve(dirname(fileURLToPath(import.meta.url)), '../campaign/act1.json');
const act = JSON.parse(readFileSync(path, 'utf8'));

// Old format: columns a-j. Re-key every cell id from "0g" to "06".
if (act.matrix.cols === 'abcdefghij') {
  const fix = (id) => id[0] + 'abcdefghij'.indexOf(id[1]);
  act.matrix.cols = '0123456789';
  act.matrix.cells = Object.fromEntries(Object.entries(act.matrix.cells).map(([id, c]) => [fix(id), c]));
  for (const tx of act.transmissions) {
    tx.cipher = tx.cipher.map(fix);
    delete tx.dump; delete tx.cols; delete tx.cells;
  }
}

function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (arr, r) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

// 25 letters (A-Y; Z is the mask) over 10 digits: five digits own 3 letters, five own 2.
function makeKeyHalf(r) {
  const letters = shuffle([...'ABCDEFGHIJKLMNOPQRSTUVWXY'], r);
  const sizes = shuffle([3, 3, 3, 3, 3, 2, 2, 2, 2, 2], r);
  let at = 0;
  return sizes.map((n) => { const part = letters.slice(at, at + n).sort().join(''); at += n; return part; });
}

const COLS = 12;
const ROWS = 7;
// Per transmission: how many decoy groups and how many damaged real groups.
const PLAN = [{ decoys: 2, damage: 0 }, { decoys: 3, damage: 1 }, { decoys: 4, damage: 1 }];
const NOISE = 'ABCDEFGHIJKLMNOPQRSTUVWXY';

const pick = (arr, r) => arr[Math.floor(r() * arr.length)];

/** A group (Z + two letters) for cell id `id`: one letter from each key half, not repeated. */
function groupFor(key, id, r, used) {
  const options = [];
  for (const a of key.rows[Number(id[0])]) for (const b of key.cols[Number(id[1])]) options.push(MASK + a + b);
  const fresh = options.filter((g) => !used.has(g));
  const g = pick(fresh.length ? fresh : options, r);
  used.add(g);
  return g;
}
const MASK = 'Z';

/** Can the cell be found from the row alone (or the column alone) by its kind? */
function uniqueIn(act, id, byRow) {
  const kind = act.matrix.cells[id].kind;
  const same = Object.entries(act.matrix.cells).filter(([k, c]) => (byRow ? k[0] === id[0] : k[1] === id[1]) && c.kind === kind);
  return same.length === 1;
}

function build(act, tx, n, plan, attempt) {
  const r = rng(5000 + n * 131 + attempt);
  const used = new Set();
  const real = tx.cipher.map((id) => groupFor(tx.key, id, r, used));
  const decoys = [];
  while (decoys.length < plan.decoys) {
    const id = pick(Object.keys(act.matrix.cells), r);
    decoys.push(groupFor(tx.key, id, r, used));
  }
  // Order of blocks: real groups in order, decoys dropped between them, but never between a marker and
  // the number / letter that follows it.
  const order = real.map((g, i) => ({ g, real: true, i }));
  for (const d of decoys) {
    const slots = [];
    for (let at = 1; at <= order.length; at++) {
      const next = order[at];
      const nextSlot = next?.real ? tx.slots[next.i] : null;
      if (nextSlot === 'number' || nextSlot === 'letter') continue; // would split a marker from its follower
      slots.push(at);
    }
    slots.push(0); // before the first group
    order.splice(pick(slots, r), 0, { g: d, real: false });
  }
  const dump = Array.from({ length: COLS * ROWS }, () => pick([...NOISE], r));
  let pos = Math.floor(r() * 4);
  const realPos = [];
  const groupPos = [];
  const slack = (COLS * ROWS - 3 * order.length) / (order.length + 1);
  for (const block of order) {
    pos += Math.floor(r() * slack * 1.4);
    if (pos % COLS > COLS - 3) pos += COLS - (pos % COLS);
    if (pos + 3 > dump.length) return null;
    [...block.g].forEach((ch, k) => { dump[pos + k] = ch; });
    if (block.real) realPos.push(pos);
    groupPos.push(pos);
    pos += 3;
  }
  // Damage: lose the column letter (or the row letter) of a real group whose cell can still be found by kind.
  const damaged = {};
  const eligible = [];
  realPos.forEach((p, i) => {
    if (['number', 'letter', 'marker'].includes(tx.slots[i])) return;
    if (uniqueIn(act, tx.cipher[i], true)) eligible.push({ p, k: 2 });
    else if (uniqueIn(act, tx.cipher[i], false)) eligible.push({ p, k: 1 });
  });
  for (let d = 0; d < plan.damage && eligible.length; d++) {
    const e = eligible.splice(Math.floor(r() * eligible.length), 1)[0];
    damaged[e.p + e.k] = dump[e.p + e.k];
    dump[e.p + e.k] = '?';
  }
  return { dump, real: realPos, damaged };
}

/** Exactly one set of groups, in reading order, must fit the message grammar: the real one. */
function solutions(tx) {
  const cands = candidates(tx);
  const out = [];
  const go = (start, chosen) => {
    if (chosen.length === tx.slots.length) { if (parses(tx, chosen)) out.push([...chosen]); return; }
    for (let i = start; i < cands.length; i++) go(i + 1, [...chosen, cands[i]]);
  };
  go(0, []);
  return out;
}

act.transmissions.forEach((tx, n) => {
  const r = rng(1000 + n * 77);
  tx.key = { rows: makeKeyHalf(r), cols: makeKeyHalf(r) };
  delete tx.groups;
  const plan = PLAN[n] ?? PLAN[PLAN.length - 1];
  for (let attempt = 0; attempt < 500; attempt++) {
    const built = build(act, tx, n, plan, attempt);
    if (!built) continue;
    Object.assign(tx, { cols: COLS, dump: built.dump, real: built.real, damaged: built.damaged });
    const sols = solutions(prepare(act, n));
    const p = prepare(act, n);
    const realOk = sols.length === 1 && sols[0].join() === tx.real.join();
    // a damaged group must still decode through its restored letters
    const decodes = tx.real.every((pos, i) => groupAt(p, pos)?.id === tx.cipher[i]);
    if (realOk && decodes) { console.log(`${tx.id}: attempt ${attempt}, ${candidates(p).length} groups, ${Object.keys(tx.damaged).length} damaged`); break; }
    if (attempt === 499) throw new Error(`${tx.id}: no unique solution found`);
  }
});

writeFileSync(path, JSON.stringify(act, null, 1) + '\n');
console.log('Wrote', path);
