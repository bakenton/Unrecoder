import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { judgeReading, renderSentence, resolve, isAmbiguous, ORDERS, applyCrew, spendIntuition, gainIntuition, likeness, isLocked, typeFits, noiseCandidates, MAX_TRIES } from './engine.js';

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

test('tuning: likeness counts correct glyph positions without saying which', () => {
  assert.equal(likeness(tx, ['7', '4', 'd', 'b', '9']), 2); // 7 and b right
  assert.equal(likeness(tx, ['7', '2', 'a', 'b', 'c']), 5);
  assert.ok(isLocked(tx, tx.cipher));
  assert.ok(!isLocked(tx, ['7', '4', 'd', 'b', '9']));
});

test('tuning: the true glyph is always among the noise candidates and fits its slot type', () => {
  tx.cipher.forEach((g, i) => {
    assert.ok(noiseCandidates(tx, i).includes(g));
    assert.ok(typeFits(tx, i, g));
  });
});

test('tuning: slot 0 is solvable by the table alone (wrong candidate has the wrong type)', () => {
  const wrong = noiseCandidates(tx, 0).find((g) => g !== tx.cipher[0]);
  assert.ok(!typeFits(tx, 0, wrong));
});

test('tuning is solvable within MAX_TRIES by a likeness-driven strategy', () => {
  // Brute-force strategy: every guess consistent with all previous likeness feedback.
  const cands = tx.cipher.map((_, i) => noiseCandidates(tx, i));
  let pool = [[]];
  cands.forEach((c) => { pool = pool.flatMap((p) => c.map((g) => [...p, g])); });
  let tries = 0;
  while (pool.length) {
    const guess = pool[0];
    tries += 1;
    const l = likeness(tx, guess);
    if (l === tx.cipher.length) break;
    pool = pool.filter((g) => g !== guess && likenessBetween(g, guess) === l);
  }
  assert.ok(tries <= MAX_TRIES, `needed ${tries} tries`);
});

function likenessBetween(a, b) {
  return a.reduce((n, x, i) => n + (x === b[i] ? 1 : 0), 0);
}

test('a misread signal makes the reading wrong even if the words look plausible', () => {
  const badGlyphs = ['7', '4', 'a', 'b', 'c']; // CP3 instead of CP4
  const sel = { 0: ['team'], 1: ['CP3'], 2: ['reached'], 3: ['bridge'], 4: ['broken'] };
  assert.equal(judgeReading(tx, sel, badGlyphs), 'wrong');
  assert.equal(judgeReading(tx, { ...A }, tx.cipher), 'correct');
});
