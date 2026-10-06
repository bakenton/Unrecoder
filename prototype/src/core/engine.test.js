import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import {
  judgeReading, renderSentence, resolve, isAmbiguous, ORDERS, applyCrew, spendIntuition, gainIntuition,
  likeness, isLocked, findOccurrences, keyOfCells, areAdjacent, parses, pickedKeys, realPick, samePick, MAX_TRIES,
} from './engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const act = JSON.parse(readFileSync(pathResolve(here, '../../../content/campaign/act1.json'), 'utf8'));
const tx = act.transmissions[0];

const base = { 0: ['team'], 1: ['CP4'], 2: ['reached'], 3: ['bridge'] };
const A = { ...base, 4: ['broken'] };
const B = { ...base, 4: ['repaired'] };
const H = { ...base, 4: ['broken', 'repaired'] };

test('only the state symbol is ambiguous', () => {
  assert.deepEqual(tx.cipher.map((_, i) => isAmbiguous(tx, i)), [false, false, false, false, true]);
});

test('judgeReading', () => {
  assert.equal(judgeReading(tx, {}), 'incomplete');
  assert.equal(judgeReading(tx, { ...base }), 'incomplete');
  assert.equal(judgeReading(tx, A), 'correct');
  assert.equal(judgeReading(tx, B), 'wrong');
  assert.equal(judgeReading(tx, H), 'hedged');
  assert.equal(judgeReading(tx, { ...A, 0: ['CP4'] }), 'wrong'); // word not in the symbol's meanings
});

test('renderSentence', () => {
  assert.equal(renderSentence(tx, A), 'The team reached CP4. The bridge is broken.');
  assert.equal(renderSentence(tx, H), 'The team reached CP4. The bridge is broken / repaired.');
  assert.equal(renderSentence(tx, {}), 'The ___ ___ ___. The ___ is ___.');
});

test('pitch example: reading A + wait is safe and earns Intuition', () => {
  const r = resolve(tx, A, 'wait');
  assert.equal(r.severity, 'safe');
  assert.equal(r.intuitionGain, 1);
  assert.match(r.text, /All safe/);
});

test('pitch example: reading B + continue collapses the bridge', () => {
  const r = resolve(tx, B, 'continue');
  assert.equal(r.severity, 'harm');
  assert.equal(r.intuitionGain, 0);
  assert.equal(r.crew.length, 1);
});

test('correct reading but reckless order still hurts and earns nothing', () => {
  const r = resolve(tx, A, 'hurry');
  assert.equal(r.severity, 'harm');
  assert.equal(r.intuitionGain, 0);
});

test('hedged reading softens harm into a near miss, no Intuition', () => {
  const r = resolve(tx, H, 'continue');
  assert.equal(r.severity, 'delay');
  assert.deepEqual(r.crew, []);
  assert.equal(r.intuitionGain, 0);
});

test('hedged reading with a safe order stays safe, no Intuition', () => {
  const r = resolve(tx, H, 'wait');
  assert.equal(r.severity, 'safe');
  assert.equal(r.intuitionGain, 0);
});

test('every order has an outcome, and harm outcomes define a near miss', () => {
  for (const o of ORDERS) {
    const out = tx.outcomes[o];
    assert.ok(out, `missing outcome for ${o}`);
    if (out.severity === 'harm') assert.ok(out.nearMiss, `missing nearMiss for ${o}`);
  }
});

test('solvability: the hint-implied truth is the only reading consistent with the crew', () => {
  const repairTech = act.crew.find((m) => m.role === 'Repair tech');
  assert.equal(repairTech.status, 'injured');
  assert.equal(tx.truth[4], 'broken');
});

test('resolve rejects incomplete readings', () => {
  assert.throws(() => resolve(tx, base, 'wait'));
});

test('crew and Intuition helpers', () => {
  const next = applyCrew(act.crew, tx.outcomes.continue.crew);
  assert.equal(next.find((m) => m.id === '06').status, 'injured');
  assert.equal(act.crew.find((m) => m.id === '06').status, 'ok'); // immutable
  assert.equal(spendIntuition(0), null);
  assert.equal(spendIntuition(3), 2);
  assert.equal(gainIntuition(5, 1), 5);
});


// --- dump / tuning ---

