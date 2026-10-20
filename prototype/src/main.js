import {
  MAX_INTUITION, MASK, LOST, prepare, prepareReply, crewAt, cellById, digitOf, groupIdAt, blankOf, shownOf, lostHalf, relayout, checkGuess,
  meaningsOf, judgeReading, renderSentence, resolve, canFinishReply, applyCrew, spendIntuition, gainIntuition,
} from './core/engine.js';

const START_INTUITION = 3;
const SAVE_KEY = 'unrecoder-progress-v1';
const LOG_KEY = 'unrecoder-log-v1';
const LOG_LIMIT = 4000; // events kept; the oldest are dropped first

const $ = (id) => document.getElementById(id);

let act;
let progress = loadProgress(); // {done: {shift: {read, mistakes, replyMistakes}}, muted, introduced, toured}: what survives between sessions
let shiftIndex = null; // the shift in progress, or null while the player is only at the desk
let shiftLog; // per message of the shift in progress: {reading, mistakes}
let mode; // 'message': decoding what the agents sent; 'reply': encoding an order from command, at the end of the shift
let txIndex = 0;
let tx; // the current message; its signal is laid out again after every wrong guess
let state; // the message being decoded
let reply; // the reply being encoded
let start; // {crew, intuition} at the start of the current message, for Replay

function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (saved && typeof saved.done === 'object') return { done: saved.done, muted: Boolean(saved.muted), introduced: Boolean(saved.introduced), toured: Boolean(saved.toured) };
  } catch { /* no storage, or nothing saved: start fresh */ }
  return { done: {}, muted: false, introduced: false, toured: false };
}

function saveProgress() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(progress)); } catch { /* play on without saving */ }
}

// ---------- the game log: every click that matters, for playtest feedback ----------

let gameLog = loadLog();

function loadLog() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOG_KEY));
    if (Array.isArray(saved)) return saved;
  } catch { /* no storage, or nothing saved */ }
  return [];
}

/** Record one event, stamped with the time and with where in the game it happened. */
function logEvent(type, data = {}) {
  const where = shiftIndex === null ? {} : { shift: shiftIndex + 1, part: mode === 'reply' ? 'reply' : `message ${txIndex + 1}` };
  gameLog.push({ t: new Date().toISOString(), type, ...where, ...data });
  if (gameLog.length > LOG_LIMIT) gameLog = gameLog.slice(-LOG_LIMIT);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(gameLog)); } catch { /* keep it in memory only */ }
  if (act) renderLogBar();
}

function renderLogBar() {
  $('logCount').textContent = `${gameLog.length} events`;
  $('logSave').disabled = gameLog.length === 0;
  $('logClear').disabled = gameLog.length === 0;
}

