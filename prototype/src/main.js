import {
  ORDERS, MAX_INTUITION, prepare, cellById, numberOf, checkGuess, meaningsOf, judgeReading,
  renderSentence, resolve, applyCrew, spendIntuition, gainIntuition,
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
    decoded: {}, // group index -> cell id the player found
    selected: 0, // group being decoded
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
  renderGroups();
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

/** Decoded cell ids in message order (complete once every group is decoded). */
function keysFound() {
  return tx.cipher.map((_, i) => state.decoded[i]);
}

function allDecoded() {
  return tx.cipher.every((_, i) => state.decoded[i] !== undefined);
}

function wordOf(i) {
  const id = state.decoded[i];
  if (id === undefined) return null;
  return tx.slots[i] === 'number' ? `number ${numberOf(id)}` : cellById(tx, id).meanings.join(' / ');
}

function nextUndecoded() {
  const k = tx.cipher.findIndex((_, i) => state.decoded[i] === undefined);
  return k < 0 ? null : k;
}

// ---------- radio: the groups ----------

function renderGroups() {
  const root = $('groups');
  root.replaceChildren();
  tx.groups.forEach((g, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'group' + (state.selected === i ? ' sel' : '') + (state.decoded[i] !== undefined ? ' done' : '');
    b.dataset.i = String(i);
    b.disabled = state.phase !== 'find';
    b.innerHTML = `<span class="g"><span class="z">${g[0]}</span>${g.slice(1)}</span><span class="w">${wordOf(i) ?? '?'}</span>`;
    root.append(b);
  });
}

$('groups').addEventListener('click', (e) => {
  const g = e.target.closest('.group');
  if (g && !g.disabled) { state.selected = Number(g.dataset.i); state.note = ''; renderAll(); }
});

// ---------- decoding: the table guess ----------

function onMatrixCell(id) {
  if (state.phase !== 'find') return;
  const i = state.selected;
  if (i === null) { state.note = 'Pick a group in the signal first.'; return renderStatus(); }
  const r = checkGuess(tx, i, id);
  if (!r.ok) {
    const g = tx.groups[i];
    state.note = r.row
      ? `Row ${id[0]} is right, the column is not. Look the letter ${g[2]} up in the horizontal key.`
      : r.col
        ? `Column ${id[1]} is right, the row is not. Look the letter ${g[1]} up in the vertical key.`
        : `Neither is right. ${g[1]} is a row letter (vertical key), ${g[2]} is a column letter (horizontal key).`;
    return renderStatus();
  }
  state.decoded[i] = id;
  state.selected = nextUndecoded();
  state.note = '';
  if (allDecoded()) return enterRead();
  renderAll();
}

// ---------- status / board ----------

function renderStatus() {
  const el = $('status');
  el.classList.remove('hedge');
  if (state.phase === 'find') {
    const i = state.selected;
    const g = i === null ? null : tx.groups[i];
    el.textContent = state.note || (g
      ? `Group ${g}: ignore the Z. ${g[1]} gives the row (vertical key), ${g[2]} gives the column (horizontal key). Click that cell in the table.`
      : 'Pick a group to decode.');
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
  $('boardTitle').textContent = finding ? 'DECODING SHEET — DECODE THE GROUPS' : 'DECODING SHEET — READ THE MESSAGE';
  $('readBox').hidden = finding;
  $('controls').hidden = !finding;

  const picks = $('picks');
  picks.replaceChildren();
  tx.slots.forEach((slot, k) => {
    const chip = document.createElement('div');
    const done = state.decoded[k] !== undefined;
    chip.className = `pick kind-${slot}` + (done ? ' filled' : '') + (state.selected === k ? ' sel' : '');
    chip.innerHTML = `<div class="type">${k + 1}. ${slot}</div><div class="k">${tx.groups[k]}</div><div class="m">${wordOf(k) ?? SLOT_HELP[slot]}</div>`;
    if (finding) chip.addEventListener('click', () => { state.selected = k; state.note = ''; renderAll(); });
    picks.append(chip);
  });

  if (finding) {
    $('controls').replaceChildren(
      btn('AUTO (1 ●): decode the selected group', autoDecode, state.intuition < 1 || state.selected === null),
    );
    $('legend').textContent = 'Decode the groups in any order. The message reads in the order shown: ' + tx.slots.join(' → ') + '.';
  } else {
    renderReadBox();
    $('legend').textContent = 'Ambiguous phrases have several meanings. Choose from the crew and map context, or HEDGE to hold both.';
  }
}

function autoDecode() {
  const left = spendIntuition(state.intuition);
  const i = state.selected;
  if (left === null || i === null) return;
  state.intuition = left;
  state.decoded[i] = tx.cipher[i];
  state.selected = nextUndecoded();
  state.note = '';
  if (allDecoded()) return enterRead();
  renderAll();
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
  tx.slots.forEach((_, k) => {
    if (state.decoded[k] !== undefined) words[k] = wordOf(k).replace(/^number /, '');
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
  const g = state.selected === null || state.phase !== 'find' ? null : tx.groups[state.selected];
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
