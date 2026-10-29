import {
  parseMoney, parsePercent, parsePastedBalances, formatMoney, formatPercent, analyze, calculate,
  buildCsv, readSavedCsv,
} from './logic.js';

// There is no minimum number of traded days; the table just starts with 10 empty rows.
const DEFAULTS = { start: '50000', target: '3000', pct: '30' };
const START_ROWS = 10;
const MAX_ROWS = 400;

const $ = (id) => document.getElementById(id);
const els = {
  start: $('start'), target: $('target'), pct: $('pct'),
  badge: $('badge'), reasons: $('reasons'), inverse: $('inverse'),
  stTotal: $('st-total'), stLargest: $('st-largest'), stShare: $('st-share'),
  stRequired: $('st-required'), stDays: $('st-days'), live: $('live'), pasteNote: $('paste-note'), stats: document.querySelector('.stats'),
  rows: $('rows'), chart: $('chart'), tip: $('tip'),
  cHighest: $('c-highest'), cTotal: $('c-total'), cPct: $('c-pct'), calcOut: $('calc-out'),
};

const state = {
  start: DEFAULTS.start, target: DEFAULTS.target, pct: DEFAULTS.pct,
  balances: [], calcHighest: '', calcTotal: '', calcPct: '',
};

// ---------- URL state (kept in the #fragment, which browsers never send to a server) ----------

function centsToPlain(c) {
  const neg = c < 0;
  const abs = Math.abs(c);
  let s = String(Math.floor(abs / 100));
  const frac = abs % 100;
  if (frac) s += '.' + String(frac).padStart(2, '0').replace(/0$/, '');
  return (neg ? '-' : '') + s;
}

function readHash() {
  Object.assign(state, { ...DEFAULTS, balances: [], calcHighest: '', calcTotal: '', calcPct: '' });
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has('s')) state.start = p.get('s');
  if (p.has('t')) state.target = p.get('t');
  if (p.has('c')) state.pct = p.get('c');
  // An older link may carry d= (minimum days, since removed); it is ignored.
  if (p.has('b')) {
    state.balances = p.get('b').split('_').slice(0, MAX_ROWS).map((part) => {
      try { return decodeURIComponent(part); } catch { return part; }
    });
  }
  state.calcHighest = p.get('ch') || '';
  state.calcTotal = p.get('ct') || '';
  state.calcPct = p.get('cp') || '';
}

function writeHash() {
  const p = new URLSearchParams();
  p.set('s', state.start.trim());
  p.set('t', state.target.trim());
  p.set('c', state.pct.trim());
  // A row that is not a number keeps its exact text in the link (escaped, so "_" cannot split
  // it), so a shared case still shows the same error instead of a verdict without that row.
  const bal = state.balances.map((raw) => {
    const v = parseMoney(raw);
    return v === null ? encodeURIComponent(raw.trim()).replace(/_/g, '%5F') : centsToPlain(v);
  });
  while (bal.length && bal[bal.length - 1] === '') bal.pop();
  if (bal.length) p.set('b', bal.join('_'));
  if (state.calcHighest.trim()) p.set('ch', state.calcHighest.trim());
  if (state.calcTotal.trim()) p.set('ct', state.calcTotal.trim());
  if (state.calcPct.trim()) p.set('cp', state.calcPct.trim());
  history.replaceState(null, '', '#' + p.toString());
}

// ---------- the daily table ----------

function rowCount() {
  return Math.min(MAX_ROWS, Math.max(START_ROWS, state.balances.length));
}

function ensureRows() {
  while (state.balances.length < rowCount()) state.balances.push('');
}

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