/** Save the log as a JSON file, together with the progress it led to. */
function exportLog() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const file = new Blob([JSON.stringify({ exported: new Date().toISOString(), progress, events: gameLog }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = `unrecoder-log-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function boot() {
  try {
    // The standalone build embeds the content; the dev page fetches it from ../content.
    act = window.__ACT__ ?? await (await fetch('../content/campaign/act1.json')).json();
  } catch (err) {
    showFatal(`Could not load the game content (${err.message}). Start the local server from the repository root ` +
      '(python -m http.server 5173) and open http://localhost:5173/prototype/index.html — or open ' +
      'prototype/unrecoder-standalone.html, which needs no server.');
    return;
  }
  state = { crew: crewAt(act, 0) }; // enough to draw the map before any shift is open
  logEvent('session_start', { shiftsFiled: Object.keys(progress.done).length });
  openFolder(false);
  if (!progress.introduced && Object.keys(progress.done).length === 0) {
    $('intro').hidden = false;
    logEvent('intro_shown');
  }
}

function showFatal(message) {
  const el = document.createElement('p');
  el.className = 'fatal';
  el.textContent = message;
  document.body.prepend(el);
}

// ---------- the desk: one folder per shift ----------

function isUnlocked(s) {
  return s === 0 || Boolean(progress.done[s - 1]);
}

function renderDesk() {
  $('shelf').replaceChildren(...act.shifts.map((shift, s) => {
    const done = progress.done[s];
    const open = shiftIndex === s;
    const b = btn('', () => onShiftFolder(s), !isUnlocked(s), 'shift-folder' + (done ? ' done' : '') + (open ? ' open' : '') + (isUnlocked(s) ? '' : ' locked'));
    const status = open ? `${mode === 'reply' ? 'reply' : `message ${txIndex + 1} of ${shift.transmissions.length}`} — continue`
      : done ? `${done.read}/${shift.transmissions.length} read right · ${done.mistakes + done.replyMistakes} wrong`
        : isUnlocked(s) ? 'click to open' : 'locked';
    b.innerHTML = `<b>SHIFT ${s + 1}</b><span class="stitle">${shift.title}</span><span class="sstatus">${status}</span>${done ? '<i class="filed">FILED</i>' : ''}`;
    return b;
  }));
}

function onShiftFolder(s) {
  if (shiftIndex === s) return openFolder(true);
  shiftIndex = s;
  shiftLog = [];
  txIndex = 0;
  start = { crew: crewAt(act, s), intuition: START_INTUITION };
  logEvent('shift_start', { title: act.shifts[s].title });
  begin();
}

function finishShift() {
  const total = (pickOf) => shiftLog.reduce((n, m) => n + pickOf(m), 0);
  progress.done[shiftIndex] = { read: total((m) => (m.reading === 'correct' ? 1 : 0)), mistakes: total((m) => m.mistakes), replyMistakes: reply.mistakes };
  saveProgress();
  logEvent('shift_done', progress.done[shiftIndex]);
  shiftIndex = null;
  openFolder(false);
}

function openFolder(open) {
  document.body.classList.toggle('folder-open', open && shiftIndex !== null);
  renderDesk();
  renderWall();
  advise();
}

// ---------- a message ----------

function begin() {
  mode = 'message';
  tx = prepare(act, shiftIndex, txIndex);
  state = {
    phase: 'find', // 'find' -> 'read' -> 'sent'
    crew: start.crew,
    intuition: start.intuition,
    // Groups are named by the cell they stand for, so they keep their name when the signal is shuffled.
    decoded: [], // groups the player has decoded
    selected: null, // the group being decoded
    tried: {}, // group -> wrong cell ids clicked for it
    known: {}, // group -> {row, col}: which half of the cell the player has already hit
    mistakes: 0,
    feedback: null, // {tone: 'ok' | 'bad' | 'stray', text}: the result of the last click
    flash: null, // blank that was just filled (animated once)
    shuffled: false, // the signal was just laid out again (animated once)
    selection: {}, // blank -> chosen words
    hedge: {}, // blank -> bool
  };
  logEvent('message_start', { id: tx.id });
  renderAll();
  openFolder(true);
  if (shiftIndex === 0 && txIndex === 0 && !progress.toured) startTour();
}

function beginReply() {
  mode = 'reply';
  tx = prepareReply(act, shiftIndex);
  reply = {
    groups: {}, // phrase index -> the group built for it, e.g. "ZAB"
    selected: 0, // phrase being encoded
    rowLetter: null, // the row letter already chosen for the selected phrase
    mistakes: 0,
    stuck: false, // the letters left cannot finish the reply
    feedback: null,
    sent: false,
  };
  logEvent('reply_start');
  renderAll();
  openFolder(true);
}

function renderAll() {
  const isReply = mode === 'reply';
  const count = act.shifts[shiftIndex].transmissions.length;
  $('tabLabel').textContent = `SHIFT ${shiftIndex + 1} · ` + (isReply ? 'REPLY TO THE AGENTS' : `MESSAGE ${txIndex + 1} OF ${count}`);
  $('txTime').textContent = isReply ? `DUE ${tx.time}` : `RECEIVED ${tx.time}`;
  $('keyTitle').textContent = isReply ? 'REPLY KEY — click the letters' : "TODAY'S KEY";
  $('dump').hidden = isReply;
  $('orderPaper').hidden = !isReply;
  $('readBox').hidden = isReply || state.phase === 'find';
  if (isReply) {
    renderOrderPaper();
    renderReplySheet();
  } else {
    renderDump();
    renderStatus();
    renderSheet();
    renderFrame();
  }
  renderIntuition();
  renderCrew();
  renderWall();
  renderGuide();
  renderKeyCard();
  renderMatrix();
  renderDesk();
  state.flash = null;
  state.shuffled = false;
  advise();
}

function isDone(id) {
  return state.decoded.includes(id);
}

/** Is blank `k` of the sentence filled? */
function isFilled(k) {
  return isDone(tx.cipher[k]);
}

function filledCount() {
  return tx.cipher.filter(isDone).length;
}

function wordOf(id) {
  return cellById(tx, id).meanings.join(' / ');
}

const line = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };

function btn(label, onClick, disabled = false, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.disabled = disabled;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

// ---------- decoding: the signal ----------

function renderDump() {
  const root = $('dump');
  root.replaceChildren();
  root.classList.toggle('shuffled', state.shuffled);
  const finding = state.phase === 'find';
  const nudged = finding && isFirstMessage() && state.decoded.length === 0 && state.selected === null ? firstGroupStart() : -1;
  for (let row = 0; row * tx.cols < tx.dump.length; row++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'dline';
    for (let c = 0; c < tx.cols; c++) {
      const i = row * tx.cols + c;
      const id = groupIdAt(tx, i);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell' + (tx.dump[i] === LOST ? ' lost' : '');
      cell.textContent = tx.dump[i];
      cell.dataset.i = String(i);
      cell.disabled = !finding;
      if (id && isDone(id)) {
        // a decoded group stays in the signal, switched off: the colour of its blank, or struck out if it fit none
        cell.classList.add('done', blankOf(tx, id) < 0 ? 'stray' : `kind-${tx.slots[blankOf(tx, id)]}`);
        cell.disabled = true;
      } else if (id && id === state.selected && finding) {
        cell.classList.add('anchor'); // a group shows as a group only once it has been clicked
      } else if (finding && i === nudged) {
        cell.classList.add('nudge');
      }
      rowEl.append(cell);
    }
    root.append(rowEl);
  }
}

/** The very first message of the game: one group glows, so the first click is never a guess about what to click. */
function isFirstMessage() {
  return shiftIndex === 0 && txIndex === 0;
}

/** Position of the Z of the first real (not stray) group in the signal. */
function firstGroupStart() {
  return tx.dump.findIndex((ch, i) => ch === MASK && tx.cipher.includes(groupIdAt(tx, i)));
}

// Delegated listener: the signal is re-rendered on state changes only, never on hover.
$('dump').addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (cell && !cell.disabled) onDumpCell(Number(cell.dataset.i));
});

function onDumpCell(i) {
  const id = groupIdAt(tx, i);
  if (!id) {
    logEvent('noise_click', { letter: tx.dump[i] });
    state.feedback = { tone: 'bad', text: '✗ Just noise. A group is the letter Z and the two letters after it.' };
    return renderAll();
  }
  logEvent('select', { group: shownOf(tx, id) });
  state.selected = id;
  state.feedback = null;
  renderAll();
}

// ---------- decoding: the table guess ----------

function onMatrixCell(cellId) {
  if (mode !== 'message' || state.phase !== 'find') return;
  const id = state.selected;
  if (id === null) {
    state.feedback = { tone: 'bad', text: '✗ Pick a group in the signal first: find a Z and click it.' };
    return renderAll();
  }
  if (cellId === id) return decode(id);

  // A wrong guess costs: the cell is ruled out, but the signal shifts and the group has to be found again.
  const r = checkGuess(id, cellId);
  const shown = shownOf(tx, id);
  state.tried[id] = [...(state.tried[id] ?? []), cellId];
  const known = state.known[id] ?? { row: false, col: false };
  state.known[id] = { row: known.row || r.row, col: known.col || r.col };
  state.mistakes += 1;
  logEvent('wrong_cell', { group: shown, means: wordOf(id), clicked: wordOf(cellId), rowRight: r.row, colRight: r.col });
  const half = r.row ? `Row ${cellId[0]} is right, the column is not.` : r.col ? `Column ${cellId[1]} is right, the row is not.` : 'Wrong row and wrong column.';
  state.feedback = { tone: 'bad', shifted: true, text: `✗ ${shown} is not "${wordOf(cellId)}". ${half} The signal shifted: find ${shown} again.` };
  tx = relayout(tx, state.decoded, Math.random);
  state.selected = null;
  state.shuffled = true;
  renderAll();
}

/** Group `id` is decoded: its phrase drops into the blank of its kind, or it turns out to be stray. */
function decode(id) {
  const shown = shownOf(tx, id);
  const k = blankOf(tx, id);
  state.decoded.push(id);
  state.selected = null;
  logEvent('decode', { group: shown, word: wordOf(id), fills: k < 0 ? 'nothing (stray)' : tx.slots[k] });
  if (k < 0) {
    state.feedback = { tone: 'stray', text: `— ${shown} = "${wordOf(id)}". Other traffic: no blank of this message takes it. Crossed out.` };
    return renderAll();
  }
  state.flash = k;
  const left = tx.cipher.length - filledCount();
  state.feedback = {
    tone: 'ok',
    text: `✓ ${shown} = "${wordOf(id)}". It fills the blank ${tx.slots[k].toUpperCase()}. ` +
      (left ? `${filledCount()} of ${tx.cipher.length} blanks filled.` : 'The whole message is decoded.'),
  };
  if (!left) return enterRead();
  renderAll();
}

// ---------- decoding: status and sheet ----------

function renderStatus() {
  const el = $('status');
  el.classList.remove('hedge');
  const fb = state.feedback ? [line(`fb ${state.feedback.tone}`, state.feedback.text)] : [];
  if (state.phase !== 'find') {
    el.replaceChildren(...fb, line('todo', renderSentence(tx, state.selection)));
    el.classList.toggle('hedge', judgeReading(tx, state.selection) === 'hedged');
    return;
  }
  const id = state.selected;
  if (id === null) {
    const open = tx.slots.filter((_, k) => !isFilled(k)).map((s) => s.toUpperCase()).join(', ');
    el.replaceChildren(...fb, line('todo', `Blanks still empty: ${open}. Find a group in the signal (Z and two letters) and click it.`));
    return;
  }
  const [, a, b] = shownOf(tx, id);
  const lost = lostHalf(tx, id);
  const text = lost === 'row'
    ? `Group Z${a}${b}: the row letter is lost. ${b} still gives the column (horizontal key). Which cell of that column belongs in the message? Go by colour and by sense.`
    : lost === 'col'
      ? `Group Z${a}${b}: the column letter is lost. ${a} still gives the row (vertical key). Which cell of that row belongs in the message? Go by colour and by sense.`
      : `Group Z${a}${b}: ${a} gives the row (vertical key), ${b} gives the column (horizontal key). Click that cell of the table.`;
  el.replaceChildren(...fb, line('todo', text));
}

function renderIntuition() {
  $('intuition').textContent = '●'.repeat(state.intuition) + '○'.repeat(MAX_INTUITION - state.intuition);
}

const KIND_NAMES = { who: 'who', place: 'place', action: 'action', state: 'state', result: 'result', marker: 'marker', letter: 'letter', service: 'service' };

function renderSheet() {
  const finding = state.phase === 'find';
  const mistakes = state.mistakes ? ` · ${state.mistakes} WRONG` : '';
  $('boardTitle').textContent = finding
    ? `DECODING — ${filledCount()} OF ${tx.cipher.length} BLANKS FILLED${mistakes}`
    : `DECODED — NOW READ IT${mistakes}`;
  $('controls').hidden = !finding;
  $('controls').replaceChildren(btn('AUTO (1 ●): decode the selected group', autoDecode, state.intuition < 1 || state.selected === null));
  if (!finding) renderReadBox();
  $('sendBtn').textContent = 'FILE THE MESSAGE ▸';
  $('sendBtn').hidden = state.phase !== 'read';
  $('sendBtn').disabled = judgeReading(tx, state.selection) === 'incomplete';
  $('result').hidden = state.phase !== 'sent';
}

function autoDecode() {
  const left = spendIntuition(state.intuition);
  if (left === null || state.selected === null) return;
  state.intuition = left;
  logEvent('auto', { intuitionLeft: left });
  decode(state.selected);
}

function enterRead() {
  state.phase = 'read';
  tx.cipher.forEach((id, i) => {
    const meanings = meaningsOf(tx, id);
    if (meanings.length === 1) state.selection[i] = [meanings[0]];
  });
  renderAll();
}

function renderReadBox() {
  const box = $('readBox');
  box.replaceChildren();
  tx.cipher.forEach((id, i) => {
    const meanings = meaningsOf(tx, id);
    if (meanings.length < 2) return;
    const row = document.createElement('div');
    row.className = 'readrow';
    const label = document.createElement('span');
    label.textContent = `${tx.slots[i]}:`;
    row.append(label);
    meanings.forEach((w) => {
      const chosen = (state.selection[i] ?? []).includes(w);
      row.append(btn(w, () => chooseWord(i, w), state.phase === 'sent', 'word' + (chosen ? ' on' : '')));
    });
    row.append(btn('HEDGE', () => {
      state.hedge[i] = !state.hedge[i];
      if (!state.hedge[i] && (state.selection[i] ?? []).length > 1) state.selection[i] = [state.selection[i][0]];
      renderAll();
    }, state.phase === 'sent', 'hedge' + (state.hedge[i] ? ' on' : '')));
    box.append(row);
  });
  const note = document.createElement('div');
  note.className = 'readnote';
  note.textContent = box.children.length
    ? 'One phrase has two meanings under the same code. Pick the one that fits what you know about the agents, or HEDGE to pass on both. Then file the message.'
    : 'Every phrase has a single meaning. File the message.';
  box.prepend(note);
}

function chooseWord(i, w) {
  const cur = state.selection[i] ?? [];
  if (cur.includes(w)) state.selection[i] = cur.filter((x) => x !== w);
  else if (state.hedge[i]) state.selection[i] = [...cur, w];
  else state.selection[i] = [w];
  if (state.selection[i].length === 0) delete state.selection[i];
  state.feedback = null;
  renderAll();
}

/** The sentence with a blank for every phrase of the grammar; decoded phrases drop into the blank of their kind. */
function renderFrame() {
  const el = $('frame');
  el.className = 'frame';
  el.replaceChildren();
  tx.clauses.forEach((clause) => {
    clause.pattern.split(/(\{\d+\})/).forEach((part) => {
      const m = /^\{(\d+)\}$/.exec(part);
      if (!m) { if (part) el.append(document.createTextNode(part)); return; }
      const k = Number(m[1]);
      const done = isFilled(k);
      const span = document.createElement('span');
      span.className = `blank kind-${tx.slots[k]}` + (done ? ' filled' : '') + (k === state.flash ? ' flash' : '');
      span.textContent = done ? wordOf(tx.cipher[k]) : tx.slots[k];
      el.append(span);
    });
    el.append(document.createTextNode(' '));
  });
}

function send() {
  if (mode === 'reply') return transmitReply();
  const r = resolve(tx, state.selection);
  state.phase = 'sent';
  state.feedback = null;
  state.crew = applyCrew(state.crew, r.crew);
  state.intuition = gainIntuition(state.intuition, r.intuitionGain);
  shiftLog[txIndex] = { reading: r.reading, mistakes: state.mistakes };
  logEvent('file', { id: tx.id, reading: r.reading, read: renderSentence(tx, state.selection), wrongGuesses: state.mistakes, outcome: r.severity });

  $('message').textContent = `"${r.text}"`;
  $('message').className = `message ${r.severity}`;
  const truthSelection = Object.fromEntries(tx.cipher.map((id, i) => [i, [tx.truth[i] ?? meaningsOf(tx, id)[0]]]));
  const verdict = {
    correct: 'You read it right.',
    hedged: 'You hedged: the right reading was there, but you didn\'t commit to it.',
    wrong: `You misread it. The real reading: "${renderSentence(tx, truthSelection)}"`,
  }[r.reading];
  $('debrief').innerHTML = `
    <p><span class="tag ${r.reading}">${r.reading.toUpperCase()}</span> ${verdict}</p>
    <p>Intuition ${r.intuitionGain ? '+' + r.intuitionGain : '+0'}. Wrong guesses while decoding: ${state.mistakes}.</p>
    ${tx.hint ? `<p><i>Why:</i> ${tx.hint}</p>` : ''}`;
  $('nextBtn').textContent = txIndex < act.shifts[shiftIndex].transmissions.length - 1 ? 'NEXT MESSAGE ▸' : 'END OF SHIFT: REPLY TO THE AGENTS ▸';
  renderAll();
}

function next() {
  if (mode === 'reply') return finishShift();
  start = { crew: state.crew, intuition: state.intuition };
  if (txIndex >= act.shifts[shiftIndex].transmissions.length - 1) return beginReply();
  txIndex += 1;
  begin();
}

// ---------- the reply: encoding an order from command ----------

function usedLetters() {
  return Object.values(reply.groups).map((g) => g.slice(1)).join('') + (reply.rowLetter ?? '');
}

function replyDone() {
  return tx.cipher.every((_, k) => reply.groups[k]);
}

function renderOrderPaper() {
  $('sheetTitle').textContent = 'FROM COMMAND — ENCODE FOR THE AGENTS';
  $('orderPaper').replaceChildren(...tx.cipher.map((id, k) => {
    const done = reply.groups[k];
    const row = btn('', () => onOrderRow(k), reply.sent, 'orow' + (k === reply.selected ? ' sel' : '') + (done ? ' done' : ''));
    const group = done ?? (k === reply.selected && reply.rowLetter ? `${MASK}${reply.rowLetter}·` : `${MASK}··`);
    row.innerHTML = `<span class="okind kind-${tx.slots[k]}">${tx.slots[k]}</span><span class="oword">${wordOf(id)}</span><span class="ogroup">${group}${done ? ' ✓' : ''}</span>`;
    return row;
  }));
}

function openPhrases() {
  return tx.cipher.map((_, i) => i).filter((i) => !reply.groups[i]);
}

function onOrderRow(k) {
  if (reply.groups[k]) { // take a finished group back: its letters are free again
    const g = reply.groups[k];
    delete reply.groups[k];
    reply.feedback = { tone: 'stray', text: `— ${g} taken back. The letters ${g[1]} and ${g[2]} are free again.` };
    logEvent('reply_take_back', { group: g, word: wordOf(tx.cipher[k]) });
  } else {
    reply.feedback = null;
  }
  reply.selected = k;
  reply.rowLetter = null;
  reply.stuck = !canFinishReply(tx.key, openPhrases().map((i) => tx.cipher[i]), usedLetters());
  renderAll();
}

function onKeyLetter(half, letter) {
  if (mode !== 'reply' || reply.sent) return;
  const k = reply.selected;
  if (k === null) {
    reply.feedback = { tone: 'bad', text: '✗ Pick a phrase on the order first.' };
    return renderAll();
  }
  const id = tx.cipher[k];
  const rows = half === 'rows';
  if (!rows && reply.rowLetter === null) {
    reply.feedback = { tone: 'bad', text: '✗ The row letter comes first: take it from the vertical key.' };
    return renderAll();
  }
  if (rows) reply.rowLetter = null; // choosing the row letter again replaces it
  const digit = digitOf(rows ? tx.key.rows : tx.key.cols, letter);
  if (digit !== Number(id[rows ? 0 : 1])) {
    reply.mistakes += 1;
    logEvent('reply_wrong_letter', { word: wordOf(id), half: rows ? 'row' : 'column', letter });
    reply.feedback = { tone: 'bad', text: `✗ ${letter} stands for ${rows ? 'row' : 'column'} ${digit}. "${wordOf(id)}" is not in ${rows ? 'row' : 'column'} ${digit}: find it in the table.` };
    return renderAll();
  }
  if (rows) {
    reply.rowLetter = letter;
    reply.feedback = { tone: 'ok', text: `✓ ${letter} is the row. Now the column letter, from the horizontal key.` };
    return renderAll();
  }
  reply.groups[k] = MASK + reply.rowLetter + letter;
  reply.rowLetter = null;
  const open = openPhrases();
  reply.selected = open[0] ?? null;
  reply.stuck = !canFinishReply(tx.key, open.map((i) => tx.cipher[i]), usedLetters());
  reply.feedback = reply.stuck
    ? { tone: 'bad', text: `✗ ${reply.groups[k]} goes out, but now there are not enough free letters for the rest. Click a finished phrase to take its group back.` }
    : { tone: 'ok', text: `✓ "${wordOf(id)}" = ${reply.groups[k]}. ` + (open.length ? `${tx.cipher.length - open.length} of ${tx.cipher.length} encoded.` : 'The whole order is encoded.') };
  if (reply.stuck) reply.mistakes += 1;
  logEvent('reply_group', { word: wordOf(id), group: reply.groups[k], deadEnd: reply.stuck });
  renderAll();
}

function renderReplySheet() {
  const done = tx.cipher.length - openPhrases().length;
  const mistakes = reply.mistakes ? ` · ${reply.mistakes} WRONG` : '';
  $('boardTitle').textContent = `OUTGOING — ${done} OF ${tx.cipher.length} ENCODED${mistakes}`;
  const tape = $('frame');
  tape.className = 'frame tape';
  tape.textContent = tx.cipher.map((_, k) => reply.groups[k] ?? '···').join('  ');

  const fb = reply.feedback ? [line(`fb ${reply.feedback.tone}`, reply.feedback.text)] : [];
  const k = reply.selected;
  const todo = reply.sent ? 'Sent.'
    : k === null ? 'Every phrase is encoded. Transmit the reply.'
      : reply.rowLetter === null
        ? `Find "${wordOf(tx.cipher[k])}" in the table. Click a letter of its row in the vertical key. Each letter can be used once in the whole reply.`
        : `Row letter ${reply.rowLetter}. Now click a letter of its column in the horizontal key.`;
  $('status').classList.remove('hedge');
  $('status').replaceChildren(...fb, line('todo', todo));

  $('controls').hidden = true;
  $('sendBtn').textContent = 'TRANSMIT THE REPLY ▸';
  $('sendBtn').hidden = reply.sent;
  $('sendBtn').disabled = !replyDone();
  $('result').hidden = !reply.sent;
}

function transmitReply() {
  reply.sent = true;
  reply.feedback = null;
  logEvent('reply_sent', { groups: tx.cipher.map((_, k) => reply.groups[k]).join(' '), mistakes: reply.mistakes });
  const read = shiftLog.filter((m) => m.reading === 'correct').length;
  const wrong = shiftLog.reduce((n, m) => n + m.mistakes, 0);
  $('message').textContent = `"${tx.cipher.map((_, k) => reply.groups[k]).join(' ')}" — sent ${tx.time}. End of shift ${shiftIndex + 1}.`;
  $('message').className = `message ${reply.mistakes ? 'delay' : 'safe'}`;
  $('debrief').innerHTML = `<p>Messages read right: ${read} of ${shiftLog.length}. Wrong guesses while decoding: ${wrong}.</p>
    <p>Wrong letters and dead ends while encoding: ${reply.mistakes}.</p>`;
  $('nextBtn').textContent = 'PUT THE FOLDER AWAY ▸';
  renderAll();
}

// ---------- the folder: table, key, agents ----------

function renderCrew() {
  $('crewList').replaceChildren(...state.crew.map((m) => {
    const li = document.createElement('li');
    if (m.status !== 'ok') li.classList.add('out');
    li.innerHTML = `<span class="photo"></span><span><b>${m.name}</b> ${m.id}<br>${m.role}<br>${m.status === 'ok' ? m.location : m.status}${m.note ? `<br><span class="note">${m.note}</span>` : ''}</span>`;
    return li;
  }));
}

const STEPS = {
  message: [
    '<b>Find a group.</b> A group is the letter <b>Z</b> and the two letters after it. They are scattered in the signal in no order. Click one.',
    'Ignore the Z. The <b>second</b> letter gives the row (vertical key), the <b>third</b> gives the column (horizontal key). Click that cell in the table.',
    'Right: the phrase drops into the blank of its colour by itself. <b>Wrong: the signal shifts</b>, every group moves and you have to find yours again. Do not click at random.',
    'Every message has one phrase of each kind: <b>who, place, action, state, result</b>. Their order in the sentence changes. Some groups are other traffic and fit no blank.',
    'A <b>?</b> is a lost letter. The letter that is left gives one row or one column; pick the cell in it by colour, and where several fit, by sense: the map says who is where.',
  ],
  reply: [
    'Command gives you five phrases. Pick one and <b>find it in the table</b>: its row digit and column digit.',
    'Click a letter that stands for the row in the <b>vertical key</b>, then a letter for the column in the <b>horizontal key</b>. The group is Z + those two letters.',
    '<b>Each letter can go out once</b> in the whole reply, as a row letter or as a column letter. Used letters are struck out in both keys.',
    'A digit owns only two or three letters, so think ahead. If you run out, click a finished phrase to take its group back.',
  ],
};

function renderGuide() {
  $('kinds').replaceChildren(...Object.entries(KIND_NAMES).map(([k, name]) => {
    const el = document.createElement('span');
    el.className = `kindchip kind-${k}`;
    el.textContent = name;
    return el;
  }));
  $('steps').innerHTML = STEPS[mode].map((s) => `<li>${s}</li>`).join('');
  if (mode === 'message') $('sheetTitle').textContent = `INTERCEPT ${tx.id}`;
}

function renderMatrix() {
  const finding = mode === 'message' && state.phase === 'find';
  const id = finding ? state.selected : null;
  const known = (id !== null && state.known[id]) || { row: false, col: false };
  const tried = new Set(id === null ? [] : state.tried[id] ?? []);
  const t = document.createElement('table');
  t.className = 'matrix';
  const head = document.createElement('tr');
  head.innerHTML = '<th></th>' + [...'0123456789'].map((c) => `<th class="${known.col && id[1] === c ? 'hit' : ''}">${c}</th>`).join('');
  t.append(head);
  for (let r = 0; r < 10; r++) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th class="${known.row && id[0] === String(r) ? 'hit' : ''}">${r}</th>`;
    for (let c = 0; c < 10; c++) {
      const cellId = `${r}${c}`;
      const cell = cellById(tx, cellId);
      const td = document.createElement('td');
      td.title = cellId;
      if (mode === 'message' && isDone(cellId)) {
        td.className = 'gone'; // decoded: out of the table, nothing left to click
      } else {
        td.className = `kind-${cell.kind}` + (cell.meanings.length > 1 ? ' multi' : '') + (tried.has(cellId) ? ' tried' : '');
        td.textContent = cell.text;
        if (finding && !tried.has(cellId)) td.addEventListener('click', () => onMatrixCell(cellId));
        else td.classList.add('locked');
      }
      tr.append(td);
    }
    t.append(tr);
  }
  $('codeTable').replaceChildren(t);
}

/**
 * The key: which letters stand for which digit. While decoding, the letters of the selected group are lit.
 * While encoding, the letters are buttons, and the ones already sent are struck out.
 */
function renderKeyCard() {
  const isReply = mode === 'reply';
  const g = !isReply && state.phase === 'find' && state.selected !== null ? shownOf(tx, state.selected) : null;
  const used = isReply ? usedLetters() : '';
  const live = (halfName) => isReply && !reply.sent && reply.selected !== null && (halfName === 'rows' || reply.rowLetter !== null);
  const half = (halfName, title, letters, lit) => {
    const cells = letters.map((ls, d) => {
      const chars = [...ls].map((ch) => {
        const cls = 'kl' + (ch === lit ? ' hit' : '') + (used.includes(ch) ? ' used' : '') + (isReply ? ' pickable' : '');
        return `<span class="${cls}" data-half="${halfName}" data-letter="${ch}">${ch}</span>`;
      }).join('');
      return `<span class="kd"><b>${d}</b>${chars}</span>`;
    }).join('');
    return `<div class="keyhalf${live(halfName) ? ' live' : ''}"><div class="kt">${title}</div><div class="kr">${cells}</div></div>`;
  };
  $('keyCard').innerHTML =
    half('rows', 'VERTICAL KEY: letter ↔ row digit', tx.key.rows, isReply ? reply.rowLetter : g?.[1]) +
    half('cols', 'HORIZONTAL KEY: letter ↔ column digit', tx.key.cols, g?.[2]);
}

$('keyCard').addEventListener('click', (e) => {
  const el = e.target.closest('.kl.pickable:not(.used)');
  if (el) onKeyLetter(el.dataset.half, el.dataset.letter);
});

// ---------- the room: the district map on the wall ----------

// Where the places of the district sit on the map (in the map's own 560 x 296 units). HQ is the cipher station.
const HQ = [272, 150];
const PLACES = {
  Station: [80, 44], Embassy: [212, 74], Hotel: [350, 40], Airfield: [470, 36], Border: [486, 128], 'Safe house': [140, 150],
  Harbour: [84, 232], Warehouse: [230, 238], Market: [380, 236],
};

/** The map: a pin for every place, under it the agents who are there, and a red string from each manned place to HQ. */
function renderWall() {
  const crewNow = shiftIndex === null ? crewAt(act, Math.min(Object.keys(progress.done).length, act.shifts.length - 1)) : state.crew;
  const active = crewNow.filter((m) => m.status === 'ok');
  const out = crewNow.filter((m) => m.status !== 'ok');
  const strings = [];
  const pins = Object.entries(PLACES).map(([place, [x, y]]) => {
    const here = active.filter((m) => m.location === place).map((m) => m.name);
    if (here.length) strings.push(`<line class="string" x1="${HQ[0]}" y1="${HQ[1]}" x2="${x}" y2="${y}"/>`);
    return `<circle class="pin${here.length ? '' : ' empty'}" cx="${x}" cy="${y}" r="6"/>
      <text class="place" x="${x}" y="${y + 19}">${place.toUpperCase()}</text><text x="${x}" y="${y + 31}">${here.join(' · ')}</text>`;
  });
  const lostList = out.map((m, i) => `<text class="out" x="10" y="${286 - (out.length - 1 - i) * 13}">${m.name} — ${m.status}</text>`);
  $('board').innerHTML = `<svg viewBox="0 0 560 296">
    <path class="sea" d="M0 250 C90 205 130 268 215 236 S350 190 405 226 500 262 560 212 V296 H0Z"/>
    <path class="road" d="M80 44 L212 74 L350 40 L470 36 L486 128"/>
    ${strings.join('')}${pins.join('')}
    <rect class="hq" x="${HQ[0] - 13}" y="${HQ[1] - 11}" width="26" height="22"/><text class="place" x="${HQ[0]}" y="${HQ[1] + 26}">STATION HQ</text>
    ${lostList.join('')}</svg>`;
}

// ---------- the welcome card and the tour of the folder ----------

const TOUR = [
  { target: 'dump', text: 'This is the SIGNAL: what the radio caught. It looks like noise, but the pieces of one message are scattered in it, in no order. Each piece is a group of three letters: a Z and the two letters after it.' },
  { target: 'frame', text: 'This is the GOAL. Every message says one thing: who, where, what they did, in what state, with what result. Five blanks, one for each. Decode a group and its phrase drops into the blank of its colour.' },
  { target: 'keyCard', text: "This is TODAY'S KEY. It turns letters into digits: the vertical key gives a row, the horizontal key gives a column. It changes with every message." },
  { target: 'codeTable', text: 'This is the CODE TABLE. Every cell is a phrase. A row digit and a column digit from the key point at one cell. Colours show the kind of phrase and match the blanks.' },
  { target: 'crewList', text: 'These are your AGENTS: who they are and where they are. When one code can mean two things, they tell you which. The map on the wall shows the same people.' },
  { target: null, text: 'Your turn. One Z in the signal will glow. Click it, and I will take you through it step by step.' },
];

let tour = null; // {step} while the tour is on

function startTour() {
  tour = { step: 0 };
  logEvent('tour_start');
  renderTour();
}

function renderTour() {
  document.querySelectorAll('.tour-target').forEach((el) => el.classList.remove('tour-target'));
  const step = TOUR[tour.step];
  const last = tour.step === TOUR.length - 1;
  document.body.dataset.focus = '';
  $('dim').hidden = false;
  if (step.target) {
    const el = $(step.target);
    el.classList.add('tour-target');
    el.scrollIntoView({ block: 'nearest' });
  }
  $('advisor').hidden = false;
  $('advice').textContent = step.text;
  $('adviceOk').hidden = true;
  $('adviceSkip').hidden = true;
  $('tourNext').hidden = false;
  $('tourNext').textContent = last ? "LET'S GO ▸" : 'NEXT ▸';
  $('tourSkip').hidden = last;
  $('tourStep').hidden = false;
  $('tourStep').textContent = `${tour.step + 1} / ${TOUR.length}`;
  placeAdvisor(step.target ? $(step.target) : null);
}

/** Put Pike in a corner that does not cover what he is pointing at. */
function placeAdvisor(target) {
  const adv = $('advisor');
  adv.style.cssText = '';
  if (!target) return;
  const t = target.getBoundingClientRect();
  const w = adv.offsetWidth;
  const h = adv.offsetHeight;
  const corners = [{ right: 18, bottom: 18 }, { left: 18, bottom: 18 }, { right: 18, top: 18 }, { left: 18, top: 18 }];
  const free = corners.find((c) => {
    const x = c.left !== undefined ? c.left : innerWidth - c.right - w;
    const y = c.top !== undefined ? c.top : innerHeight - c.bottom - h;
    return x + w < t.left - 8 || x > t.right + 8 || y + h < t.top - 8 || y > t.bottom + 8;
  }) ?? corners[0];
  Object.entries(free).forEach(([side, px]) => { adv.style[side] = `${px}px`; });
  if (free.left !== undefined) adv.style.right = 'auto';
  if (free.top !== undefined) adv.style.bottom = 'auto';
}

function endTour() {
  logEvent('tour_end', { step: tour.step + 1 });
  tour = null;
  progress.toured = true;
  saveProgress();
  document.querySelectorAll('.tour-target').forEach((el) => el.classList.remove('tour-target'));
  $('dim').hidden = true;
  $('advisor').style.cssText = '';
  $('adviceOk').hidden = false;
  $('adviceSkip').hidden = false;
  $('tourNext').hidden = true;
  $('tourSkip').hidden = true;
  $('tourStep').hidden = true;
  advise();
}

$('tourNext').addEventListener('click', () => {
  if (tour.step >= TOUR.length - 1) return endTour();
  tour.step += 1;
  renderTour();
});
$('tourSkip').addEventListener('click', endTour);
$('tourBtn').addEventListener('click', () => { if (!tour && mode === 'message') startTour(); });
$('introGo').addEventListener('click', () => {
  $('intro').hidden = true;
  progress.introduced = true;
  saveProgress();
  logEvent('intro_done');
  onShiftFolder(0);
});

// ---------- Mr. Pike: the advisor ----------
//
// Pike talks the player through the first shift step by step, and in any shift speaks up when the player is
// plainly stuck. Each remark is made once. He can be silenced, and asked again with ASK PIKE.

const pike = { seen: new Set(), last: null, asked: false, askedId: null };

const ADVICE = {
  home: 'New here? I am Pike, I run this room. Agents report in cipher, you turn it back into words. Open the first folder on your desk.',
  findFirst: 'A message came in. It looks like random letters, but a few of them hide the message. Look for the glowing letter: it is a Z. A Z and the two letters after it make a group, and that is a piece of the message. Click the glowing Z. In later messages nothing will glow.',
  find: 'A message came in. Somewhere in these letters are groups of three: a Z and the two letters after it. Nothing will point them out for you. Find one and click it.',
  selected: 'Good, that is a group. Forget the Z. Find its second letter in the vertical key: that digit is the row. Find the third in the horizontal key: the column. Click the cell where they cross.',
  lost: 'A letter was lost on the air. You still have one line of the table. Look along it for a colour that a blank still needs. If more than one fits, think: the map on the wall and the cards say who is where.',
  wrong: 'Wrong cell, and the signal shifted: your group has moved. Find it again. The table keeps what you learned: the cell you struck and any row or column you got right.',
  stray: 'That group was somebody else\'s traffic. Not every Z in the signal is ours. Move on.',
  ok: 'There. The phrase went to the blank of its colour by itself. The order you decode in does not matter, only the kind: who, place, action, state, result.',
  file: 'All five blanks are filled. Read it over and file it.',
  ambiguous: 'One code, two meanings. The cipher cannot tell you which. The agents can: read their cards, then choose. If you really cannot tell, HEDGE and pass on both.',
  sent: 'That is the job. A wrong guess costs you time; a wrong reading costs somebody else more. Next message.',
  struggle: 'Stop guessing, it only shakes the signal. Second letter of the group, vertical key: that digit is the row. Third letter, horizontal key: the column. If a letter is lost, read the cards before you click.',
  reply: 'End of shift. Now the other way round: command wants this sent out. Find each phrase in the table, then give it a letter for its row and a letter for its column. One rule: no letter goes out twice.',
  replyCol: 'Now the column: a letter from the horizontal key. Mind which letters you spend, the later phrases need some too.',
  deadend: 'You have spent the letters a later phrase needs. Take one group back and choose its letters with the others in mind.',
  replySent: 'Shift over. Put the folder away with the others.',
};

/** What Pike would say right now, as [id, text], or null. `guide`: hand-holding, on the first shift or when asked. */
function currentAdvice(guide) {
  const say = (id, key = id) => [id, ADVICE[key]];
  if (!document.body.classList.contains('folder-open')) {
    return null; // the welcome card says what the game is; Pike speaks up once a folder is open
  }
  if (mode === 'reply') {
    if (reply.stuck && !reply.sent) return say(`deadend-${shiftIndex}`, 'deadend');
    if (!guide) return null;
    return reply.sent ? say('replySent') : reply.rowLetter !== null ? say('replyCol') : say('reply');
  }
  if (state.phase === 'find') {
    const tone = state.feedback?.tone;
    if (tone === 'bad' && state.mistakes >= 3 && state.selected === null) return say(`struggle-${shiftIndex}-${txIndex}`, 'struggle');
    if (!guide) return null;
    if (state.selected !== null) return lostHalf(tx, state.selected) ? say('lost') : say('selected');
    if (tone === 'bad' && state.feedback.shifted) return say('wrong');
    if (tone === 'stray') return say('stray');
    if (tone === 'ok') return say('ok');
    return isFirstMessage() && state.decoded.length === 0 ? say('findFirst') : say('find');
  }
  if (!guide) return null;
  if (state.phase === 'sent') return say('sent');
  if (Object.keys(tx.truth).length === 0) return say('file');
  return pike.asked ? ['hint', tx.hint] : say('ambiguous');
}

/** Which panels glow for each piece of advice. */
const FOCUS = {
  findFirst: 'dump', find: 'dump', wrong: 'dump', stray: 'dump', selected: 'keyCard codeTable', lost: 'keyCard codeTable crewList',
  ok: 'frame', file: 'sendBtn', ambiguous: 'readBox crewList', hint: 'readBox crewList', reply: 'orderPaper keyCard codeTable', replyCol: 'keyCard',
};

function advise() {
  if (!act || tour) return;
  let advice = currentAdvice(pike.asked || shiftIndex === 0);
  if (pike.asked && pike.askedId && advice?.[0] !== pike.askedId) { // the moment he was asked about has passed
    pike.asked = false;
    pike.askedId = null;
    advice = currentAdvice(shiftIndex === 0);
  }
  if (pike.asked && advice) pike.askedId = advice[0];
  if (pike.last && pike.last !== advice?.[0]) pike.seen.add(pike.last); // a remark that scrolled by is not repeated
  const show = Boolean(advice) && (pike.asked || (!progress.muted && !pike.seen.has(advice[0])));
  $('advisor').hidden = !show;
  if (show && pike.last !== advice[0]) logEvent('pike_says', { advice: advice[0], asked: pike.asked });
  pike.last = show ? advice[0] : null;
  if (show) $('advice').textContent = advice[1];
  document.body.dataset.focus = show ? FOCUS[advice[0].split('-')[0]] ?? '' : '';
}

$('adviceOk').addEventListener('click', () => {
  if (pike.last) pike.seen.add(pike.last);
  pike.asked = false;
  pike.askedId = null;
  advise();
});
$('adviceSkip').addEventListener('click', () => {
  progress.muted = true;
  saveProgress();
  logEvent('pike_skipped');
  pike.asked = false;
  pike.askedId = null;
  advise();
});
$('askPike').addEventListener('click', () => {
  progress.muted = false;
  saveProgress();
  pike.asked = true;
  pike.askedId = null;
  advise();
});

$('sendBtn').addEventListener('click', send);
$('nextBtn').addEventListener('click', next);
$('restartBtn').addEventListener('click', () => (mode === 'reply' ? beginReply() : begin()));
$('closeFolder').addEventListener('click', () => { logEvent('back_to_desk'); openFolder(false); });
$('logSave').addEventListener('click', exportLog);
$('logClear').addEventListener('click', () => {
  gameLog = [];
  try { localStorage.removeItem(LOG_KEY); } catch { /* nothing stored */ }
  renderLogBar();
});
boot();