const realPicks = () => tx.cipher.map((_, i) => realPick(tx, i));
const occ = findOccurrences(tx);
const pickOf = (key) => { const o = occ.find((x) => x.key === key); return { a: o.a, b: o.b }; };
const minCell = (p) => Math.min(p.a, p.b);

test('real keys sit in the dump as adjacent cells that spell them', () => {
  tx.cipher.forEach((key, i) => assert.equal(keyOfCells(tx, ...tx.cells[i]).key, key));
});

test('the dump has no accidental key pairs: only real keys and decoys, horizontal and vertical', () => {
  const found = occ.map((o) => o.key);
  assert.equal(new Set(found).size, found.length, 'a key appears twice');
  assert.equal(found.length, 10); // 5 real + 5 decoys; base and safe are not in the dump
  const vertical = occ.filter((o) => o.b - o.a === tx.cols).length;
  assert.ok(vertical >= 2 && vertical <= 8, `orientations should be mixed (vertical: ${vertical})`);
});

test('adjacency is horizontal or vertical only and never wraps around a row end', () => {
  assert.ok(areAdjacent(tx, 5, 6));
  assert.ok(areAdjacent(tx, 5, 5 + tx.cols));
  assert.ok(!areAdjacent(tx, 11, 12));
  assert.ok(!areAdjacent(tx, 5, 5 + tx.cols + 1));
  assert.ok(!areAdjacent(tx, 5, 7));
});

test('keyOfCells takes a row digit and column letter in either order, rejects the rest', () => {
  const o = occ[0];
  assert.equal(keyOfCells(tx, o.a, o.b)?.key, o.key);
  assert.equal(keyOfCells(tx, o.b, o.a)?.key, o.key);
  assert.equal(keyOfCells(tx, o.a, o.a), null);
  assert.equal(keyOfCells(tx, 0, 1), null);
});

test('likeness counts picks that are exactly a real key pair, not which', () => {
  const real = realPicks();
  assert.equal(likeness(tx, real), 5);
  assert.ok(isLocked(tx, real));
  const picks = [pickOf('7a'), ...real.slice(1)];
  assert.equal(likeness(tx, picks), 4);
  assert.ok(!isLocked(tx, picks));
});

test('parses follows reading order of the pairs', () => {
  assert.ok(parses(tx, realPicks()));
  assert.ok(!parses(tx, realPicks().slice(0, 4)));
  const bad = [pickOf('7c'), pickOf('2d'), pickOf('4c'), pickOf('5a'), pickOf('9c')];
  const types = [...bad].sort((p, q) => minCell(p) - minCell(q)).map((p) => keyOfCells(tx, p.a, p.b).type);
  assert.equal(parses(tx, bad), types.join() === tx.slots.join());
});

test('pickedKeys returns keys in reading order whatever the pick order', () => {
  assert.deepEqual(pickedKeys(tx, [...realPicks()].reverse()), tx.cipher);
});

test('the dump is solvable within MAX_TRIES by a likeness-driven strategy', () => {
  const byType = (t) => occ.filter((o) => keyOfCells(tx, o.a, o.b).type === t);
  let pool = [[]];
  for (const t of tx.slots) pool = pool.flatMap((p) => byType(t).map((o) => [...p, o]));
  pool = pool.filter((c) => c.every((o, i) => i === 0 || minCell(c[i - 1]) < minCell(o)));
  const truth = realPicks();
  const lk = (g, h) => g.filter((o, i) => samePick(o, h[i])).length;
  let tries = 0;
  while (pool.length) {
    const guess = pool[0];
    tries += 1;
    const l = lk(guess, truth);
    if (l === tx.slots.length) break;
    pool = pool.filter((c) => c !== guess && lk(c, guess) === l);
  }
  assert.ok(tries <= MAX_TRIES, `needed ${tries} tries`);
});

test('a misread key makes the reading wrong even if the words look plausible', () => {
  const keys = ['7c', '2a', '4b', '5a', '9c'];
  const sel = { 0: ['team'], 1: ['CP3'], 2: ['reached'], 3: ['bridge'], 4: ['broken'] };
  assert.equal(judgeReading(tx, sel, keys), 'wrong');
  assert.equal(judgeReading(tx, A, tx.cipher), 'correct');
});
