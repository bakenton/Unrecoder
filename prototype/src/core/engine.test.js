import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import {
  judgeReading, renderSentence, resolve, isAmbiguous, ORDERS, applyCrew, spendIntuition, gainIntuition,
  likeness, isLocked, findOccurrences, keyAtSpan, parses, pickedKeys, realSpan, MAX_TRIES,
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

const span = (key, start) => ({ start, end: start + key.length });
const realPicks = () => tx.cipher.map((_, i) => realSpan(tx, i));
const posOf = Object.fromEntries(findOccurrences(tx).map((o) => [o.key, o.start]));

test('the real keys sit in the dump at their recorded positions', () => {
  tx.cipher.forEach((key, i) => assert.equal(tx.stream.slice(tx.positions[i], tx.positions[i] + key.length), key));
});

test('the dump has no accidental key matches: only the intended real keys and decoys', () => {
  const found = findOccurrences(tx).map((o) => o.key);
  assert.equal(new Set(found).size, found.length, 'a key appears twice');
  // 5 real + 5 decoys = 10; the remaining 2 table keys (base, safe) are not in the dump
  assert.equal(found.length, 10);
});

test('keyAtSpan accepts only real table keys', () => {
  assert.equal(keyAtSpan(tx, posOf['c4'], posOf['c4'] + 2).key, 'c4');
  assert.equal(keyAtSpan(tx, posOf['c4'], posOf['c4'] + 1), null);
  assert.equal(keyAtSpan(tx, 0, 2), null);
});

test('likeness counts picks that are the real key at the real place, not which', () => {
  const real = realPicks();
  assert.equal(likeness(tx, real), 5);
  assert.ok(isLocked(tx, real));
  const decoyWho = span('3r', posOf['3r']);
  const picks = [decoyWho, ...real.slice(1)];
  assert.equal(likeness(tx, picks), 4);
  assert.ok(!isLocked(tx, picks));
  // same key text elsewhere does not count (position matters)
  assert.equal(likeness(tx, [span('c3', posOf['c3'])]), 0);
});

test('parses: picks must follow the grammar in stream order', () => {
  assert.ok(parses(tx, realPicks()));
  assert.ok(!parses(tx, realPicks().slice(0, 4)));
  // decoy action "lft" sits before real place "c4": left-then-reached-CP4 is not WHO PLACE ACTION THING STATE
  const bad = [span('7k', posOf['7k']), span('c4', posOf['c4']), span('lft', posOf['lft']), span('bri', posOf['bri']), span('x9', posOf['x9'])];
  assert.ok(!parses(tx, bad));
});

test('pickedKeys returns keys in stream order whatever the pick order', () => {
  assert.deepEqual(pickedKeys(tx, [...realPicks()].reverse()), tx.cipher);
});

test('the dump is solvable within MAX_TRIES by a likeness-driven strategy', () => {
  const slots = tx.slots;
  const decoysAndReal = findOccurrences(tx).filter((o) => o.start >= 0);
  const byType = (t) => decoysAndReal.filter((o) => keyAtSpan(tx, o.start, o.end).type === t);
  let pool = [[]];
  for (const t of slots) pool = pool.flatMap((p) => byType(t).map((o) => [...p, o]));
  pool = pool.filter((c) => c.every((o, i) => i === 0 || c[i - 1].end <= o.start));
  const truth = realPicks();
  const lk = (a, b) => a.filter((o, i) => o.start === b[i].start).length;
  let tries = 0;
  while (pool.length) {
    const guess = pool[0];
    tries += 1;
    const l = lk(guess, truth);
    if (l === slots.length) break;
    pool = pool.filter((c) => c !== guess && lk(c, guess) === l);
  }
  assert.ok(tries <= MAX_TRIES, `needed ${tries} tries`);
});

test('a misread key makes the reading wrong even if the words look plausible', () => {
  const keys = ['7k', 'c3', 'rea', 'bri', 'x9']; // CP3 instead of CP4
  const sel = { 0: ['team'], 1: ['CP3'], 2: ['reached'], 3: ['bridge'], 4: ['broken'] };
  assert.equal(judgeReading(tx, sel, keys), 'wrong');
  assert.equal(judgeReading(tx, A, tx.cipher), 'correct');
});
