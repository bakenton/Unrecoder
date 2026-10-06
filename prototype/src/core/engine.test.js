import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import {
  prepare, cellById, numberOf, digitOf, decodeGroup, checkGuess, groupAt, candidates, nextCandidate, parses, isRealMessage, meaningsOf, isAmbiguous, judgeReading,
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

test('decodeGroup rejects groups without the mask or with unknown letters', () => {
  assert.equal(decodeGroup(bridge, 'AEQ'), null);
  assert.equal(decodeGroup(bridge, 'ZZZ'), null);
  assert.equal(decodeGroup(bridge, 'ZA'), null);
  assert.equal(decodeGroup(bridge, 'ZA?'), null);
});

test('checkGuess tells row and column apart', () => {
  assert.deepEqual(checkGuess('18', '18'), { ok: true, row: true, col: true });
  assert.deepEqual(checkGuess('18', '19'), { ok: false, row: true, col: false });
  assert.deepEqual(checkGuess('18', '28'), { ok: false, row: false, col: true });
});

// ---------- the signal ----------

test('the signal is a full grid; the real groups sit at tx.real, in reading order, and decode to the cipher', () => {
  for (const tx of txs) {
    assert.equal(tx.dump.length % tx.cols, 0);
    assert.equal(tx.real.length, tx.cipher.length);
    assert.deepEqual([...tx.real].sort((a, b) => a - b), tx.real);
    tx.real.forEach((p, i) => assert.equal(groupAt(tx, p).id, tx.cipher[i], `${tx.id} group ${i}`));
  }
});

test('every Z in the signal starts a group: real ones and decoys, and no Z is hidden elsewhere', () => {
  for (const tx of txs) {
    const zs = tx.dump.map((c, p) => (c === 'Z' ? p : -1)).filter((p) => p >= 0);
    assert.deepEqual(zs, candidates(tx), tx.id);
    assert.ok(zs.length > tx.real.length, `${tx.id}: no decoys`);
    for (const p of tx.real) assert.ok(zs.includes(p));
  }
});

test('groups never wrap around a row and never overlap', () => {
  for (const tx of txs) {
    const c = candidates(tx);
    c.forEach((p, i) => {
      assert.ok(p % tx.cols <= tx.cols - 3, `${tx.id}: group at ${p} wraps`);
      if (i > 0) assert.ok(p - c[i - 1] >= 3, `${tx.id}: groups overlap`);
    });
  }
});

test('damaged groups show "?" but still decode through their lost letter; only real groups are damaged', () => {
  const damaged = txs.filter((tx) => Object.keys(tx.damaged).length);
  assert.ok(damaged.length >= 1);
  for (const tx of txs) {
    for (const [at, letter] of Object.entries(tx.damaged)) {
      assert.equal(tx.dump[at], '?');
      assert.ok(/[A-Y]/.test(letter));
      const start = tx.real.find((p) => at >= p && at < p + 3);
      assert.notEqual(start, undefined, `${tx.id}: a decoy is damaged`);
      assert.equal(groupAt(tx, start).damaged, true);
    }
    assert.equal(tx.dump.filter((c) => c === '?').length, Object.keys(tx.damaged).length);
  }
});

test('a damaged group can be found by kind: its cell is the only one of that kind in the known row or column', () => {
  for (const tx of txs) {
    for (const at of Object.keys(tx.damaged)) {
      const start = tx.real.find((p) => at >= p && at < p + 3);
      const g = groupAt(tx, start);
      const lostCol = at - start === 2;
      const same = Object.entries(tx.matrix.cells).filter(([id, c]) => (lostCol ? id[0] === g.id[0] : id[1] === g.id[1]) && c.kind === g.cell.kind);
      assert.equal(same.length, 1, `${tx.id}: ${g.id} is not unique in its ${lostCol ? 'row' : 'column'}`);
    }
  }
});

/** Every set of groups (start positions) that reads as the message grammar. */
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

test('each signal has exactly one reading that fits the grammar: the real message', () => {
  for (const tx of txs) assert.deepEqual(solutions(tx), [tx.real], tx.id);
});

test('parses: the real groups fit; a decoy swapped in or a missing group does not', () => {
  for (const tx of txs) {
    assert.equal(parses(tx, tx.real), true, tx.id);
    assert.equal(parses(tx, tx.real.slice(1)), false);
    const decoy = candidates(tx).find((p) => !tx.real.includes(p));
    assert.equal(parses(tx, [decoy, ...tx.real.slice(1)]) && !isRealMessage(tx, [decoy, ...tx.real.slice(1)]), false, tx.id);
    assert.equal(isRealMessage(tx, tx.real), true);
  }
});

test('a number or a spelled letter must be the group directly after the previous one', () => {
  for (const tx of [member, hut]) {
    const i = tx.slots.findIndex((s) => s === 'number' || s === 'letter');
    assert.equal(nextCandidate(tx, tx.real[i - 1]), tx.real[i], tx.id);
  }
});

test('the bridge sentence decodes to team, CP4, reached, bridge, broken/repaired', () => {
  const words = bridge.real.map((p) => groupAt(bridge, p).cell.text);
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

