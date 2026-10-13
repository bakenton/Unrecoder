import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import {
  prepare, prepareReply, crewAt, cellById, digitOf, decodeGroup, checkGuess, groupIds, posOf, shownOf, groupIdAt, blankOf, lostHalf, fitsKey,
  scatter, relayout, meaningsOf, isAmbiguous, judgeReading, renderSentence, resolve, replyOptions, countReplies, canFinishReply,
  applyCrew, spendIntuition, gainIntuition, MASK, LOST, SENTENCE_KINDS,
} from './engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const act = JSON.parse(readFileSync(pathResolve(here, '../../../content/campaign/act1.json'), 'utf8'));
const txs = act.shifts.flatMap((shift, s) => shift.transmissions.map((_, i) => prepare(act, s, i)));
const drop = prepare(act, 0, 4); // the first message with an ambiguous phrase
const plain = prepare(act, 0, 0);

const sorted = (list) => [...list].sort();
/** A reading of `tx` from words by kind, e.g. {who: 'courier', state: ['burned', 'clean']}. */
const read = (tx, words) => Object.fromEntries(tx.slots.map((kind, i) => [i, [words[kind]].flat()]));
const truthOf = (tx) => Object.fromEntries(tx.cipher.map((id, i) => [i, [tx.truth[i] ?? meaningsOf(tx, id)[0]]]));

// ---------- the campaign ----------

test('the game is five shifts of five messages and one reply', () => {
  assert.equal(act.shifts.length, 5);
  for (const shift of act.shifts) {
    assert.equal(shift.transmissions.length, 5, shift.title);
    assert.ok(shift.title && shift.reply && Array.isArray(shift.briefing), shift.title);
  }
  assert.equal(new Set(txs.map((tx) => tx.id)).size, 25);
});

test('briefings add up: every shift starts from the agent list as the briefings so far left it', () => {
  assert.deepEqual(crewAt(act, 0), act.crew);
  assert.match(crewAt(act, 2).find((m) => m.id === '10').note, /warehouse/);
  assert.match(crewAt(act, 3).find((m) => m.id === '10').note, /warehouse/); // an old briefing still stands
  assert.equal(crewAt(act, 3).find((m) => m.id === '10').location, 'Warehouse');
  assert.equal(crewAt(act, 4).find((m) => m.id === '10').location, 'Market');
  assert.equal(crewAt(act, 3).find((m) => m.id === '05').status, 'ok');
  assert.equal(crewAt(act, 4).find((m) => m.id === '05').status, 'arrested');
  assert.equal(act.crew.find((m) => m.id === '05').status, 'ok'); // immutable
  for (const shift of act.shifts) for (const c of shift.briefing) assert.ok(act.crew.some((m) => m.id === c.id), `unknown agent ${c.id}`);
});

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

test('the matrix has every kind of the sentence grammar, plus letters, markers and service phrases', () => {
  const kinds = new Set(Object.values(act.matrix.cells).map((c) => c.kind));
  assert.deepEqual(sorted(kinds), sorted([...SENTENCE_KINDS, 'letter', 'marker', 'service']));
});

// ---------- the daily key and the groups ----------

test('each key covers 25 letters A-Y once, 2-3 per digit, and never uses the mask', () => {
  for (const tx of [...txs, ...act.shifts.map((s) => s.reply)]) {
    for (const half of [tx.key.rows, tx.key.cols]) {
      assert.equal(half.length, 10);
      assert.ok(half.every((ls) => ls.length === 2 || ls.length === 3));
      assert.deepEqual([...half.join('')].sort(), [...'ABCDEFGHIJKLMNOPQRSTUVWXY']);
      assert.ok(!half.join('').includes(MASK));
    }
  }
});

test('the key changes every message', () => {
  assert.equal(new Set(txs.map((tx) => JSON.stringify(tx.key))).size, txs.length);
});

test('digitOf looks a letter up in a key half', () => {
  const half = ['AB', 'CDE', 'FG', 'HI', 'JK', 'LM', 'NO', 'PQ', 'RS', 'TUV'];
  assert.equal(digitOf(half, 'D'), 1);
  assert.equal(digitOf(half, 'V'), 9);
  assert.equal(digitOf(half, 'Z'), -1);
});

test('decodeGroup rejects groups without the mask or with unknown letters', () => {
  assert.equal(decodeGroup(drop, 'AEQ'), null);
  assert.equal(decodeGroup(drop, 'ZZZ'), null);
  assert.equal(decodeGroup(drop, 'ZA'), null);
  assert.equal(decodeGroup(drop, 'ZA?'), null);
});

