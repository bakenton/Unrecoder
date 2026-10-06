// Converts content/campaign/act1.json to the "Z + two letters" format and (re)generates each
// transmission's daily key and groups from its cipher. Safe to run again: the keys are seeded.
// Usage: node content/tools/make_keys.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

act.transmissions.forEach((tx, n) => {
  const r = rng(1000 + n * 77);
  tx.key = { rows: makeKeyHalf(r), cols: makeKeyHalf(r) };
  const used = new Set(); // a cell is never sent twice with the same letters within a day
  tx.groups = tx.cipher.map((id) => {
    const rows = tx.key.rows[Number(id[0])], cols = tx.key.cols[Number(id[1])];
    const options = [];
    for (const a of rows) for (const b of cols) options.push('Z' + a + b);
    const fresh = options.filter((g) => !used.has(g));
    const pool = fresh.length ? fresh : options;
    const g = pool[Math.floor(r() * pool.length)];
    used.add(g);
    return g;
  });
});

writeFileSync(path, JSON.stringify(act, null, 1) + '\n');
console.log('Wrote', path);
