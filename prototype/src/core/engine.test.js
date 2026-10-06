import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import {
  prepare, cellById, digitOf, labelFor, keyLabels, areAdjacent, tokenOfCells, findOccurrences, nextOccurrence,
  parses, pickedKeys, realPick, samePick, likeness, isLocked, minCell, meaningsOf, isAmbiguous, judgeReading,
  renderSentence, resolve, applyCrew, spendIntuition, gainIntuition, ORDERS, MAX_TRIES,
} from './engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const act = JSON.parse(readFileSync(pathResolve(here, '../../../content/campaign/act1.json'), 'utf8'));
const txs = act.transmissions.map((_, i) => prepare(act, i));
const [bridge, member, hut] = txs;

const realPicks = (tx) => tx.cipher.map((_, i) => realPick(tx, i));
const sel = (...rows) => Object.fromEntries(rows.map((w, i) => [i, Array.isArray(w) ? w : [w]]));

// ---------- the matrix and the rings ----------

test('the matrix is a full 10x10 table with unique phrases and every letter once', () => {
  const ids = Object.keys(act.matrix.cells).sort();
  assert.equal(ids.length, 100);
  assert.deepEqual(ids, [...Array(100).keys()].map((i) => String(i).padStart(2, '0')));
  const phrases = Object.values(act.matrix.cells).filter((c) => c.kind !== 'letter').map((c) => c.text);
  assert.equal(new Set(phrases).size, phrases.length, 'two cells carry the same phrase');
  const letters = Object.values(act.matrix.cells).filter((c) => c.kind === 'letter').map((c) => c.text);
  assert.deepEqual([...letters].sort(), [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']);
});

test('the matrix has all three cell types: phrases, letters and the number marker', () => {
  const kinds = new Set(Object.values(act.matrix.cells).map((c) => c.kind));
  for (const k of ['who', 'place', 'action', 'thing', 'state', 'marker', 'letter']) assert.ok(kinds.has(k), k);
});

test('rings: 10 unique labels each, rows and columns disjoint', () => {
  const { rows, cols } = act.rings;
  assert.equal(new Set(rows).size, 10);
  assert.equal(new Set(cols).size, 10);
  assert.equal(rows.filter((l) => cols.includes(l)).length, 0);
});

test('the indicator label is digit 0 and the rest follow in ring order', () => {
  const { rows } = act.rings;
  assert.equal(digitOf(rows, 'RA', 'RA'), 0);
  assert.equal(digitOf(rows, 'RA', 'TU'), 1);
  assert.equal(digitOf(rows, 'RA', 'MI'), 9); // wraps around the ring
  assert.equal(labelFor(rows, 'RA', 0), 'RA');
  assert.equal(labelFor(rows, 'RA', 9), 'MI');
  for (let d = 0; d < 10; d++) assert.equal(digitOf(rows, 'BE', labelFor(rows, 'BE', d)), d);
});

test('every transmission has its own key: a permutation of the same rings', () => {
  const keys = txs.map((tx) => JSON.stringify(keyLabels(tx)));
  assert.equal(new Set(keys).size, txs.length, 'two transmissions share a key');
  for (const tx of txs) {
    const k = keyLabels(tx);
    assert.deepEqual([...k.rows].sort(), [...act.rings.rows].sort());
    assert.deepEqual([...k.cols].sort(), [...act.rings.cols].sort());
  }
});

test('the same pair of labels means a different cell under a different key', () => {
  const [a, b] = bridge.cells[0];
  const first = tokenOfCells(bridge, a, b).id;
  const moved = tokenOfCells({ ...bridge, indicator: member.indicator }, a, b).id;
  assert.notEqual(first, moved);
});

test('the cell contents do not depend on the key', () => {
  assert.equal(cellById(bridge, '18').text, 'team');
  assert.equal(cellById(hut, '18').text, 'team');
});

// ---------- the dump ----------

test('adjacency is horizontal or vertical only and never wraps around a row end', () => {
  const tx = bridge;
  assert.ok(areAdjacent(tx, 5, 6));
  assert.ok(areAdjacent(tx, 5, 5 + tx.cols));
  assert.ok(!areAdjacent(tx, tx.cols - 1, tx.cols));
  assert.ok(!areAdjacent(tx, 5, 5 + tx.cols + 1));
  assert.ok(!areAdjacent(tx, 5, 7));
});

test('real keys sit in the dump as adjacent cells that spell their cell id', () => {
  for (const tx of txs) tx.cipher.forEach((id, i) => assert.equal(tokenOfCells(tx, ...tx.cells[i]).id, id));
});

test('no accidental key pairs: only the intended keys exist, horizontal and vertical', () => {
  const expected = { 'T01-bridge': 10, 'T02-member': 10, 'T03-hut': 12 };
  for (const tx of txs) {
    const occ = findOccurrences(tx);
    assert.equal(occ.length, expected[tx.id], tx.id);
    assert.equal(new Set(occ.map((o) => o.id)).size, occ.length, `${tx.id}: a key appears twice`);
    tx.cipher.forEach((id) => assert.ok(occ.some((o) => o.id === id), `${tx.id}: real key ${id} missing`));
  }
  const vertical = findOccurrences(bridge).filter((o) => o.b - o.a === bridge.cols).length;
  assert.ok(vertical >= 2 && vertical <= 8, `orientations should be mixed (vertical: ${vertical})`);
});

test('a key can be read in either order', () => {
  const [a, b] = bridge.cells[0];
  assert.equal(tokenOfCells(bridge, a, b).id, tokenOfCells(bridge, b, a).id);
  assert.equal(tokenOfCells(bridge, a, a), null);
});

test('likeness counts picks that are exactly a real key pair, not which', () => {
  const real = realPicks(bridge);
  assert.equal(likeness(bridge, real), 5);
  assert.ok(isLocked(bridge, real));
  const decoy = findOccurrences(bridge).find((o) => !bridge.cipher.includes(o.id));
  const picks = [{ a: decoy.a, b: decoy.b }, ...real.slice(1)];
  assert.equal(likeness(bridge, picks), 4);
  assert.ok(!isLocked(bridge, picks));
});

test('parses: real picks parse, missing picks do not, reading order decides', () => {
  for (const tx of txs) assert.ok(parses(tx, realPicks(tx)), tx.id);
  assert.ok(!parses(bridge, realPicks(bridge).slice(0, 4)));
  assert.deepEqual(pickedKeys(bridge, [...realPicks(bridge)].reverse()), bridge.cipher);
});

test('a number must directly follow its marker in the dump', () => {
  const real = realPicks(member); // who, marker, number, state, place
  const occ = findOccurrences(member);
  const next = nextOccurrence(member, real[1]);
  assert.equal(next.id, member.cipher[2]); // 06 follows marker "number"
  const other = occ.find((o) => o.id !== member.cipher[2] && !member.cipher.includes(o.id));
  const bad = [real[0], real[1], { a: other.a, b: other.b }, real[3], real[4]];
  assert.ok(!parses(member, bad), 'any pair is not a number; it must be the one after the marker');
});

test('spelled letters must follow one by one after the marker', () => {
  const real = realPicks(hut); // who, action, marker, letter x3
  assert.ok(parses(hut, real));
  // letters of the other (decoy) spelling do not follow the real marker
  const decoyLetters = findOccurrences(hut).filter((o) => cellById(hut, o.id).kind === 'letter' && !hut.cipher.includes(o.id) && minCell(o) > minCell(real[1]) && minCell(o) < minCell(real[2]));
  assert.equal(decoyLetters.length, 3);
  const bad = [...real.slice(0, 3), ...decoyLetters.map((o) => ({ a: o.a, b: o.b }))];
  assert.ok(!parses(hut, bad), 'letters must directly follow the marker that was picked');
});

test('every dump is solvable within MAX_TRIES by an optimal likeness-driven strategy', () => {
  for (const tx of txs) {
    const occ = findOccurrences(tx).map((o) => ({ a: o.a, b: o.b }));
    const k = tx.slots.length;
    const combos = [];
    (function rec(start, chosen) {
      if (chosen.length === k) { if (parses(tx, chosen)) combos.push(chosen); return; }
      for (let i = start; i < occ.length; i++) rec(i + 1, [...chosen, occ[i]]);
    })(0, []);
    const lk = (g, h) => g.filter((p) => h.some((q) => samePick(p, q))).length;
    const memo = new Map();
    const solve = (pool) => {
      if (pool.length === 1) return 1;
      const key = pool.map((c) => combos.indexOf(c)).join(',');
      if (memo.has(key)) return memo.get(key);
      let best = Infinity;
      for (const g of pool) {
        const groups = new Map();
        for (const c of pool) groups.set(lk(g, c), [...(groups.get(lk(g, c)) ?? []), c]);
        let worst = 0;
        for (const [l, grp] of groups) if (l !== k) worst = Math.max(worst, solve(grp));
        best = Math.min(best, 1 + worst);
      }
      memo.set(key, best);
      return best;
    };
    const tries = solve(combos);
    assert.ok(combos.some((c) => likeness(tx, c) === k), `${tx.id}: the real message must parse`);
    assert.ok(tries <= MAX_TRIES, `${tx.id}: needs ${tries} tries`);
  }
});

// ---------- reading the message ----------

test('only the broken/repaired phrase is ambiguous in the bridge message', () => {
  assert.deepEqual(bridge.cipher.map((_, i) => isAmbiguous(bridge, i)), [false, false, false, false, true]);
});

test('a number slot reads the cell number itself; letters read as letters', () => {
  assert.deepEqual(meaningsOf(member, 2, '06'), ['06']);
  assert.deepEqual(meaningsOf(hut, 3, hut.cipher[3]), ['H']);
  assert.deepEqual(meaningsOf(member, 1, member.cipher[1]), ['number']);
});

const A = sel('team', 'CP4', 'reached', 'bridge', 'broken');
const B = sel('team', 'CP4', 'reached', 'bridge', 'repaired');
const H = sel('team', 'CP4', 'reached', 'bridge', ['broken', 'repaired']);

test('judgeReading and renderSentence on the bridge message', () => {
  assert.equal(judgeReading(bridge, {}), 'incomplete');
  assert.equal(judgeReading(bridge, A), 'correct');
  assert.equal(judgeReading(bridge, B), 'wrong');
  assert.equal(judgeReading(bridge, H), 'hedged');
  assert.equal(renderSentence(bridge, A), 'The team reached CP4. The bridge is broken.');
  assert.equal(renderSentence(bridge, H), 'The team reached CP4. The bridge is broken / repaired.');
  assert.equal(renderSentence(bridge, {}), 'The ___ ___ ___. The ___ is ___.');
});

test('a misread key makes the reading wrong even if the words look plausible', () => {
  const keys = ['18', '64', '75', '58', '26']; // CP3 instead of CP4
  assert.equal(judgeReading(bridge, sel('team', 'CP3', 'reached', 'bridge', 'broken'), keys), 'wrong');
  assert.equal(judgeReading(bridge, A, bridge.cipher), 'correct');
});

test('pitch example: reading A + wait is safe and earns Intuition; B + continue collapses the bridge', () => {
  const ok = resolve(bridge, A, 'wait');
  assert.equal(ok.severity, 'safe');
  assert.equal(ok.intuitionGain, 1);
  const bad = resolve(bridge, B, 'continue');
  assert.equal(bad.severity, 'harm');
  assert.equal(bad.intuitionGain, 0);
  assert.equal(bad.crew.length, 1);
});

test('correct reading but a reckless order still hurts and earns nothing', () => {
  const r = resolve(bridge, A, 'hurry');
  assert.equal(r.severity, 'harm');
  assert.equal(r.intuitionGain, 0);
});

test('hedging softens harm into a near miss and earns nothing; hedging a safe order stays safe', () => {
  const soft = resolve(bridge, H, 'continue');
  assert.equal(soft.severity, 'delay');
  assert.deepEqual(soft.crew, []);
  assert.equal(soft.intuitionGain, 0);
  assert.equal(resolve(bridge, H, 'wait').severity, 'safe');
});

test('member message: the number carries the crew ID and the sentence reads it', () => {
  const s = sel('member', 'number', '06', 'injured', 'CP4');
  assert.equal(judgeReading(member, s), 'correct');
  assert.equal(renderSentence(member, s), 'The member 06 is injured at CP4.');
  const wrongNumber = sel('member', 'number', '03', 'injured', 'CP4');
  assert.equal(judgeReading(member, wrongNumber), 'wrong'); // "03" is not a meaning of the real key
  assert.ok(act.crew.some((m) => m.id === '06'), 'the number refers to a real crew member');
  assert.equal(resolve(member, s, 'wait').severity, 'safe');
});

test('hut message: spelled letters assemble into a word', () => {
  const s = sel('team', 'found', 'spell', 'H', 'U', 'T');
  assert.equal(judgeReading(hut, s), 'correct');
  assert.equal(renderSentence(hut, s), 'The team found: HUT.');
});

test('every order has an outcome, and harm outcomes define a near miss', () => {
  for (const tx of txs) {
    for (const o of ORDERS) {
      const out = tx.outcomes[o];
      assert.ok(out, `${tx.id}: missing outcome for ${o}`);
      if (out.severity === 'harm') assert.ok(out.nearMiss, `${tx.id}: missing nearMiss for ${o}`);
    }
  }
});

test('resolve rejects incomplete readings', () => {
  assert.throws(() => resolve(bridge, {}, 'wait'));
});

test('crew and Intuition helpers', () => {
  const next = applyCrew(act.crew, bridge.outcomes.continue.crew);
  assert.equal(next.find((m) => m.id === '06').status, 'injured');
  assert.equal(act.crew.find((m) => m.id === '06').status, 'ok'); // immutable
  assert.equal(spendIntuition(0), null);
  assert.equal(spendIntuition(3), 2);
  assert.equal(gainIntuition(5, 1), 5);
});

test('reading-order helper', () => {
  assert.equal(minCell({ a: 9, b: 3 }), 3);
});