test('checkGuess tells row and column apart', () => {
  assert.deepEqual(checkGuess('18', '18'), { ok: true, row: true, col: true });
  assert.deepEqual(checkGuess('18', '19'), { ok: false, row: true, col: false });
  assert.deepEqual(checkGuess('18', '28'), { ok: false, row: false, col: true });
});

// ---------- the grammar ----------

test('every message has one phrase of each kind, and every blank of the sentence is one of them', () => {
  for (const tx of txs) {
    assert.deepEqual(sorted(tx.slots), sorted(SENTENCE_KINDS), tx.id);
    assert.deepEqual(tx.cipher.map((id) => cellById(tx, id).kind), tx.slots, tx.id);
    const blanks = tx.clauses.flatMap((c) => [...c.pattern.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])));
    assert.deepEqual(blanks, [0, 1, 2, 3, 4], `${tx.id}: blanks are numbered in sentence order`);
  }
});

test('the order of the kinds in the sentence changes from message to message', () => {
  assert.ok(new Set(txs.map((tx) => tx.slots.join())).size >= 4);
  assert.deepEqual(plain.slots, SENTENCE_KINDS, 'the very first message uses the plain order');
});

test('a message never contradicts the agent list: an agent named by job is where the list says', () => {
  act.shifts.forEach((shift, s) => {
    const crew = crewAt(act, s).filter((m) => m.status === 'ok');
    shift.transmissions.forEach((_, i) => {
      const tx = prepare(act, s, i);
      const word = (kind) => cellById(tx, tx.cipher[tx.slots.indexOf(kind)]).text;
      const sameJob = crew.filter((m) => m.role.toLowerCase() === word('who'));
      if (sameJob.length === 0) return; // a stranger, a patrol, a source: nobody on the list
      assert.ok(sameJob.some((m) => m.location.toLowerCase() === word('place')),
        `${tx.id}: the ${word('who')} is at the ${word('place')}, but the list has ${sameJob.map((m) => `${m.name} at ${m.location}`).join(', ')}`);
    });
  });
});

// ---------- the signal ----------

const starts = (tx) => groupIds(tx).map((id) => posOf(tx, id)).sort((a, b) => a - b);

function checkLayout(tx, label = tx.id) {
  assert.equal(tx.dump.length % tx.cols, 0);
  const zs = tx.dump.map((c, p) => (c === MASK ? p : -1)).filter((p) => p >= 0);
  assert.deepEqual(zs, starts(tx), `${label}: a Z that starts no group, or a group without its Z`);
  starts(tx).forEach((p, i, all) => {
    assert.ok(p % tx.cols <= tx.cols - 3, `${label}: group at ${p} wraps`);
    if (i > 0) assert.ok(p - all[i - 1] >= 4, `${label}: groups touch`);
  });
  for (const id of groupIds(tx)) assert.ok(fitsKey(tx, id), `${label}: group ${shownOf(tx, id)} does not point at ${id}`);
}

test('every Z in the signal starts a group, groups never wrap or touch, and their letters point at their cells', () => {
  for (const tx of txs) checkLayout(tx);
});

test('the signal is big enough to search and holds stray groups', () => {
  for (const tx of txs) {
    assert.ok(tx.dump.length >= 150, tx.id);
    assert.ok(tx.strayCipher.length >= 3, tx.id);
  }
});

test('stray groups stand for cells that fit no blank, and no cell is used twice', () => {
  for (const tx of txs) {
    assert.equal(new Set(groupIds(tx)).size, groupIds(tx).length, tx.id);
    for (const id of tx.strayCipher) {
      assert.ok(!SENTENCE_KINDS.includes(cellById(tx, id).kind), `${tx.id}: stray group ${id} fits a blank`);
      assert.equal(blankOf(tx, id), -1);
    }
    tx.cipher.forEach((id, k) => assert.equal(blankOf(tx, id), k));
  }
});

test('groupIdAt maps every letter of a group to it and noise to null', () => {
  for (const tx of txs) {
    const covered = new Set();
    for (const id of groupIds(tx)) [0, 1, 2].forEach((d) => { covered.add(posOf(tx, id) + d); assert.equal(groupIdAt(tx, posOf(tx, id) + d), id); });
    tx.dump.forEach((_, i) => { if (!covered.has(i)) assert.equal(groupIdAt(tx, i), null); });
  }
});

