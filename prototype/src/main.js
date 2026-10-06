import {
  ORDERS, MAX_INTUITION, prepare, cellById, numberOf, groupAt, nextCandidate, slotAccepts, parses, checkGuess,
  meaningsOf, judgeReading, renderSentence, resolve, applyCrew, spendIntuition, gainIntuition,
} from './core/engine.js';

const ORDER_LABELS = { continue: 'Continue', wait: 'Wait', back: 'Back to last CP', hurry: 'Hurry', base: 'Return to base' };
const START_INTUITION = 3;

const $ = (id) => document.getElementById(id);

let act;
let txIndex = 0;
let tx;
let state;
let start; // {crew, intuition} at the start of the current transmission, for Replay

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
  startCampaign();
}

function showFatal(message) {
  const el = document.createElement('p');
  el.className = 'fatal';
  el.textContent = message;
  document.querySelector('.desk').prepend(el);
}

function startCampaign() {
  txIndex = 0;
  start = { crew: act.crew, intuition: START_INTUITION };
  begin();
}

function begin() {
  tx = prepare(act, txIndex);
  state = {
    phase: 'find', // 'find' -> 'read' -> 'sent'
    crew: start.crew,
    intuition: start.intuition,
    marked: [], // start positions in the signal of the groups the player marked
    decoded: {}, // marked position -> cell id the player found
    selected: null, // marked position being decoded
    note: '',
    selection: {}, // message index -> words
    hedge: {}, // message index -> bool
    order: null,
  };
  $('result').hidden = true;
  $('hint').hidden = true;
  $('txId').textContent = tx.id.split('-')[0].replace('T', 'No.');
  $('txTime').textContent = `RECEIVED ${tx.time}`;
  renderAll();
}

function renderAll() {
  renderDump();
  renderStatus();
  renderBoard();
  renderIntuition();
  renderCrew();
  renderFrame();
  renderGuide();
  renderKeyCard();
  renderMatrix();
  renderMap();
  renderOrders();
}

/** Cell ids of the marked groups in reading order (complete once every marked group is decoded). */
function keysFound() {
  return markedSorted().map((p) => state.decoded[p]);
}

function markedSorted() {
  return [...state.marked].sort((a, b) => a - b);
}

function allDecoded() {
  return state.marked.every((p) => state.decoded[p] !== undefined);
}

function wordAt(p) {
  const id = state.decoded[p];
  if (id === undefined) return null;
  const k = markedSorted().indexOf(p);
  return tx.slots[k] === 'number' ? `number ${numberOf(id)}` : cellById(tx, id).meanings.join(' / ');
}

/** Does the decoded group at reading index `k` fit its blank? (undefined while it is not decoded yet) */
function fitsBlank(k) {
  const sorted = markedSorted();
  const p = sorted[k];
  if (p === undefined || state.decoded[p] === undefined || k >= tx.slots.length) return undefined;
  if (!slotAccepts(tx.slots[k], cellById(tx, state.decoded[p]))) return false;
  if ((tx.slots[k] === 'number' || tx.slots[k] === 'letter') && k > 0) return nextCandidate(tx, sorted[k - 1]) === p;
  return true;
}

// ---------- radio: the signal ----------

function groupOfCell(i) {
  return state.marked.find((p) => i >= p && i < p + 3);
}

function renderDump() {
  const root = $('dump');
  root.replaceChildren();
  const finding = state.phase === 'find';
  for (let row = 0; row * tx.cols < tx.dump.length; row++) {
    const line = document.createElement('div');
    line.className = 'dline';
    for (let c = 0; c < tx.cols; c++) {
      const i = row * tx.cols + c;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell' + (tx.dump[i] === 'Z' ? ' zed' : '') + (tx.dump[i] === '?' ? ' lost' : '');
      cell.textContent = tx.dump[i];
      cell.dataset.i = String(i);
      const g = groupOfCell(i);
      if (g !== undefined) cell.classList.add(g === state.selected ? 'anchor' : 'picked');
      if (!finding) cell.disabled = true;
      line.append(cell);
    }
    root.append(line);
  }
}

