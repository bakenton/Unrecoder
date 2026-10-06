import {
  ORDERS, MAX_INTUITION, MAX_TRIES, entryFor, judgeReading, renderSentence, resolve, applyCrew,
  spendIntuition, gainIntuition, keyOfCells, areAdjacent, overlaps, parses, pickedKeys, likeness, isLocked, realPick,
  sortPicks, samePick,
} from './core/engine.js';

const ORDER_LABELS = { continue: 'Continue', wait: 'Wait', back: 'Back to last CP', hurry: 'Hurry', base: 'Return to base' };
const START_INTUITION = 3;
const COLS = 12;

const $ = (id) => document.getElementById(id);

let act;
let tx;
let state;

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
  tx = act.transmissions[0];
  reset();
}

function showFatal(message) {
  const el = document.createElement('p');
  el.className = 'fatal';
  el.textContent = message;
  document.querySelector('.desk').prepend(el);
}

function reset() {
  state = {
    phase: 'find', // 'find' -> 'read' -> 'sent'
    crew: act.crew,
    intuition: START_INTUITION,
    picks: [], // {start, end} spans of the dump the player marked as code keys
    anchor: null, // first click of a span selection
    hover: null,
    tries: MAX_TRIES,
    likeness: null,
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
  renderTable();
  renderMap();
  renderOrders();
}

// ---------- dump ----------

function pickAt(i) {
  return state.picks.find((p) => p.a === i || p.b === i);
}

function renderDump() {
  const root = $('dump');
  root.replaceChildren();
  const finding = state.phase === 'find';
  for (let row = 0; row * COLS < tx.stream.length; row++) {
    const line = document.createElement('div');
    line.className = 'dline';
    const addr = document.createElement('span');
    addr.className = 'addr';
    addr.textContent = '0x' + (row * COLS).toString(16).toUpperCase().padStart(3, '0');
    line.append(addr);
    for (let c = 0; c < COLS; c++) {
      const i = row * COLS + c;
      if (i >= tx.stream.length) break;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.textContent = tx.stream[i];
      cell.dataset.i = String(i);
      if (pickAt(i)) cell.classList.add('picked');
      if (state.anchor === i) cell.classList.add('anchor');
      if (!finding) cell.disabled = true;
      line.append(cell);
    }
    root.append(line);
  }
}

// Delegated listeners: the dump is re-rendered on state changes, never on hover.
$('dump').addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (cell && !cell.disabled) onCell(Number(cell.dataset.i));
});
function onCell(i) {
  const existing = pickAt(i);
  if (existing && state.anchor === null) {
    state.picks = state.picks.filter((p) => p !== existing);
    state.note = '';
    return renderAll();
  }
  if (state.anchor === null) {
    state.anchor = i;
    state.note = '';
    return renderAll();
  }
  const first = state.anchor;
  state.anchor = null;
  const pair = { a: first, b: i };
  if (first === i) {
    state.note = '';
  } else if (!areAdjacent(tx, first, i)) {
    state.note = 'The two characters of a key touch: side by side or one above the other.';
  } else if (!keyOfCells(tx, first, i)) {
    state.note = `"${tx.stream[first]}" + "${tx.stream[i]}" is not a cell of the code table.`;
  } else if (state.picks.some((p) => overlaps(p, pair))) {
    state.note = 'That uses a character of a key you already marked. Click a marked key to unmark it.';
  } else {
    state.picks.push(pair);
    state.note = '';
  }
  renderAll();
}

// ---------- status / board ----------

function renderStatus() {
  const el = $('status');
  if (state.phase === 'find') {
    el.classList.remove('hedge');
    el.textContent = state.note || (state.likeness === null
      ? `Find code keys from the table in the noise. A key is a row digit and a column letter that touch (side by side or one above the other, any order): click one, then the other. Message: ${tx.slots.length} keys.`
      : `Likeness ${state.likeness}/${tx.slots.length} — ${state.tries} ${state.tries === 1 ? 'try' : 'tries'} left.`);
    return;
  }
  const reading = judgeReading(tx, state.selection, keysFound());
  el.textContent = renderSentence(tx, state.selection);
  el.classList.toggle('hedge', reading === 'hedged');
}

