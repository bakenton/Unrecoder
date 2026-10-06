import {
  ORDERS, MAX_INTUITION, entryFor, isAmbiguous, judgeReading, renderSentence,
  resolve, applyCrew, spendIntuition, gainIntuition,
} from './core/engine.js';

const ORDER_LABELS = { continue: 'Continue', wait: 'Wait', back: 'Back to last CP', hurry: 'Hurry', base: 'Return to base' };
const START_INTUITION = 3;

const $ = (id) => document.getElementById(id);

let act;
let tx;
let state;

async function boot() {
  const res = await fetch('../content/campaign/act1.json');
  act = await res.json();
  tx = act.transmissions[0];
  reset();
}

function reset() {
  state = {
    crew: act.crew,
    intuition: START_INTUITION,
    selection: {}, // cipherIndex -> string[]
    pos: Object.fromEntries(tx.cipher.map((_, i) => [i, 0])), // drum position per reel
    hedge: {}, // cipherIndex -> bool
    order: null,
    sent: false,
  };
  $('result').hidden = true;
  $('hint').hidden = true;
  $('txId').textContent = tx.id.split('-')[0].replace('T', 'No.');
  $('txTime').textContent = `RECEIVED ${tx.time}`;
  renderAll();
}

function renderAll() {
  renderCipher();
  renderReels();
  renderSentence_();
  renderIntuition();
  renderCrew();
  renderTable();
  renderMap();
  renderOrders();
}

function renderCipher() {
  $('cipher').replaceChildren(...tx.cipher.map((s) => Object.assign(document.createElement('span'), { textContent: s })));
}

function renderIntuition() {
  $('intuition').textContent = '●'.repeat(state.intuition) + '○'.repeat(MAX_INTUITION - state.intuition);
}

function renderSentence_() {
  const reading = judgeReading(tx, state.selection);
  const text = renderSentence(tx, state.selection);
  $('sentence').textContent = text;
  $('sentence').classList.toggle('hedge', reading === 'hedged');
}

function candidates(i) {
  return entryFor(tx, tx.cipher[i]).meanings;
}

function renderReels() {
  const root = $('reels');
  root.replaceChildren();
  tx.cipher.forEach((symbol, i) => {
    const cands = candidates(i);
    const multi = cands.length > 1;
    const chosen = state.selection[i] ?? [];
    const pos = state.pos[i];
    const locked = (w) => chosen.includes(w);

    const reel = document.createElement('div');
    reel.className = 'reel';
    reel.innerHTML = `<div class="sym">${symbol}</div><div class="type">${entryFor(tx, symbol).type}</div>`;

    const up = btn('▲', () => spin(i, -1), !multi || state.sent);
    const down = btn('▼', () => spin(i, 1), !multi || state.sent);
    const win = document.createElement('div');
    win.className = 'win';
    // Multi-meaning reels show prev / current / next; single-meaning reels show one row.
    const offsets = multi ? [-1, 0, 1] : [0];
    win.append(...offsets.map((off) => {
      const w = cands[(((pos + off) % cands.length) + cands.length) % cands.length];
      const row = document.createElement('div');
      row.className = 'row' + (off === 0 ? ' mid' : '');
      row.textContent = w;
      if (locked(w)) row.classList.add('locked');
      if (off === 0 && !state.sent) row.addEventListener('click', () => toggle(i, w));
      return row;
    }));
    win.addEventListener('wheel', (e) => { if (multi && !state.sent) { e.preventDefault(); spin(i, Math.sign(e.deltaY)); } }, { passive: false });

    const tools = document.createElement('div');
    tools.className = 'tools';
    if (multi) {
      const h = btn('HEDGE', () => { state.hedge[i] = !state.hedge[i]; if (!state.hedge[i] && chosen.length > 1) state.selection[i] = [chosen[0]]; renderAll(); }, state.sent);
      h.classList.toggle('on', !!state.hedge[i]);
      tools.append(h);
    } else {
      tools.append(btn('AUTO', () => auto(i), state.sent || chosen.length > 0 || state.intuition < 1));
    }
    reel.append(up, win, down, tools);
    root.append(reel);
  });
}

function btn(label, onClick, disabled = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function spin(i, dir) {
  state.pos[i] += dir;
  renderReels();
}

function toggle(i, word) {
  const cands = candidates(i);
  const cur = state.selection[i] ?? [];
  if (cur.includes(word)) {
    state.selection[i] = cur.filter((w) => w !== word);
  } else if (state.hedge[i] && cands.length > 1) {
    state.selection[i] = [...cur, word];
  } else {
    state.selection[i] = [word];
  }
  if (state.selection[i].length === 0) delete state.selection[i];
  renderAll();
}

function auto(i) {
  const left = spendIntuition(state.intuition);
  if (left === null) return;
  state.intuition = left;
  state.selection[i] = [candidates(i)[0]];
  renderAll();
}

function renderCrew() {
  const ul = $('crewList');
  ul.replaceChildren(...state.crew.map((m) => {
    const li = document.createElement('li');
    if (m.status === 'injured') li.classList.add('injured');
    li.innerHTML = `<span class="id">${m.id}</span><span>${m.role}${m.note ? `<br><span class="note">${m.note}</span>` : ''}</span><span class="where">${m.location}</span>`;
    return li;
  }));
}

function renderTable() {
  $('codeTable').replaceChildren(...tx.table.map((e) => {
    const li = document.createElement('li');
    const multi = e.meanings.length > 1;
    li.innerHTML = `<b>${e.symbol}</b><span class="${multi ? 'multi' : ''}">${e.meanings.join(' / ')}</span>`;
    return li;
  }));
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
  const root = $('orders');
  root.replaceChildren(...ORDERS.map((o) => {
    const b = btn(ORDER_LABELS[o], () => { state.order = o; renderOrders(); }, state.sent);
    b.setAttribute('aria-pressed', String(state.order === o));
    return b;
  }));
  const ready = judgeReading(tx, state.selection) !== 'incomplete' && state.order && !state.sent;
  $('sendBtn').disabled = !ready;
}

function send() {
  const r = resolve(tx, state.selection, state.order);
  state.sent = true;
  state.crew = applyCrew(state.crew, r.crew);
  state.intuition = gainIntuition(state.intuition, r.intuitionGain);

  $('result').hidden = false;
  $('resultTime').textContent = 'RECEIVED 14:58';
  $('message').textContent = `"${r.text}"`;
  $('message').className = `message ${r.severity}`;

  const truthSelection = Object.fromEntries(tx.cipher.map((_, i) => [i, [tx.truth[i] ?? candidates(i)[0]]]));
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

boot();
