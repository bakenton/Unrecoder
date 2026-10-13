// Builds content/campaign/act1.json from the definitions below: the agents, the 10x10 code table, and the shifts.
// A shift is a briefing (what changed for the agents), five messages to decode and one reply to encode. For each
// message the script makes its daily key and its signal (the message groups, some of them with a lost letter, and
// stray groups, scattered among noise letters). Seeded, so running it again gives the same file.
// Usage: node content/tools/make_act1.mjs
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MASK, LOST, NOISE, SENTENCE_KINDS, scatter, fitsKey, replyOptions, countReplies } from '../../prototype/src/core/engine.js';

const path = resolve(dirname(fileURLToPath(import.meta.url)), '../campaign/act1.json');

const agent = (id, name, role, location, status = 'ok', note = '') => ({ id, name, role, location, status, note });
const crew = [
  agent('01', 'FINCH', 'Courier', 'Harbour'),
  agent('02', 'HERON', 'Resident', 'Embassy'),
  agent('03', 'WREN', 'Radio operator', 'Safe house'),
  agent('04', 'CROW', 'Watcher', 'Unknown', 'arrested', 'arrested last night; knew the harbour dead drop'),
  agent('05', 'ROOK', 'Watcher', 'Border'),
  agent('06', 'SWIFT', 'Pickup man', 'Station'),
  agent('07', 'DOVE', 'Contact', 'Border'),
  agent('08', 'KITE', 'Driver', 'Hotel'),
  agent('09', 'LARK', 'Cipher clerk', 'Embassy'),
  agent('10', 'OWL', 'Informer', 'Market'),
];

