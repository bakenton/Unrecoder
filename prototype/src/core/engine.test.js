import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import {
  prepare, cellById, numberOf, digitOf, decodeGroup, checkGuess, meaningsOf, isAmbiguous, judgeReading,
  renderSentence, resolve, applyCrew, spendIntuition, gainIntuition, ORDERS, MASK,
} from './engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const act = JSON.parse(readFileSync(pathResolve(here, '../../../content/campaign/act1.json'), 'utf8'));
const txs = act.transmissions.map((_, i) => prepare(act, i));
const [bridge, member, hut] = txs;

const sel = (...rows) => Object.fromEntries(rows.map((w, i) => [i, Array.isArray(w) ? w : [w]]));

// ---------- the matrix ----------

test('the matrix is a full 10x10 table with unique phrases and every letter once', () => {
  const ids = Object.keys(act.matrix.cells).sort();
  assert.equal(ids.length, 100);
  assert.deepEqual(ids, [...'0123456789'].flatMap((r) => [...'0123456789'].map((c) => r + c)));
  const phrases = Object.values(act.matrix.cells).filter((c) => c.kind !== 'letter').map((c) => c.text);
  assert.equal(new Set(phrases).size, phrases.length, 'two cells carry the same phrase');
  const letters = Object.values(act.matrix.cells).filter((c) => c.kind === 'letter').map((c) => c.text);
  assert.deepEqual([...letters].sort(), [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']);
});

test('the matrix has all the cell types: phrases, letters and the number marker', () => {
  const kinds = new Set(Object.values(act.matrix.cells).map((c) => c.kind));
  for (const k of ['who', 'place', 'action', 'thing', 'state', 'marker', 'letter']) assert.ok(kinds.has(k), k);
});

test('the same cell has the same content in every transmission', () => {
  assert.equal(cellById(bridge, '18').text, 'team');
  assert.equal(cellById(hut, '18').text, 'team');
});

// ---------- the daily key and the groups ----------

test('each daily key covers 25 letters A-Y once, 2-3 per digit, and never uses the mask', () => {
  for (const tx of txs) {
    for (const half of [tx.key.rows, tx.key.cols]) {
      assert.equal(half.length, 10);
      assert.ok(half.every((ls) => ls.length === 2 || ls.length === 3), tx.id);
      assert.deepEqual([...half.join('')].sort(), [...'ABCDEFGHIJKLMNOPQRSTUVWXY']);
      assert.ok(!half.join('').includes(MASK));
    }
  }
});

test('the key changes every transmission', () => {
  assert.notDeepEqual(bridge.key, member.key);
  assert.notDeepEqual(member.key, hut.key);
});

test('digitOf looks a letter up in a key half', () => {
  const half = ['AB', 'CDE', 'FG', 'HI', 'JK', 'LM', 'NO', 'PQ', 'RS', 'TUV'];
  assert.equal(digitOf(half, 'D'), 1);
  assert.equal(digitOf(half, 'V'), 9);
  assert.equal(digitOf(half, 'Z'), -1);
});

test('every group is Z + two letters and decodes to its cipher cell', () => {
  for (const tx of txs) {
    assert.equal(tx.groups.length, tx.cipher.length);
    tx.groups.forEach((g, i) => {
      assert.equal(g.length, 3);
      assert.equal(g[0], MASK);
      assert.equal(decodeGroup(tx, g).id, tx.cipher[i], `${tx.id} group ${i}`);
    });
  }
});

test('decodeGroup rejects groups without the mask or with unknown letters', () => {
  assert.equal(decodeGroup(bridge, 'AEQ'), null);
  assert.equal(decodeGroup(bridge, 'ZZZ'), null);
  assert.equal(decodeGroup(bridge, 'ZA'), null);
});

test('a cell sent twice in one transmission uses different letters', () => {
  for (const tx of txs) assert.equal(new Set(tx.groups).size, tx.groups.length, tx.id);
});

test('checkGuess tells row and column apart', () => {
  const real = bridge.cipher[0];
  assert.deepEqual(checkGuess(bridge, 0, real), { ok: true, row: true, col: true });
  const wrongCol = real[0] + ((Number(real[1]) + 1) % 10);
  assert.deepEqual(checkGuess(bridge, 0, wrongCol), { ok: false, row: true, col: false });
  const wrongRow = ((Number(real[0]) + 1) % 10) + real[1];
  assert.deepEqual(checkGuess(bridge, 0, wrongRow), { ok: false, row: false, col: true });
});

test('the bridge sentence decodes to team, CP4, reached, bridge, broken/repaired', () => {
  const words = bridge.groups.map((g) => cellById(bridge, decodeGroup(bridge, g).id).text);
  assert.deepEqual(words, ['team', 'CP4', 'reached', 'bridge', 'broken / repaired']);
});


// ---------- reading the message ----------

test('only the broken/repaired phrase is ambiguous in the bridge message', () => {
  assert.deepEqual(bridge.cipher.map((_, i) => isAmbiguous(bridge, i)), [false, false, false, false, true]);
});

test('a number slot reads the cell number itself; letters read as letters', () => {
  assert.deepEqual(meaningsOf(member, 2, '06'), ['06']);
  assert.equal(numberOf('06'), '06');
  assert.equal(numberOf('99'), '99');
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

