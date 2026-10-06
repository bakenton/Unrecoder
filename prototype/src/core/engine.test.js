import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { judgeReading, renderSentence, resolve, isAmbiguous, ORDERS, applyCrew, spendIntuition, gainIntuition } from './engine.js';

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