// Delegated listener: the signal is re-rendered on state changes only, never on hover.
$('dump').addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (cell && !cell.disabled) onDumpCell(Number(cell.dataset.i));
});

function onDumpCell(i) {
  const marked = groupOfCell(i);
  if (marked !== undefined) { // click a marked group to unmark it
    state.marked = state.marked.filter((p) => p !== marked);
    delete state.decoded[marked];
    if (state.selected === marked) state.selected = markedSorted().find((p) => state.decoded[p] === undefined) ?? null;
    state.note = '';
    return renderAll();
  }
  if (!groupAt(tx, i)) {
    state.note = 'A group starts with the letter Z. Click a Z to mark the group of three letters.';
    return renderStatus();
  }
  if (state.marked.some((p) => Math.abs(p - i) < 3)) {
    state.note = 'That overlaps a group you already marked.';
    return renderStatus();
  }
  state.marked.push(i);
  state.selected = i;
  state.note = '';
  renderAll();
}

// ---------- decoding: the table guess ----------

function onMatrixCell(id) {
  if (state.phase !== 'find') return;
  const p = state.selected;
  if (p === null) { state.note = 'Mark a group in the signal first: click a Z.'; return renderStatus(); }
  if (state.decoded[p] !== undefined) { state.note = 'That group is already decoded. Mark or pick another one.'; return renderStatus(); }
  const g = groupAt(tx, p);
  const r = checkGuess(g.id, id);
  if (!r.ok) {
    const [, a, b] = g.shown;
    if (g.damaged) {
      state.note = a === '?'
        ? (r.col ? `Column ${id[1]} is right. The row letter is lost, so use the sentence: which cell of column ${id[1]} fits this blank?` : `The column is not ${id[1]}. Look the letter ${b} up in the horizontal key.`)
        : (r.row ? `Row ${id[0]} is right. The column letter is lost, so use the sentence: which cell of row ${id[0]} fits this blank?` : `The row is not ${id[0]}. Look the letter ${a} up in the vertical key.`);
    } else {
      state.note = r.row
        ? `Row ${id[0]} is right, the column is not. Look the letter ${b} up in the horizontal key.`
        : r.col
          ? `Column ${id[1]} is right, the row is not. Look the letter ${a} up in the vertical key.`
          : `Neither is right. ${a} is a row letter (vertical key), ${b} is a column letter (horizontal key).`;
    }
    return renderStatus();
  }
  state.decoded[p] = id;
  state.note = '';
  afterDecode();
}

/** Called after a group is decoded: advance, or check whether the marked groups now form the message. */
function afterDecode() {
  const pending = markedSorted().find((p) => state.decoded[p] === undefined);
  state.selected = pending ?? null;
  if (state.marked.length === tx.slots.length && allDecoded()) {
    if (parses(tx, state.marked)) return enterRead();
    const have = markedSorted().map((p) => state.decoded[p]).map((id) => cellById(tx, id).kind).join(' → ');
    state.note = `These groups do not form the sentence. Blanks need: ${tx.slots.join(' → ')}. You have: ${have}. Some of your groups are decoys: click a marked group in the signal to unmark it.`;
    state.selected = null;
  }
  renderAll();
}

// ---------- status / board ----------

function renderStatus() {
  const el = $('status');
  el.classList.remove('hedge');
  if (state.phase === 'find') {
    const p = state.selected;
    const g = p === null ? null : groupAt(tx, p);
    let text;
    if (g && state.decoded[p] === undefined) {
      text = g.damaged
        ? `Group ${g.shown}: a letter is lost (?). The letter that is left still gives a row or a column. Click a cell of the table.`
        : `Group ${g.shown}: ignore the Z. ${g.shown[1]} gives the row (vertical key), ${g.shown[2]} gives the column (horizontal key). Click that cell of the table.`;
    } else if (markedSorted().some((_, k) => fitsBlank(k) === false)) {
      const k = markedSorted().findIndex((_, i) => fitsBlank(i) === false);
      text = `Group ${k + 1} (${wordAt(markedSorted()[k])}) does not fit the blank "${tx.slots[k] ?? 'extra'}". It may be a decoy: click it in the signal to unmark it.`;
    } else {
      text = `Find the ${tx.slots.length} groups of the message. Every group starts with Z, but not every Z group belongs to the message. Click a Z to mark it.`;
    }
    el.textContent = state.note || text;
    return;
  }
  el.textContent = renderSentence(tx, state.selection);
  el.classList.toggle('hedge', judgeReading(tx, state.selection, keysFound()) === 'hedged');
}