function buildRows() {
  ensureRows();
  els.rows.replaceChildren();
  state.balances.forEach((raw, i) => {
    const tr = el('tr');
    tr.append(el('td', { class: 'day' }));
    const tdIn = el('td');
    const input = el('input', { inputmode: 'decimal', autocomplete: 'off', 'aria-label': `Balance, row ${i + 1}` });
    input.value = raw;
    input.dataset.row = String(i);
    tdIn.append(input);
    tr.append(tdIn, el('td', { class: 'num pnl' }), el('td', { class: 'num share' }), el('td', { class: 'num okat' }));
    const tdBtn = el('td');
    const btn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Clear row ${i + 1}`, title: 'Clear this row' }, '✕');
    btn.dataset.clear = String(i);
    tdBtn.append(btn);
    tr.append(tdBtn);
    els.rows.append(tr);
  });
}

els.rows.addEventListener('input', (e) => {
  const i = e.target.dataset?.row;
  if (i === undefined) return;
  state.balances[Number(i)] = e.target.value;
  els.pasteNote.hidden = true;
  update();
});

// Pasting several lines fills this row and the ones below it, and clears any older balances
// further down, so leftovers from an earlier case never count as traded days.
els.rows.addEventListener('paste', (e) => {
  const i = e.target.dataset?.row;
  if (i === undefined) return;
  const text = (e.clipboardData?.getData('text') ?? '').trim();
  // A plain single value pastes normally; several lines, or one line with columns, are parsed.
  if (!/\r?\n|\t/.test(text)) return;
  const entries = parsePastedBalances(text);
  if (!entries.length) return;
  e.preventDefault();
  let row = Number(i);
  const several = [];
  const unreadable = [];
  let dropped = 0;
  for (const entry of entries) {
    if (row >= MAX_ROWS) { dropped++; continue; }
    while (state.balances.length <= row) state.balances.push('');
    state.balances[row] = entry.value === null ? entry.raw : centsToPlain(entry.value);
    if (entry.problem === 'several') several.push(row + 1);
    if (entry.problem === 'unreadable') unreadable.push(row + 1);
    row++;
  }
  const lastPasted = row - 1;
  // A pasted column replaces everything below it; a single pasted line only fills its row.
  if (/\r?\n/.test(text)) state.balances.length = Math.min(state.balances.length, row);
  const rowsText = (list) => `Row${list.length > 1 ? 's' : ''} ${list.join(', ')}`;
  const notes = [];
  if (several.length) notes.push(`${rowsText(several)}: the line had more than one amount, so it was left as pasted. Type the balance in.`);
  if (unreadable.length) notes.push(`${rowsText(unreadable)}: no balance could be read from the line. Type it in.`);
  if (dropped) notes.push(`${dropped} line${dropped > 1 ? 's' : ''} past row ${MAX_ROWS} ${dropped > 1 ? 'were' : 'was'} left out.`);
  showNote(notes.join(' ')); // update() below keeps it up once
  buildRows();
  update();
  els.rows.querySelector(`input[data-row="${lastPasted}"]`)?.focus();
});

els.rows.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-clear]');
  if (!btn) return;
  state.balances[Number(btn.dataset.clear)] = '';
  const input = els.rows.querySelector(`input[data-row="${btn.dataset.clear}"]`);
  if (input) input.value = '';
  update();
});

$('add-day').addEventListener('click', () => {
  if (state.balances.length >= MAX_ROWS) return;
  state.balances.push('');
  buildRows();
  update();
  els.rows.querySelector(`input[data-row="${state.balances.length - 1}"]`)?.focus();
});

$('clear-table').addEventListener('click', () => {
  if (!state.balances.some((b) => b.trim()) || confirm('Clear every balance in the table?')) {
    state.balances = [];
    els.pasteNote.hidden = true;
    buildRows();
    update();
  }
});

// ---------- settings and calculator inputs ----------

function bindInput(input, key) {
  input.value = state[key];
  input.addEventListener('input', () => { state[key] = input.value; update(); });
}

function bindAll() {
  bindInput(els.start, 'start');
  bindInput(els.target, 'target');
  bindInput(els.pct, 'pct');
  bindInput(els.cHighest, 'calcHighest');
  bindInput(els.cTotal, 'calcTotal');
  bindInput(els.cPct, 'calcPct');
}

$('clear-calc').addEventListener('click', () => {
  state.calcHighest = state.calcTotal = state.calcPct = '';
  els.cHighest.value = els.cTotal.value = els.cPct.value = '';
  update();
});

$('reset-all').addEventListener('click', () => {
  if (!confirm('Clear everything and go back to the defaults?')) return;
  Object.assign(state, { ...DEFAULTS, balances: [], calcHighest: '', calcTotal: '', calcPct: '' });
  for (const [input, key] of [[els.start, 'start'], [els.target, 'target'], [els.pct, 'pct'],
    [els.cHighest, 'calcHighest'], [els.cTotal, 'calcTotal'], [els.cPct, 'calcPct']]) input.value = state[key];
  els.pasteNote.hidden = true;
  buildRows();
  update();
});

const copyBtn = $('copy-link');
const COPY_LABEL = copyBtn.textContent;
let copyTimer;
copyBtn.addEventListener('click', async () => {
  writeHash();
  clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(location.href);
    copyBtn.textContent = 'Link copied';
    els.live.textContent = 'Link copied.';
  } catch {
    window.prompt('Copy this link:', location.href);
  }
  copyTimer = setTimeout(() => { copyBtn.textContent = COPY_LABEL; }, 1600);
});

// ---------- rendering ----------

function setInvalid(input, bad) { input.classList.toggle('invalid', bad); }

function reasonItem(ok, text) {
  const li = el('li', { class: ok ? 'ok' : 'no' });
  li.append(el('span', { class: 'mark', 'aria-hidden': 'true' }, ok ? '✓' : '✗'), el('span', {}, text));
  return li;
}

// A note under the table (paste warnings, an opened or refused file) describes the page as it
// was at that moment, so the next change anywhere on the page takes it away.
let keepNoteOnce = false;
function showNote(text) {
  els.pasteNote.textContent = text;
  els.pasteNote.hidden = !text;
  keepNoteOnce = true;
}

function update() {
  if (keepNoteOnce) keepNoteOnce = false;
  else els.pasteNote.hidden = true;
  const startCents = parseMoney(state.start);
  const targetCents = parseMoney(state.target);
  const pctBp = parsePercent(state.pct);
  setInvalid(els.start, state.start.trim() !== '' && startCents === null);
  setInvalid(els.target, state.target.trim() !== '' && !(targetCents > 0));
  setInvalid(els.pct, state.pct.trim() !== '' && pctBp === null);

  const balances = [];
  const badRows = [];
  state.balances.forEach((raw, i) => {
    const input = els.rows.querySelector(`input[data-row="${i}"]`);
    if (!raw.trim()) { balances.push(null); input && setInvalid(input, false); return; }
    const v = parseMoney(raw);
    if (v === null) badRows.push(i + 1);
    input && setInvalid(input, v === null);
    balances.push(v);
  });

  const res = analyze({ startCents, targetCents, pctBp, balances });
  const errors = res.ready ? [] : res.errors.map((e) =>
    (e.startsWith('Enter the starting') && state.start.trim() ? 'The starting balance is not a number.' : e));
  if (badRows.length) errors.push(`Row${badRows.length > 1 ? 's' : ''} ${badRows.join(', ')}: not a number. Fix ${badRows.length > 1 ? 'them' : 'it'} to get a result.`);

  lastResult = { ...res, inputErrors: errors };
  renderVerdict(res, errors, pctBp);
  renderRows(res, errors.length === 0);
  renderInverse(res, errors.length === 0, pctBp, targetCents);
  renderChart(res, startCents, targetCents, errors.length === 0);
  renderCalc();
  writeHash();
}

let lastAnnounced = '';
function announce(text) {
  // Screen readers hear the verdict only when it changes, not on every keystroke.
  if (text === lastAnnounced) return;
  lastAnnounced = text;
  els.live.textContent = text;
}

function renderVerdict(res, errors, pctBp) {
  els.reasons.replaceChildren();
  const stats = [els.stTotal, els.stLargest, els.stShare, els.stRequired, els.stDays];
  if (errors.length) {
    els.badge.className = 'badge badge-wait';
    els.badge.textContent = 'Check the inputs';
    errors.forEach((e) => els.reasons.append(reasonItem(false, e)));
    stats.forEach((s) => { s.textContent = '–'; });
    announce('Check the inputs.');
    els.stats.hidden = true;
    return;
  }
  if (res.traded === 0) {
    els.badge.className = 'badge badge-wait';
    els.badge.textContent = 'Enter balances';
    stats.forEach((s) => { s.textContent = '–'; });
    announce('');
    els.stats.hidden = true;
    return;
  }
  els.badge.className = 'badge ' + (res.pass ? 'badge-pass' : 'badge-fail');
  els.badge.textContent = res.pass ? 'PASS' : 'FAIL';
  // Fixed phrases only, so typing a new figure does not re-announce an unchanged verdict.
  const NAMES = { consistency: 'consistency', target: 'profit target' };
  const failed = res.reasons.filter((r) => !r.ok).map((r) => NAMES[r.key]);
  announce(res.pass ? 'Pass.' : `Fail. Not met: ${failed.join(', ')}.`);
  els.stats.hidden = false;
  res.reasons.forEach((r) => els.reasons.append(reasonItem(r.ok, r.text)));
  els.stTotal.textContent = formatMoney(res.total);
  els.stLargest.textContent = res.largest > 0 ? `${formatMoney(res.largest)} (day ${res.largestDay})` : '–';
  els.stShare.textContent = res.largestShareBp !== null ? `${formatPercent(res.largestShareBp)} (limit ${formatPercent(pctBp)})` : '–';
  els.stRequired.textContent = formatMoney(res.requiredTotal);
  els.stDays.textContent = String(res.traded);
}

function renderRows(res, ok) {
  const byRow = new Map(ok ? res.days.map((d) => [d.row, d]) : []);
  [...els.rows.children].forEach((tr, i) => {
    const d = byRow.get(i);
    const [dayTd, , pnlTd, shareTd, okTd] = tr.children;
    tr.classList.toggle('largest', Boolean(d?.isLargest));
    dayTd.textContent = d ? String(d.day) : '–';
    pnlTd.textContent = d ? (d.pnl > 0 ? '+' : '') + formatMoney(d.pnl) : '';
    pnlTd.className = 'num pnl' + (d ? (d.pnl > 0 ? ' pos' : d.pnl < 0 ? ' neg' : '') : '');
    const over = d && d.shareBp !== null && d.okAtTotal > res.total;
    shareTd.textContent = d && d.shareBp !== null ? formatPercent(d.shareBp) : '';
    shareTd.className = 'num share' + (over ? ' over' : '');
    okTd.textContent = d && d.okAtTotal !== null ? formatMoney(d.okAtTotal) : '';
  });
}

function renderInverse(res, ok, pctBp, targetCents) {
  els.inverse.replaceChildren();
  const add = (t) => els.inverse.append(el('li', {}, t));
  if (!ok || res.traded === 0) {
    add('Enter the balances to see what the trader still needs.');
    return;
  }
  const inv = res.inverse;
  const lim = formatPercent(pctBp);
  if (inv.largest > 0) {
    add(res.consistent
      ? `The largest day (${formatMoney(inv.largest)}, day ${inv.largestDay}) is within ${lim} while total profit is at least ${formatMoney(inv.largestOkAtTotal)}.`
      : `The ${formatMoney(inv.largest)} day (day ${inv.largestDay}) becomes compliant once total profit reaches ${formatMoney(inv.largestOkAtTotal)}.`);
  }
  if (inv.requiredRaisedByConsistency) {
    add(`Because of that day, the profit target required is ${formatMoney(inv.requiredTotal)} instead of ${formatMoney(targetCents)}.`);
  }
  if (inv.stillNeeded > 0) add(`Total profit still needed to pass: ${formatMoney(inv.stillNeeded)}.`);

  const t = inv.tomorrow;
  if (t) {
    if (t.consistentNow) {
      add(t.upper === null
        ? 'Any profit on the next traded day keeps the account consistent.'
        : `The next traded day can make up to ${formatMoney(t.upper)} without breaking consistency.`);
    } else if (t.possible) {
      add(t.upper === null
        ? `A next traded day of at least ${formatMoney(t.lower)} makes the account consistent.`
        : `A next traded day of ${formatMoney(t.lower)} to ${formatMoney(t.upper)} makes the account consistent.`);
    } else if (inv.largest > 0) {
      add(`No single day can fix it: total profit must reach ${formatMoney(inv.largestOkAtTotal)}, and one day that big would become the new largest day. Spread it over days of at most ${formatMoney(inv.largest)} each.`);
    } else {
      add('No single winning day can make the account consistent from here: that day would be the whole profit.');
    }
    if (t.toTarget !== null && t.possible) {
      if (t.passInOneDay !== null) {
        add(t.passInOneDay === t.toTarget
          ? `Reaching the target on the next traded day takes ${formatMoney(t.toTarget)}, which stays consistent.`
          : `The ${formatMoney(t.toTarget)} still missing from the target is not enough on its own; reaching the target consistently in one day takes at least ${formatMoney(t.passInOneDay)}.`);
      } else {
        add(`Reaching the target in one day would take ${formatMoney(t.toTarget)}, more than the ${formatMoney(t.upper)} a consistent day allows, so it needs more than one day.`);
      }
    }
    if (inv.lossBuffer !== null) {
      add(inv.lossBuffer === 0
        ? 'Any loss on the next traded day breaks consistency (no room left under the limit).'
        : `A loss of more than ${formatMoney(inv.lossBuffer)} on the next traded day breaks consistency.`);
    }
  }
}

// ---------- chart ----------

const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}

let chartPoints = [];
let hideTip = () => {};
document.addEventListener('pointerdown', (e) => { if (!els.chart.contains(e.target)) hideTip(); });

function niceTicks(lo, hi, count) {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

function shortMoney(cents) {
  const d = cents / 100;
  const a = Math.abs(d);
  if (a >= 1e6) return `${d < 0 ? '-' : ''}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${d < 0 ? '-' : ''}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return formatMoney(Math.round(cents / 100) * 100).replace(/\.00$/, '');
}

function renderChart(res, startCents, targetCents, ok) {
  const svg = els.chart;
  const W = Math.max(280, svg.clientWidth || 600);
  const H = 220;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  els.tip.hidden = true;
  chartPoints = [];
  hideTip = () => {};
  if (!ok || res.traded === 0) {
    svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty' }, 'The balance curve appears here.'));
    return;
  }
  const pts = [{ day: 0, balance: startCents, pnl: null }, ...res.days.map((d) => ({ day: d.day, balance: d.balance, pnl: d.pnl, isLargest: d.isLargest }))];
  const goal = startCents + targetCents;
  let lo = Math.min(goal, ...pts.map((p) => p.balance));
  let hi = Math.max(goal, ...pts.map((p) => p.balance));
  const pad = (hi - lo) * 0.08 || 100;
  lo -= pad; hi += pad;
  const m = { l: 52, r: 12, t: 12, b: 24 };
  const x = (i) => m.l + (pts.length === 1 ? 0 : (i / (pts.length - 1)) * (W - m.l - m.r));
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  for (const v of niceTicks(lo, hi, 4)) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'grid' }));
    svg.append(s('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, shortMoney(v)));
  }
  const step = Math.max(1, Math.ceil(pts.length / 8));
  const last = pts.length - 1;
  pts.forEach((p, i) => {
    // The last day always gets a label; a step label too close to it is skipped.
    const tooClose = i !== last && x(last) - x(i) < 22;
    if ((i % step === 0 && !tooClose) || i === last) {
      svg.append(s('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', class: 'axis' }, i === 0 ? 'Start' : String(p.day)));
    }
  });
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(goal), y2: y(goal), class: 'target' }));
  // At the left, away from where the curve usually ends; a halo keeps it legible over the line.
  svg.append(s('text', { x: m.l + 4, y: y(goal) - 5, 'text-anchor': 'start', class: 'target-label' }, `Target ${formatMoney(goal).replace(/\.00$/, '')}`));
  svg.append(s('polyline', { points: pts.map((p, i) => `${x(i)},${y(p.balance)}`).join(' '), class: 'curve' }));
  const cross = s('line', { x1: 0, x2: 0, y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' });
  svg.append(cross);
  pts.forEach((p, i) => {
    svg.append(s('circle', { cx: x(i), cy: y(p.balance), r: pts.length > 40 ? 2.5 : 4, class: p.isLargest ? 'dot dot-hi' : 'dot' }));
    chartPoints.push({ x: x(i), y: y(p.balance), p });
  });
  const show = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = chartPoints[0];
    for (const c of chartPoints) if (Math.abs(c.x - px) < Math.abs(best.x - px)) best = c;
    cross.setAttribute('x1', best.x); cross.setAttribute('x2', best.x); cross.setAttribute('visibility', 'visible');
    const tip = els.tip;
    tip.replaceChildren(
      el('div', {}, best.p.day === 0 ? `Start: ${formatMoney(best.p.balance)}` : `Day ${best.p.day}: ${formatMoney(best.p.balance)}`),
    );
    if (best.p.pnl !== null) tip.append(el('div', { class: 'tip-sub' }, `${best.p.pnl > 0 ? '+' : ''}${formatMoney(best.p.pnl)}${best.p.isLargest ? ' (largest day)' : ''}`));
    tip.hidden = false;
    const scale = r.width / W;
    const left = Math.min(Math.max(best.x * scale + 10, 0), r.width - tip.offsetWidth);
    tip.style.left = `${best.x * scale + 10 + tip.offsetWidth > r.width ? best.x * scale - tip.offsetWidth - 10 : left}px`;
    tip.style.top = `${Math.max(0, best.y * (r.height / H) - tip.offsetHeight - 8)}px`;
  };
  hideTip = () => { els.tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
  svg.onpointermove = show;
  svg.onpointerdown = show; // a tap on a phone
  // A lifted finger fires pointerleave at once, so on touch the tip stays until a tap elsewhere.
  svg.onpointerleave = (e) => { if (e.pointerType !== 'touch') hideTip(); };
}

// ---------- calculator ----------

function renderCalc() {
  const raw = { h: state.calcHighest.trim(), t: state.calcTotal.trim(), p: state.calcPct.trim() };
  const highest = raw.h ? parseMoney(raw.h) : null;
  const total = raw.t ? parseMoney(raw.t) : null;
  const pct = raw.p ? parsePercent(raw.p) : null;
  setInvalid(els.cHighest, Boolean(raw.h) && highest === null);
  setInvalid(els.cTotal, Boolean(raw.t) && total === null);
  setInvalid(els.cPct, Boolean(raw.p) && pct === null);
  const out = els.calcOut;
  if ((raw.h && highest === null) || (raw.t && total === null) || (raw.p && pct === null)) {
    out.textContent = 'One of the fields is not a number.';
    return;
  }
  const r = calculate({ highest, total, pctBp: pct, defaultPctBp: 3000 });
  if (r.error) { out.textContent = r.error; return; }
  if (!r.solved) {
    // The sheet's own message when only the % is filled in.
    out.textContent = raw.p ? 'Insert a value in Highest profit or Total profit.' : '';
    return;
  }
  const assumed = r.assumed ? ' (limit taken as 30%)' : '';
  if (r.solved === 'pct') {
    let t = `The highest profit is ${formatPercent(r.pctBp)} of total profit.`;
    if (r.limitBp !== null) {
      t += r.ok
        ? ` Within the ${formatPercent(r.limitBp)} limit.`
        : ` Over the ${formatPercent(r.limitBp)} limit: compliant once total profit reaches ${formatMoney(r.okAtTotal)}.`;
    }
    out.textContent = t;
  } else if (r.solved === 'total') {
    out.textContent = `A ${formatMoney(r.highest)} day needs total profit of at least ${formatMoney(r.total)}${assumed}.`;
  } else {
    out.textContent = `With ${formatMoney(r.total)} total profit, the largest day can be at most ${formatMoney(r.highest)}${assumed}.`;
  }
}

// ---------- save to file / open saved file ----------

let lastResult = null;

function chicagoDate(d = new Date()) {
  // en-CA writes YYYY-MM-DD; the date is Chicago's, whatever the viewer's own time zone.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

$('save-file').addEventListener('click', () => {
  const day = chicagoDate();
  const csv = buildCsv(state, lastResult, day);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: `consistency-check-${day}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  // iPhone Safari asks before downloading, so the link must outlive that question.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

const fileInput = $('file-input');
$('open-file').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  let data;
  try {
    data = file.size > 2_000_000 ? { error: 'That file is too big to be a saved case.' } : readSavedCsv(await file.text());
  } catch {
    data = { error: 'That file could not be read.' };
  }
  if (data.error) {
    // No update() follows, so the next change on the page takes this note away.
    els.pasteNote.textContent = data.error;
    els.pasteNote.hidden = false;
    keepNoteOnce = false;
    return;
  }
  const hasWork = state.balances.some((b) => b.trim())
    || ['start', 'target', 'pct'].some((k) => state[k].trim() !== DEFAULTS[k])
    || [state.calcHighest, state.calcTotal, state.calcPct].some((v) => v.trim());
  if (hasWork && !confirm('Replace what is on the page with the saved file?')) return;
  Object.assign(state, { ...DEFAULTS, balances: [], calcHighest: '', calcTotal: '', calcPct: '' });
  for (const key of ['start', 'target', 'pct', 'calcHighest', 'calcTotal', 'calcPct']) {
    if (typeof data[key] === 'string') state[key] = data[key];
  }
  state.balances = data.balances.slice(0, MAX_ROWS);
  for (const [input, key] of [[els.start, 'start'], [els.target, 'target'], [els.pct, 'pct'],
    [els.cHighest, 'calcHighest'], [els.cTotal, 'calcTotal'], [els.cPct, 'calcPct']]) input.value = state[key];
  showNote(`Opened ${file.name}.`); // update() below keeps it up once
  buildRows();
  update();
});

// ---------- start ----------

readHash();
bindAll();
buildRows();
update();
window.addEventListener('hashchange', () => {
  readHash();
  els.pasteNote.hidden = true;
  for (const [input, key] of [[els.start, 'start'], [els.target, 'target'], [els.pct, 'pct'],
    [els.cHighest, 'calcHighest'], [els.cTotal, 'calcTotal'], [els.cPct, 'calcPct']]) input.value = state[key];
  buildRows();
  update();
});
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => {
  // A resize (a phone turning, Safari's bar folding away) only redraws: any note stays up.
  keepNoteOnce = true;
  update();
}, 120); });