test('the first two messages are whole; damage grows over the shifts; only message groups lose a letter', () => {
  const damagedIn = (tx) => tx.cipher.filter((id) => lostHalf(tx, id)).length;
  assert.equal(damagedIn(prepare(act, 0, 0)), 0);
  assert.equal(damagedIn(prepare(act, 0, 1)), 0);
  assert.ok(damagedIn(prepare(act, 4, 4)) > damagedIn(prepare(act, 0, 4)));
  for (const tx of txs) {
    assert.equal(tx.dump.filter((c) => c === LOST).length, damagedIn(tx), tx.id);
    for (const id of tx.strayCipher) assert.equal(lostHalf(tx, id), null);
  }
});

test('a damaged group is a real choice: its known line holds at least two cells of its kind', () => {
  for (const tx of txs) {
    for (const id of tx.cipher.filter((x) => lostHalf(tx, x))) {
      const at = lostHalf(tx, id) === 'col' ? 0 : 1; // the digit that is still known
      const mates = Object.entries(tx.matrix.cells).filter(([other, c]) => other[at] === id[at] && c.kind === cellById(tx, id).kind);
      assert.ok(mates.length >= 2, `${tx.id}: ${id} is the only ${cellById(tx, id).kind} in its line`);
    }
  }
});

test('scatter places every group, honours pinned ones and gives up loudly when there is no room', () => {
  const { dump, at } = scatter(['ZAB', 'ZCD', 'Z?E'], 8, 3, Math.random, { 1: 9 });
  assert.equal(dump.length, 24);
  assert.equal(at[1], 9);
  at.forEach((p, i) => assert.equal(dump.slice(p, p + 3).join(''), ['ZAB', 'ZCD', 'Z?E'][i]));
  assert.throws(() => scatter(['ZAB', 'ZCD', 'ZEF'], 4, 1, Math.random));
});

test('relayout moves the groups but keeps the message: same groups, valid layout, kept groups stay put', () => {
  for (const tx of txs) {
    const keep = [tx.cipher[0], tx.strayCipher[0]];
    let moved = false;
    for (let n = 0; n < 5; n++) {
      const next = relayout(tx, keep, Math.random);
      checkLayout(next, `${tx.id} relayout`);
      assert.deepEqual(groupIds(next).map((id) => shownOf(next, id)), groupIds(tx).map((id) => shownOf(tx, id)));
      for (const id of keep) assert.equal(posOf(next, id), posOf(tx, id));
      moved ||= groupIds(tx).some((id) => posOf(next, id) !== posOf(tx, id));
    }
    assert.ok(moved, tx.id);
  }
});

// ---------- reading the message ----------

const WORDS = { who: 'courier', place: 'harbour', action: 'left the package', result: 'awaiting pickup' };
const A = read(drop, { ...WORDS, state: 'burned' });
const B = read(drop, { ...WORDS, state: 'clean' });
const H = read(drop, { ...WORDS, state: ['burned', 'clean'] });

test('exactly one message per shift has an ambiguous phrase, and it is the last one', () => {
  act.shifts.forEach((shift, s) => {
    const ambiguous = shift.transmissions.map((_, i) => prepare(act, s, i)).map((tx) => tx.cipher.some((_, k) => isAmbiguous(tx, k)));
    assert.deepEqual(ambiguous, [false, false, false, false, true], shift.title);
  });
});

test('judgeReading and renderSentence on the drop message', () => {
  assert.equal(judgeReading(drop, {}), 'incomplete');
  assert.equal(judgeReading(drop, A), 'correct');
  assert.equal(judgeReading(drop, B), 'wrong');
  assert.equal(judgeReading(drop, H), 'hedged');
  assert.equal(renderSentence(drop, A), 'At the harbour the courier left the package. Next: awaiting pickup. Status: burned.');
  assert.equal(renderSentence(drop, H), 'At the harbour the courier left the package. Next: awaiting pickup. Status: burned / clean.');
  assert.equal(renderSentence(drop, {}), 'At the ___ the ___ ___. Next: ___. Status: ___.');
});

test('the context that settles the drop message is in the agent list', () => {
  assert.ok(act.crew.some((m) => m.status === 'arrested' && /harbour/.test(m.note)));
});

test('filing the drop message: the right reading is safe and earns Intuition, the wrong one loses an agent', () => {
  const ok = resolve(drop, A);
  assert.equal(ok.severity, 'safe');
  assert.equal(ok.intuitionGain, 1);
  assert.deepEqual(ok.crew, []);
  const bad = resolve(drop, B);
  assert.equal(bad.severity, 'harm');
  assert.equal(bad.intuitionGain, 0);
  assert.equal(bad.crew.length, 1);
});