function renderIntuition() {
  $('intuition').textContent = '●'.repeat(state.intuition) + '○'.repeat(MAX_INTUITION - state.intuition);
}

function btn(label, onClick, disabled = false, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.disabled = disabled;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

const SLOT_HELP = {
  who: 'who is it about?', place: 'where?', action: 'what happened?', thing: 'about what?', state: 'in what state?',
  marker: 'announces a number or spelling', number: 'the group right after the marker', letter: 'next letter of the word',
};
const KIND_NAMES = { who: 'who', place: 'place', action: 'action', thing: 'thing', state: 'state', marker: 'marker', letter: 'letter', service: 'service' };

function renderBoard() {
  const finding = state.phase === 'find';
  $('boardTitle').textContent = finding ? 'DECODING SHEET — FIND AND DECODE THE GROUPS' : 'DECODING SHEET — READ THE MESSAGE';
  $('readBox').hidden = finding;
  $('controls').hidden = !finding;

  const picks = $('picks');
  picks.replaceChildren();
  const sorted = markedSorted();
  const count = Math.max(tx.slots.length, sorted.length);
  for (let k = 0; k < count; k++) {
    const slot = tx.slots[k];
    const p = sorted[k];
    const chip = document.createElement('div');
    const fit = fitsBlank(k);
    chip.className = `pick kind-${slot ?? 'extra'}` + (p !== undefined ? ' filled' : '') + (p !== undefined && p === state.selected ? ' sel' : '') + (fit === false ? ' bad' : '');
    const g = p === undefined ? null : groupAt(tx, p);
    const sub = p === undefined ? SLOT_HELP[slot] : (wordAt(p) ?? 'not decoded yet');
    chip.innerHTML = `<div class="type">${k + 1}. ${slot ?? 'extra'}</div><div class="k">${g ? g.shown : '···'}</div><div class="m">${sub}${fit === false ? '<br>does not fit this blank' : ''}</div>`;
    if (finding && p !== undefined) chip.addEventListener('click', () => { state.selected = p; state.note = ''; renderAll(); });
    picks.append(chip);
  }

  if (finding) {
    $('controls').replaceChildren(
      btn('AUTO (1 ●): find the next real group', autoFind, state.intuition < 1 || !nextReal()),
      btn('Clear', () => { state.marked = []; state.decoded = {}; state.selected = null; state.note = ''; renderAll(); }, state.marked.length === 0),
    );
    $('legend').textContent = 'Blanks, in order: ' + tx.slots.join(' → ') + '. A number or a spelled letter is the group right after its marker.';
  } else {
    renderReadBox();
    $('legend').textContent = 'Ambiguous phrases have several meanings. Choose from the crew and map context, or HEDGE to hold both.';
  }
}

function nextReal() {
  return tx.real.find((p) => !state.marked.includes(p) || state.decoded[p] === undefined) ?? null;
}

function autoFind() {
  const left = spendIntuition(state.intuition);
  const p = nextReal();
  if (left === null || p === null) return;
  state.intuition = left;
  if (!state.marked.includes(p)) {
    // make room: drop any marked group that overlaps the real one
    state.marked = state.marked.filter((q) => Math.abs(q - p) >= 3);
    state.marked.push(p);
  }
  state.decoded[p] = groupAt(tx, p).id;
  state.note = '';
  afterDecode();
}

function enterRead() {
  state.phase = 'read';
  state.note = '';
  state.selected = null;
  keysFound().forEach((id, i) => {
    const meanings = meaningsOf(tx, i, id);
    if (meanings.length === 1) state.selection[i] = [meanings[0]];
  });
  renderAll();
}

function renderReadBox() {
  const box = $('readBox');
  box.replaceChildren();
  keysFound().forEach((id, i) => {
    const meanings = meaningsOf(tx, i, id);
    if (tx.slots[i] === 'number') {
      const n = numberOf(id);
      const m = state.crew.find((c) => c.id === n);
      const note = document.createElement('div');
      note.className = 'readnote';
      note.textContent = m ? `Number ${n} = crew member ${n}: ${m.role} (${m.status}).` : `Number ${n}: no crew member has this ID.`;
      box.append(note);
    }
    if (meanings.length < 2) return;
    const row = document.createElement('div');
    row.className = 'readrow';
    const label = document.createElement('span');
    label.textContent = `${id} (${tx.slots[i]}):`;
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
  if (![...box.children].some((c) => c.classList.contains('readrow'))) {
    const none = document.createElement('div');
    none.className = 'readnote';
    none.textContent = 'Every key has a single meaning.';
    box.append(none);
  }
}

function chooseWord(i, w) {
  const cur = state.selection[i] ?? [];
  if (cur.includes(w)) state.selection[i] = cur.filter((x) => x !== w);
  else if (state.hedge[i]) state.selection[i] = [...cur, w];
  else state.selection[i] = [w];
  if (state.selection[i].length === 0) delete state.selection[i];
  renderAll();
}

// ---------- side panels ----------

function renderCrew() {
  $('crewList').replaceChildren(...state.crew.map((m) => {
    const li = document.createElement('li');
    if (m.status === 'injured') li.classList.add('injured');
    li.innerHTML = `<span class="id">${m.id}</span><span>${m.role}${m.note ? `<br><span class="note">${m.note}</span>` : ''}</span><span class="where">${m.location}</span>`;
    return li;
  }));
}

function renderGuide() {
  $('kinds').replaceChildren(...Object.entries(KIND_NAMES).map(([k, name]) => {
    const el = document.createElement('span');
    el.className = `kindchip kind-${k}`;
    el.textContent = name;
    return el;
  }));
}

/** The sentence with a blank for every key still to find; found keys are filled in as words. */
function renderFrame() {
  const words = {};
  markedSorted().forEach((p, k) => {
    if (k < tx.slots.length && state.decoded[p] !== undefined) words[k] = wordAt(p).replace(/^number /, '');
  });
  const el = $('frame');
  el.replaceChildren();
  tx.clauses.forEach((clause) => {
    clause.pattern.split(/(\{\d+\})/).forEach((part) => {
      const m = /^\{(\d+)\}$/.exec(part);
      if (!m) { if (part) el.append(document.createTextNode(part)); return; }
      const k = Number(m[1]);
      const span = document.createElement('span');
      span.className = `blank kind-${tx.slots[k]}` + (words[k] ? ' filled' : '');
      span.textContent = words[k] ?? tx.slots[k];
      el.append(span);
    });
    el.append(document.createTextNode(' '));
  });
}

function renderMatrix() {
  const t = document.createElement('table');
  t.className = 'grid matrix';
  const head = document.createElement('tr');
  head.innerHTML = '<th></th>' + [...'0123456789'].map((c) => `<th>${c}</th>`).join('');
  t.append(head);
  const found = new Set(Object.values(state.decoded));
  for (let r = 0; r < 10; r++) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th>${r}</th>`;
    for (let c = 0; c < 10; c++) {
      const id = `${r}${c}`;
      const cell = cellById(tx, id);
      const td = document.createElement('td');
      td.className = `kind-${cell.kind}` + (cell.meanings.length > 1 ? ' multi' : '') + (found.has(id) ? ' found' : '');
      td.textContent = cell.text;
      td.title = id;
      td.addEventListener('click', () => onMatrixCell(id));
      tr.append(td);
    }
    t.append(tr);
  }
  $('codeTable').replaceChildren(t);
}

/** The daily key: which letters stand for which digit. The letters of the selected group are lit. */
function renderKeyCard() {
  const g = state.selected === null || state.phase !== 'find' ? null : groupAt(tx, state.selected)?.shown;
  const half = (title, letters, lit) => {
    const cells = letters.map((ls, d) => {
      const chars = [...ls].map((ch) => `<span class="kl${ch === lit ? ' hit' : ''}">${ch}</span>`).join('');
      return `<span class="kd"><b>${d}</b>${chars}</span>`;
    }).join('');
    return `<div class="keyhalf"><div class="kt">${title}</div><div class="kr">${cells}</div></div>`;
  };
  $('keyCard').innerHTML =
    half('VERTICAL KEY: letter → row digit', tx.key.rows, g?.[1]) +
    half('HORIZONTAL KEY: letter → column digit', tx.key.cols, g?.[2]);
}

function renderMap() {
  const pts = act.map.points;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = $('map');
  svg.replaceChildren();
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#8a7a4a');
  line.setAttribute('stroke-dasharray', '6 5');
  line.setAttribute('stroke-width', '2');
  svg.append(line);
  pts.forEach((p) => {
    const g = document.createElementNS(ns, 'g');
    g.innerHTML = `<circle cx="${p.x}" cy="${p.y}" r="6" fill="#2b261c"/><text x="${p.x + 9}" y="${p.y + 4}" font-size="12" fill="#2b261c">${p.id}</text>`;
    svg.append(g);
  });
  const team = pts.find((p) => p.id === 'CP4');
  const t = document.createElementNS(ns, 'circle');
  t.setAttribute('cx', team.x); t.setAttribute('cy', team.y); t.setAttribute('r', 11);
  t.setAttribute('fill', 'none'); t.setAttribute('stroke', '#a4382a'); t.setAttribute('stroke-width', '2');
  svg.append(t);
}

function renderOrders() {
  $('orders').replaceChildren(...ORDERS.map((o) => {
    const b = btn(ORDER_LABELS[o], () => { state.order = o; renderOrders(); }, state.phase !== 'read');
    b.setAttribute('aria-pressed', String(state.order === o));
    return b;
  }));
  const ready = state.phase === 'read' && judgeReading(tx, state.selection, keysFound()) !== 'incomplete' && state.order;
  $('sendBtn').disabled = !ready;
}

function send() {
  const r = resolve(tx, state.selection, state.order, keysFound());
  state.phase = 'sent';
  state.crew = applyCrew(state.crew, r.crew);
  state.intuition = gainIntuition(state.intuition, r.intuitionGain);

  $('result').hidden = false;
  $('resultTime').textContent = `AFTER ${tx.time}`;
  $('message').textContent = `"${r.text}"`;
  $('message').className = `message ${r.severity}`;

  const truthSelection = Object.fromEntries(tx.cipher.map((id, i) => [i, [tx.truth[i] ?? meaningsOf(tx, i, id)[0]]]));
  const verdict = {
    correct: 'You read it right.',
    hedged: 'You hedged: the right reading was in your answer, but you didn\'t commit to it.',
    wrong: `You misread it. The real reading: "${renderSentence(tx, truthSelection)}"`,
  }[r.reading];
  $('debrief').innerHTML = `
    <p><span class="tag ${r.reading}">${r.reading.toUpperCase()}</span> ${verdict}</p>
    <p>Order: <b>${ORDER_LABELS[r.order]}</b>. Intuition ${r.intuitionGain ? '+' + r.intuitionGain : '+0'}.</p>
    <p><i>Why:</i> ${tx.hint}</p>
    <p style="opacity:.7">(Prototype debrief — in the real game you'd only learn this from the next message.)</p>`;
  $('nextBtn').hidden = txIndex >= act.transmissions.length - 1;
  renderAll();
  $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function next() {
  txIndex += 1;
  start = { crew: state.crew, intuition: state.intuition };
  begin();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('sendBtn').addEventListener('click', send);
$('nextBtn').addEventListener('click', next);
$('restartBtn').addEventListener('click', begin);
$('restartAllBtn').addEventListener('click', startCampaign);
$('hintBtn').addEventListener('click', () => {
  const h = $('hint');
  h.textContent = 'Hint: ' + tx.hint;
  h.hidden = !h.hidden;
});
boot();