function keysFound() {
  return pickedKeys(tx, state.picks);
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

function renderBoard() {
  const finding = state.phase === 'find';
  $('boardTitle').textContent = finding ? 'DECODING SHEET — FIND THE KEYS' : 'DECODING SHEET — READ THE MESSAGE';
  $('readBox').hidden = finding;
  $('controls').hidden = !finding;

  const picks = $('picks');
  picks.replaceChildren();
  const sorted = sortPicks(state.picks);
  tx.slots.forEach((slotType, k) => {
    const p = sorted[k];
    const chip = document.createElement('div');
    chip.className = 'pick' + (p ? ' filled' : '');
    const entry = p ? keyOfCells(tx, p.a, p.b) : null;
    chip.innerHTML = `<div class="type">${slotType}</div><div class="k">${entry ? entry.key : '···'}</div><div class="m">${entry ? entry.meanings.join(' / ') : ''}</div>`;
    picks.append(chip);
  });
  if (sorted.length > tx.slots.length) {
    const extra = document.createElement('div');
    extra.className = 'pick extra';
    extra.textContent = `+${sorted.length - tx.slots.length} extra`;
    picks.append(extra);
  }

  if (finding) {
    $('controls').replaceChildren(
      btn(`TRY (${'●'.repeat(state.tries)}${'○'.repeat(MAX_TRIES - state.tries)})`, tryPicks, state.tries < 1 || state.picks.length === 0, 'primary'),
      btn('AUTO (1 ●)', autoPick, state.intuition < 1 || realMissing().length === 0),
      btn('Clear', () => { state.picks = []; state.note = ''; renderAll(); }, state.picks.length === 0),
      btn('Move on with this reading', enterRead, state.likeness === null || !parses(tx, state.picks)),
    );
    $('legend').textContent = 'The message is a sequence of code keys hidden in the noise, in grammar order (' + tx.slots.join(' → ') + '). Some keys in the dump are decoys. TRY tells you only how many of your keys are right, not which.';
  } else {
    renderReadBox();
    $('legend').textContent = 'Ambiguous keys have several meanings. Choose from the crew and map context, or HEDGE to hold both.';
  }
}

function realMissing() {
  return tx.cipher.map((_, i) => realPick(tx, i)).filter((r) => !state.picks.some((p) => samePick(p, r)));
}

function tryPicks() {
  if (!parses(tx, state.picks)) {
    const have = sortPicks(state.picks).map((p) => keyOfCells(tx, p.a, p.b).type).join(' → ') || 'nothing';
    state.note = `Doesn't parse. Need ${tx.slots.join(' → ')} in reading order (left to right, top to bottom); you have: ${have}. (No try used.)`;
    return renderAll();
  }
  state.note = '';
  state.tries -= 1;
  state.likeness = likeness(tx, state.picks);
  if (isLocked(tx, state.picks) || state.tries === 0) return enterRead();
  renderAll();
}

function autoPick() {
  const left = spendIntuition(state.intuition);
  if (left === null) return;
  const missing = realMissing();
  if (!missing.length) return;
  state.intuition = left;
  const reveal = missing[0];
  state.picks = state.picks.filter((p) => !overlaps(p, reveal));
  state.picks.push(reveal);
  state.note = '';
  renderAll();
}

function enterRead() {
  state.phase = 'read';
  state.note = '';
  keysFound().forEach((key, i) => {
    const meanings = entryFor(tx, key).meanings;
    if (meanings.length === 1) state.selection[i] = [meanings[0]];
  });
  renderAll();
}

function renderReadBox() {
  const box = $('readBox');
  box.replaceChildren();
  keysFound().forEach((key, i) => {
    const entry = entryFor(tx, key);
    if (entry.meanings.length < 2) return;
    const row = document.createElement('div');
    row.className = 'readrow';
    const label = document.createElement('span');
    label.textContent = `${key} (${entry.type}):`;
    row.append(label);
    entry.meanings.forEach((w) => {
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
  if (!box.children.length) box.textContent = 'Every key has a single meaning.';
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

function renderTable() {
  // The table is a grid: row digit = category, column letter = word. A key is "row digit + column letter".
  const rows = Object.entries(tx.rows); // [type, digit]
  const cols = [...new Set(tx.table.map((e) => e.key[1]))].sort();
  const t = document.createElement('table');
  t.className = 'grid';
  const head = document.createElement('tr');
  head.innerHTML = '<th></th><th></th>' + cols.map((c) => `<th>${c}</th>`).join('');
  t.append(head);
  for (const [type, digit] of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th>${digit}</th><th class="rowtype">${type}</th>` + cols.map((c) => {
      const e = tx.table.find((x) => x.key === digit + c);
      return `<td class="${e && e.meanings.length > 1 ? 'multi' : ''}">${e ? e.meanings.join(' / ') : '·'}</td>`;
    }).join('');
    t.append(tr);
  }
  $('codeTable').replaceChildren(t);
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
  $('resultTime').textContent = 'RECEIVED 14:58';
  $('message').textContent = `"${r.text}"`;
  $('message').className = `message ${r.severity}`;

  const truthSelection = Object.fromEntries(tx.cipher.map((key, i) => [i, [tx.truth[i] ?? entryFor(tx, key).meanings[0]]]));
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
  renderAll();
  $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('sendBtn').addEventListener('click', send);
$('restartBtn').addEventListener('click', reset);
$('hintBtn').addEventListener('click', () => {
  const h = $('hint');
  h.textContent = 'Hint: ' + tx.hint;
  h.hidden = !h.hidden;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.anchor !== null) { state.anchor = null; state.hover = null; renderDump(); }
});

boot();
