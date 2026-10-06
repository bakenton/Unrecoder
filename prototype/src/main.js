import {
  ORDERS, MAX_INTUITION, MAX_TRIES, prepare, cellById, keyLabels, tokenOfCells, areAdjacent, overlaps, parses,
  pickedKeys, likeness, isLocked, realPick, samePick, sortPicks, meaningsOf, judgeReading, renderSentence,
  resolve, applyCrew, spendIntuition, gainIntuition,
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
    picks: [], // {a, b} pairs of dump cells the player marked as keys
    anchor: null, // first click of a pair
    tries: MAX_TRIES,
    likeness: null,
    note: '',
    selection: {}, // message index -> words
    hedge: {}, // message index -> bool
    order: null,
    help: tx.keyHelp, // training mode: show the key and decode picks
  };
  $('result').hidden = true;
  $('hint').hidden = true;
  $('helpToggle').checked = state.help;
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
  renderKey();
  renderMatrix();
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
  for (let row = 0; row * tx.cols < tx.dump.length; row++) {
    const line = document.createElement('div');
    line.className = 'dline';
    const addr = document.createElement('span');
    addr.className = 'addr';
    addr.textContent = '0x' + (row * tx.cols).toString(16).toUpperCase().padStart(3, '0');
    line.append(addr);
    for (let c = 0; c < tx.cols; c++) {
      const i = row * tx.cols + c;
      if (i >= tx.dump.length) break;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.textContent = tx.dump[i];
      cell.dataset.i = String(i);
      if (pickAt(i)) cell.classList.add('picked');
      if (state.anchor === i) cell.classList.add('anchor');
      if (!finding) cell.disabled = true;
      line.append(cell);
    }
    root.append(line);
  }
}

// Delegated listener: the dump is re-rendered on state changes only, never on hover.
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
    state.note = 'The two labels of a key touch: side by side or one above the other.';
  } else if (!tokenOfCells(tx, first, i)) {
    state.note = `${tx.dump[first]} + ${tx.dump[i]} is not a row label with a column label.`;
  } else if (state.picks.some((p) => overlaps(p, pair))) {
    state.note = 'That uses a label of a key you already marked. Click a marked key to unmark it.';
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
      ? `Find the keys in the noise: a row label next to a column label (either order, side by side or stacked). Message: ${tx.slots.length} keys.`
      : `Likeness ${state.likeness}/${tx.slots.length} — ${state.tries} ${state.tries === 1 ? 'try' : 'tries'} left.`);
    return;
  }
  el.textContent = renderSentence(tx, state.selection);
  el.classList.toggle('hedge', judgeReading(tx, state.selection, keysFound()) === 'hedged');
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

const SLOT_LABEL = { who: 'who', place: 'place', action: 'action', thing: 'thing', state: 'state', marker: 'marker', number: 'number', letter: 'letter' };

function renderBoard() {
  const finding = state.phase === 'find';
  $('boardTitle').textContent = finding ? 'DECODING SHEET — FIND THE KEYS' : 'DECODING SHEET — READ THE MESSAGE';
  $('readBox').hidden = finding;
  $('controls').hidden = !finding;

  const picks = $('picks');
  picks.replaceChildren();
  const sorted = sortPicks(state.picks);
  tx.slots.forEach((slot, k) => {
    const p = sorted[k];
    const chip = document.createElement('div');
    chip.className = 'pick' + (p ? ' filled' : '');
    let main = '···';
    let sub = '';
    if (p) {
      const t = tokenOfCells(tx, p.a, p.b);
      if (state.help || !finding) {
        main = t.id;
        sub = slot === 'number' ? `number ${t.id}` : (t.cell?.text ?? '');
      } else {
        main = `${tx.dump[p.a]}·${tx.dump[p.b]}`;
      }
    }
    chip.innerHTML = `<div class="type">${SLOT_LABEL[slot]}</div><div class="k">${main}</div><div class="m">${sub}</div>`;
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
      btn('Move on with this reading', enterRead, state.likeness === null || state.picks.length !== tx.slots.length),
    );
    $('legend').textContent = 'Decode the labels with the key (ring + indicator), find the cell in the table, and pick only keys that fit the message: ' + tx.slots.join(' → ') + '. TRY tells you how many keys are right, not which. Numbers and spelled letters follow their marker directly.';
  } else {
    renderReadBox();
    $('legend').textContent = 'Ambiguous phrases have several meanings. Choose from the crew and map context, or HEDGE to hold both.';
  }
}

function realMissing() {
  return tx.cipher.map((_, i) => realPick(tx, i)).filter((r) => !state.picks.some((p) => samePick(p, r)));
}

function tryPicks() {
  if (state.picks.length !== tx.slots.length) {
    state.note = `The message has ${tx.slots.length} keys; you marked ${state.picks.length}. (No try used.)`;
    return renderAll();
  }
  if (state.help && !parses(tx, state.picks)) {
    const have = sortPicks(state.picks).map((p) => tokenOfCells(tx, p.a, p.b).cell?.kind).join(' → ');
    state.note = `Doesn't parse. Need ${tx.slots.join(' → ')} in reading order (left to right, top to bottom); you have: ${have}. A number or letter must be the pair right after its marker. (No try used.)`;
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
      const m = state.crew.find((c) => c.id === id);
      const note = document.createElement('div');
      note.className = 'readnote';
      note.textContent = m ? `Number ${id} = crew member ${id}: ${m.role} (${m.status}).` : `Number ${id}: no crew member has this ID.`;
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

function renderKey() {
  const root = $('keyInfo');
  const labels = keyLabels(tx);
  const ring = (name, list, start) => `<div class="ring"><b>${name}</b> ${list.map((l) => `<span class="lbl${l === start ? ' start' : ''}">${l}</span>`).join('')}</div>`;
  const digits = (name, list) => `<div class="ring digits"><b>${name}</b> ${list.map((l, d) => `<span class="lbl"><i>${d}</i>${l}</span>`).join('')}</div>`;
  root.innerHTML =
    `<p class="indicator">INDICATOR: row <b>${tx.indicator.row}</b> · column <b>${tx.indicator.col}</b></p>` +
    ring('row ring', act.rings.rows, tx.indicator.row) +
    ring('col ring', act.rings.cols, tx.indicator.col) +
    `<p class="rule">The indicator label is digit 0. The next labels of the ring are 1, 2, 3… and the ring wraps around.</p>` +
    (state.help ? digits('rows', labels.rows) + digits('cols', labels.cols) : '');
}

function renderMatrix() {
  const labels = keyLabels(tx);
  const t = document.createElement('table');
  t.className = 'grid matrix';
  const head = document.createElement('tr');
  head.innerHTML = '<th></th>' + [...Array(10).keys()].map((c) => `<th>${c}${state.help ? `<small>${labels.cols[c]}</small>` : ''}</th>`).join('');
  t.append(head);
  for (let r = 0; r < 10; r++) {
    const tr = document.createElement('tr');
    let html = `<th>${r}${state.help ? `<small>${labels.rows[r]}</small>` : ''}</th>`;
    for (let c = 0; c < 10; c++) {
      const cell = cellById(tx, `${r}${c}`);
      const multi = cell.meanings.length > 1;
      html += `<td class="k-${cell.kind}${multi ? ' multi' : ''}" title="${r}${c}">${cell.text}</td>`;
    }
    tr.innerHTML = html;
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
$('helpToggle').addEventListener('change', (e) => {
  state.help = e.target.checked;
  renderAll();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.anchor !== null) { state.anchor = null; renderDump(); }
});

boot();