// The code table. A phrase with " / " has two meanings under one code.
const WORDS = {
  who: ['courier', 'resident', 'watcher', 'radio operator', 'contact', 'informer', 'driver', 'cipher clerk', 'stranger', 'patrol', 'source', 'double agent'],
  place: ['harbour', 'station', 'embassy', 'safe house', 'border', 'bridge', 'hotel', 'market', 'church', 'airfield', 'warehouse', 'cafe', 'park', 'post office'],
  action: ['left the package', 'picked up the package', 'met the contact', 'was followed', 'was searched', 'burned the papers', 'crossed over',
    'missed the meeting', 'changed the route', 'saw the patrol', 'sent the film', 'lost the tail', 'was stopped', 'waited in vain'],
  state: ['burned / clean', 'arrested / free', 'guarded / empty', 'unharmed', 'wounded', 'watched', 'intact', 'exposed', 'closed', 'quiet', 'secure', 'lost'],
  result: ['awaiting pickup', 'requests extraction', 'going silent', 'meeting cancelled', 'next contact in two days', 'needs new papers', 'needs money',
    'switching to backup', 'will try again', 'operation continues', 'send no one', 'awaiting orders'],
  service: ['radio check', 'say again', 'understood', 'no reply', 'stand by', 'over', 'out', 'end of message'],
  marker: ['number', 'spell'],
  letter: [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
};

// The grammar is always the same five kinds, but their order in the sentence changes from message to message.
const TEMPLATES = {
  A: 'The {who} at the {place} {action}. Status: {state}. Next: {result}.',
  B: 'At the {place} the {who} {action}. Next: {result}. Status: {state}.',
  C: 'Status: {state}. The {who} {action} at the {place}. Next: {result}.',
  D: 'Next: {result}. Status: {state}. The {who} {action} at the {place}.',
  E: 'The {who} {action}. Place: the {place}. Next: {result}. Status: {state}.',
};

const out = (severity, text, crewChanges = []) => ({ severity, text, crew: crewChanges });
const lost = (id, note) => ({ id, status: 'arrested', note });
// When the "who" of a message is the job of an agent on the list, the place is where that agent is at the time:
// the list and the map must never contradict a message, because lost letters are worked out from them.
/** A message: template, then who, place, action, state, result. `twist` is given when the state has two meanings. */
const msg = (time, template, who, place, action, state, result, twist = null) => ({ time, template, words: { who, place, action, state, result }, twist });

const SHIFTS = [
  {
    title: 'First night', briefing: [], stray: 3, damaged: [0, 0, 1, 1, 1],
    messages: [
      msg('06:40', 'A', 'informer', 'market', 'was followed', 'unharmed', 'will try again'),
      msg('08:05', 'A', 'watcher', 'border', 'saw the patrol', 'quiet', 'operation continues'),
      msg('11:15', 'B', 'driver', 'hotel', 'lost the tail', 'secure', 'awaiting orders'),
      msg('15:30', 'C', 'resident', 'embassy', 'burned the papers', 'exposed', 'going silent'),
      msg('19:50', 'B', 'courier', 'harbour', 'left the package', 'burned / clean', 'awaiting pickup', {
        truth: 'burned',
        hint: 'CROW (04) was arrested last night and knew the harbour dead drop. A site an arrested agent knows cannot be clean: it is burned.',
        correct: out('safe', 'Command kept everyone away from the harbour. Two men in a parked car waited there all night.'),
        hedged: out('delay', 'Command got both readings and chose to wait. A day lost, nobody caught.'),
        wrong: out('harm', 'Command read the site as clean and sent the pickup man. He was arrested at the harbour.', [lost('06', 'arrested at the harbour')]),
      }),
    ],
    reply: ['contact', 'safe house', 'changed the route', 'secure', 'next contact in two days'],
  },
  {
    title: 'The border', briefing: [{ id: '08', note: 'phoned in from the hotel after the checkpoint' }], stray: 4, damaged: [1, 1, 1, 2, 2],
    messages: [
      msg('05:20', 'C', 'contact', 'border', 'crossed over', 'wounded', 'requests extraction'),
      msg('09:45', 'E', 'informer', 'market', 'saw the patrol', 'watched', 'meeting cancelled'),
      msg('12:10', 'D', 'radio operator', 'safe house', 'sent the film', 'intact', 'next contact in two days'),
      msg('16:00', 'A', 'cipher clerk', 'embassy', 'was searched', 'unharmed', 'needs new papers'),
      msg('21:30', 'E', 'driver', 'hotel', 'was stopped', 'arrested / free', 'will try again', {
        truth: 'free',
        hint: 'An arrested driver cannot try again, and KITE (08) phoned in from the hotel after the checkpoint: the driver is free.',
        correct: out('safe', 'Command left the driver alone. KITE made the run the next night.'),
        hedged: out('delay', 'Command got both readings and froze the route for a day. KITE waited at the hotel.'),
        wrong: out('harm', 'Command read the driver as arrested and burned the route. KITE was left without orders or papers.', [{ id: '08', status: 'cut off', note: 'route burned by mistake' }]),
      }),
    ],
    reply: ['courier', 'station', 'picked up the package', 'intact', 'operation continues'],
  },
  {
    title: 'The warehouse', briefing: [{ id: '10', location: 'Warehouse', note: 'moved to watch the warehouse; says it has had no guards since Monday' }], stray: 5, damaged: [1, 2, 2, 2, 2],
    messages: [
      msg('04:55', 'D', 'source', 'church', 'met the contact', 'quiet', 'next contact in two days'),
      msg('08:30', 'B', 'stranger', 'cafe', 'was followed', 'watched', 'switching to backup'),
      msg('13:00', 'C', 'courier', 'harbour', 'picked up the package', 'intact', 'operation continues'),
      msg('17:20', 'E', 'double agent', 'hotel', 'missed the meeting', 'lost', 'send no one'),
      msg('22:15', 'D', 'informer', 'warehouse', 'waited in vain', 'guarded / empty', 'needs money', {
        truth: 'empty',
        hint: 'OWL (10) says the warehouse has had no guards since Monday, and nobody came: the warehouse is empty.',
        correct: out('safe', 'Command wrote the warehouse off. Nobody wasted another night there.'),
        hedged: out('delay', 'Command got both readings and sent a watcher to look first. A day lost.'),
        wrong: out('harm', 'Command read the warehouse as guarded and sent a team to break in. They found bare walls and were seen leaving.', [{ id: '10', status: 'exposed', note: 'seen with the team at the warehouse' }]),
      }),
    ],
    reply: ['watcher', 'bridge', 'lost the tail', 'quiet', 'will try again'],
  },
  {
    title: 'The embassy', briefing: [{ id: '02', note: 'cover blown last week; the embassy rooms were searched' }, { id: '05', location: 'Airfield', note: 'moved to watch the airfield' }], stray: 5, damaged: [2, 2, 2, 2, 2],
    messages: [
      msg('06:10', 'E', 'resident', 'embassy', 'changed the route', 'exposed', 'switching to backup'),
      msg('10:40', 'D', 'radio operator', 'safe house', 'waited in vain', 'quiet', 'will try again'),
      msg('14:25', 'B', 'watcher', 'airfield', 'saw the patrol', 'watched', 'send no one'),
      msg('18:00', 'C', 'source', 'post office', 'sent the film', 'secure', 'awaiting orders'),
      msg('23:05', 'A', 'cipher clerk', 'embassy', 'left the package', 'burned / clean', 'awaiting pickup', {
        truth: 'burned',
        hint: 'The embassy rooms were searched after the cover of HERON (02) was blown. Nothing left there is clean: the site is burned.',
        correct: out('safe', 'Command sent nobody to the embassy. The package was written off.'),
        hedged: out('delay', 'Command got both readings and waited. The package stayed where it was.'),
        wrong: out('harm', 'Command read the site as clean and sent the pickup man to the embassy. He was arrested at the gate.', [lost('06', 'arrested at the embassy gate')]),
      }),
    ],
    reply: ['driver', 'airfield', 'crossed over', 'unharmed', 'awaiting pickup'],
  },
  {
    title: 'Going dark',
    briefing: [{ id: '05', status: 'arrested', note: 'arrested this morning; knew the border meeting place' }, { id: '10', location: 'Market', note: 'back at the market' }],
    stray: 6, damaged: [2, 2, 2, 3, 3],
    messages: [
      msg('05:05', 'D', 'driver', 'hotel', 'lost the tail', 'unharmed', 'operation continues'),
      msg('09:15', 'C', 'informer', 'market', 'was stopped', 'wounded', 'requests extraction'),
      msg('13:40', 'E', 'double agent', 'bridge', 'changed the route', 'secure', 'next contact in two days'),
      msg('18:30', 'B', 'source', 'church', 'burned the papers', 'closed', 'going silent'),
      msg('23:50', 'C', 'contact', 'border', 'missed the meeting', 'arrested / free', 'send no one', {
        truth: 'arrested',
        hint: 'ROOK (05) was arrested this morning and knew the border meeting place. The contact missed the meeting and the message says to send no one: arrested.',
        correct: out('safe', 'Command sent no one to the border and closed the line. Nobody else was lost.'),
        hedged: out('delay', 'Command got both readings and held everyone back for a day.'),
        wrong: out('harm', 'Command read the contact as free and sent the driver to the border. He drove into the same trap.', [lost('08', 'arrested at the border')]),
      }),
    ],
    reply: ['resident', 'church', 'burned the papers', 'closed', 'going silent'],
  },
];

const COLS = 16;
const ROWS = 10;

function rng(seed) { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (arr, r) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
const pick = (arr, r) => arr[Math.floor(r() * arr.length)];

function makeMatrix() {
  const entries = Object.entries(WORDS).flatMap(([kind, words]) => words.map((text) => ({ kind, text, meanings: text.split(' / ') })));
  if (entries.length !== 100) throw new Error(`The table needs 100 cells, got ${entries.length}`);
  shuffle(entries, rng(42));
  return { rows: '0123456789', cols: '0123456789', cells: Object.fromEntries(entries.map((e, i) => [String(i).padStart(2, '0'), e])) };
}

// 25 letters (A-Y; Z is the mask) over 10 digits: five digits own 3 letters, five own 2.
function makeKeyHalf(r) {
  const letters = shuffle([...NOISE], r);
  const sizes = shuffle([3, 3, 3, 3, 3, 2, 2, 2, 2, 2], r);
  let at = 0;
  return sizes.map((n) => { const part = letters.slice(at, at + n).sort().join(''); at += n; return part; });
}

/** A group (Z + two letters) for cell `id`: one letter from each key half, never the same group twice. */
function groupFor(key, id, r, used) {
  const options = [];
  for (const a of key.rows[Number(id[0])]) for (const b of key.cols[Number(id[1])]) options.push(MASK + a + b);
  const g = pick(options.filter((o) => !used.has(o)), r);
  used.add(g);
  return g;
}

/**
 * Which message groups lose a letter. A lost letter leaves one line of the table (a row or a column); it is only
 * worth losing where that line holds two or more cells of the phrase's kind, so colour alone does not settle it.
 * Place and who come first: the agent list says who is where, so the choice can be reasoned out.
 */
function chooseDamage(matrix, cipher, count) {
  const options = [];
  cipher.forEach((id, k) => {
    const cell = matrix.cells[id];
    if (cell.meanings.length > 1) return;
    for (const [lostHalf, at] of [['col', 0], ['row', 1]]) {
      const mates = Object.keys(matrix.cells).filter((other) => other[at] === id[at] && matrix.cells[other].kind === cell.kind).length;
      if (mates >= 2) options.push({ k, lost: lostHalf, mates, rank: ['place', 'who', 'action', 'result', 'state'].indexOf(cell.kind) });
    }
  });
  options.sort((a, b) => a.rank - b.rank || b.mates - a.mates);
  const chosen = [];
  for (const o of options) if (chosen.length < count && !chosen.some((c) => c.k === o.k)) chosen.push(o);
  if (chosen.length < count) throw new Error('Not enough groups worth damaging');
  return chosen;
}

const matrix = makeMatrix();
const idOf = (text) => {
  const id = Object.keys(matrix.cells).find((k) => matrix.cells[k].text === text);
  if (!id) throw new Error(`Not in the table: ${text}`);
  return id;
};

function makeMessage(shift, s, m, n) {
  const r = rng(1000 + s * 1000 + n * 77);
  const key = { rows: makeKeyHalf(r), cols: makeKeyHalf(r) };
  // the blanks are numbered in the order the kinds appear in the sentence
  const slots = [...TEMPLATES[m.template].matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
  const pattern = TEMPLATES[m.template].replace(/\{(\w+)\}/g, (_, kind) => `{${slots.indexOf(kind)}}`);
  const cipher = slots.map((kind) => idOf(m.words[kind]));
  // stray groups decode to cells no blank can take: service phrases, markers, letters
  const strayIds = shuffle(Object.keys(matrix.cells).filter((id) => !SENTENCE_KINDS.includes(matrix.cells[id].kind)), r).slice(0, shift.stray);
  const used = new Set();
  const groups = [...cipher, ...strayIds].map((id) => groupFor(key, id, r, used));
  const damage = chooseDamage(matrix, cipher, shift.damaged[n]);
  for (const d of damage) groups[d.k] = d.lost === 'row' ? MASK + LOST + groups[d.k][2] : groups[d.k].slice(0, 2) + LOST;
  const { dump, at } = scatter(groups, COLS, ROWS, r);
  const at3 = slots.indexOf('state');
  const tx = {
    id: `S${s + 1}-M${n + 1}`, time: m.time, slots, cipher, clauses: pattern.split(/(?<=\.) /).map((p) => ({ pattern: p })),
    truth: m.twist ? { [at3]: m.twist.truth } : {}, hint: m.twist?.hint ?? '',
    key, cols: COLS, dump, real: at.slice(0, cipher.length), strayCipher: strayIds, stray: at.slice(cipher.length),
    outcomes: m.twist
      ? { correct: m.twist.correct, hedged: m.twist.hedged, wrong: m.twist.wrong }
      : { correct: out('safe', 'Filed. Command has the message as the agent sent it.') },
  };
  if (![...cipher, ...strayIds].every((id) => fitsKey({ ...tx, matrix }, id))) throw new Error(`${tx.id}: a group does not point at its cell`);
  console.log(`${tx.id}: ${groups.join(' ')} | lost: ${damage.map((d) => `${slots[d.k]} ${d.lost} (${d.mates} fit)`).join(', ') || 'none'}`);
  return tx;
}

/**
 * The reply key is searched for, not just drawn: the reply must be possible without repeating a letter, but most
 * careless choices must run into a dead end, so that picking letters takes a little planning.
 */
function makeReply(words, s) {
  const cipher = words.map(idOf);
  let best = null;
  for (let seed = 0; seed < 4000; seed++) {
    const r = rng(9000 + s * 5000 + seed);
    const key = { rows: makeKeyHalf(r), cols: makeKeyHalf(r) };
    const ways = countReplies(key, cipher);
    if (ways === 0) continue;
    const free = cipher.reduce((n, id) => n * replyOptions(key, id).length, 1);
    if (!best || ways / free < best.ways / best.free) best = { key, ways, free };
    if (ways / free < 0.25) break;
  }
  console.log(`S${s + 1} reply: ${best.ways} of ${best.free} letter choices work`);
  return { time: '23:59', slots: cipher.map((id) => matrix.cells[id].kind), cipher, key: best.key };
}

const shifts = SHIFTS.map((shift, s) => ({
  title: shift.title,
  briefing: shift.briefing,
  transmissions: shift.messages.map((m, n) => makeMessage(shift, s, m, n)),
  reply: makeReply(shift.reply, s),
}));

writeFileSync(path, JSON.stringify({ crew, matrix, shifts }, null, 1) + '\n');
console.log('Wrote', path);