test('hedging costs time, harms nobody and earns nothing', () => {
  const soft = resolve(drop, H);
  assert.equal(soft.severity, 'delay');
  assert.deepEqual(soft.crew, []);
  assert.equal(soft.intuitionGain, 0);
});

test('every message can be filed with its true reading, and that is always safe', () => {
  for (const tx of txs) {
    const r = resolve(tx, truthOf(tx));
    assert.equal(r.reading, 'correct', tx.id);
    assert.equal(r.severity, 'safe', tx.id);
  }
});

test('every reading a message allows has an outcome; ambiguous messages explain themselves and name real agents', () => {
  for (const tx of txs) {
    const ambiguous = Object.keys(tx.truth).length > 0;
    assert.deepEqual(sorted(Object.keys(tx.outcomes)), ambiguous ? ['correct', 'hedged', 'wrong'] : ['correct'], tx.id);
    assert.equal(Boolean(tx.hint), ambiguous, tx.id);
    for (const [at, word] of Object.entries(tx.truth)) assert.ok(meaningsOf(tx, tx.cipher[at]).includes(word), tx.id);
    for (const o of Object.values(tx.outcomes)) {
      assert.ok(o.text && ['safe', 'delay', 'harm'].includes(o.severity), tx.id);
      for (const c of o.crew) assert.ok(act.crew.some((m) => m.id === c.id), `${tx.id}: unknown agent ${c.id}`);
    }
  }
});

test('resolve rejects incomplete readings', () => {
  assert.throws(() => resolve(drop, {}));
});

test('agent and Intuition helpers', () => {
  const next = applyCrew(act.crew, drop.outcomes.wrong.crew);
  assert.equal(next.find((m) => m.id === '06').status, 'arrested');
  assert.equal(next.find((m) => m.id === '06').location, 'Station'); // a change without a location keeps it
  assert.equal(act.crew.find((m) => m.id === '06').status, 'ok'); // immutable
  assert.equal(spendIntuition(0), null);
  assert.equal(spendIntuition(3), 2);
  assert.equal(gainIntuition(5, 1), 5);
});

// ---------- the reply ----------

const KEY = { rows: ['AB', 'CD', 'EF', 'GH', 'IJ', 'KL', 'MN', 'OP', 'QR', 'STU'], cols: ['BA', 'DC', 'FE', 'HG', 'JI', 'LK', 'NM', 'PO', 'RQ', 'UTS'] };

test('replyOptions pairs a row letter with a column letter, never the same letter twice, never a used one', () => {
  assert.deepEqual(replyOptions(KEY, '00'), [['A', 'B'], ['B', 'A']]);
  assert.deepEqual(replyOptions(KEY, '01'), [['A', 'D'], ['A', 'C'], ['B', 'D'], ['B', 'C']]);
  assert.deepEqual(replyOptions(KEY, '01', 'AD'), [['B', 'C']]);
  assert.deepEqual(replyOptions(KEY, '00', 'A'), []);
});

test('countReplies and canFinishReply see dead ends: two phrases in cell 00 cannot both go out', () => {
  assert.equal(countReplies(KEY, ['00']), 2);
  assert.equal(countReplies(KEY, ['00', '00']), 0);
  assert.equal(canFinishReply(KEY, ['00', '11']), true);
  assert.equal(canFinishReply(KEY, ['11', '22'], 'AB'), true);
  assert.equal(canFinishReply(KEY, ['01'], 'AB'), false);
  assert.equal(canFinishReply(KEY, []), true);
});

test('every reply has one phrase of each kind, can be encoded, and most careless letter choices fail', () => {
  act.shifts.forEach((shift, s) => {
    const reply = prepareReply(act, s);
    assert.deepEqual(sorted(reply.slots), sorted(SENTENCE_KINDS), shift.title);
    assert.deepEqual(reply.cipher.map((id) => cellById(reply, id).kind), reply.slots);
    const ways = countReplies(reply.key, reply.cipher);
    const free = reply.cipher.reduce((n, id) => n * replyOptions(reply.key, id).length, 1);
    assert.ok(ways >= 1, `${shift.title}: the reply cannot be encoded`);
    assert.ok(ways / free < 0.5, `${shift.title}: too easy, ${ways} of ${free} choices work`);
  });
});
