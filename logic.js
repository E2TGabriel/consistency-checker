// Consistency rule arithmetic. Pure functions, no DOM, so the tests can run them in Node.
//
// Money is held in integer cents and the consistency limit in basis points
// (30% = 3000), so every pass/fail comparison is exact integer arithmetic.
//
// The rule, as the "Maintain Consistency" sheet applies it:
//   daily P&L      = this day's balance minus the previous balance (day 1: minus the start)
//   total profit   = last balance minus the starting balance (the sum of daily P&L)
//   largest profit = the biggest winning day (losing days never count as the largest)
//   consistent     = total profit > 0 and largest profit <= limit x total profit
//   required total = max(profit target, largest profit / limit)
//   pass           = consistent AND total profit >= profit target AND traded days >= minimum

export const BP = 10000; // basis points in 100%
export const MAX_CENTS = 9e11; // $9,000,000,000

// ---------- parsing ----------

// "$50,123.45", "50123.45", "-120", "(120.00)", "+100", "100 USD" -> cents, else null.
export function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/−/g, '-');
  if (!s) return null;
  let neg = false;
  let signs = 0;
  if (/^\(.*\)$/.test(s)) { neg = true; signs++; s = s.slice(1, -1).trim(); }
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; signs++; s = s.slice(1).trim(); }
  s = s.replace(/^\$/, '').replace(/\s*usd$/i, '').trim();
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; signs++; s = s.slice(1).trim(); }
  if (signs > 1) return null; // "--5", "-(5)", "-$-5": not one amount
  s = s.replace(/ /g, ' ');
  // No spaces inside an amount: "1 250.00" could be $1,250.00 or a day number and $250, and
  // "1<tab>50123" is two pasted columns, so neither is one amount. Commas group thousands.
  // At most two decimals: "1.234" is a European thousands group, never $1.23.
  if (!/^(\d{1,3}(,\d{3})+|\d+)?(\.\d{0,2})?$/.test(s)) return null;
  if (!/\d/.test(s)) return null;
  s = s.replace(/,/g, '');
  const [intPart, fracPart = ''] = s.split('.');
  let cents = Number(intPart || '0') * 100 + Number((fracPart + '00').slice(0, 2));
  // Capped at $9 billion so cents x 10,000 stays an exact integer in every comparison.
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  if (neg && cents !== 0) cents = -cents;
  return cents;
}

// "30", "30%", "12.5 %" -> basis points (3000, 1250), else null. Above 0 and at most 100.
export function parsePercent(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/%$/, '').trim();
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(s)) return null;
  const bp = Math.round(Number(s) * 100);
  if (!(bp > 0 && bp <= BP)) return null;
  return bp;
}

// One balance per line. The page never guesses: a line it cannot read with certainty keeps
// its text in the row, where it shows as an error for staff to fix, instead of becoming a
// wrong balance or shifting the later rows up. Returns one entry per non-blank line, except
// header lines before the first line with a digit:
//   { value: cents, raw, line, problem: null }
//   { value: null,  raw, line, problem: 'several' }     more than one amount on the line
//   { value: null,  raw, line, problem: 'unreadable' }  anything else that is not plainly a balance
// A line is read when, after dropping dates, times and a few harmless words (balance, close,
// weekday names, $, USD...), exactly one amount is left. A day number before the balance is
// dropped too, but only where it is clearly a day number: in its own column
// ("1<tab>50,250.00"), written "1:" / "1." / "1)", or after the word "day". Anything with
// another word ("Realized P&L 250.00", "Trades 12 1,250.00") is refused, and so is a
// space-separated pair like "1 250.00", which could also be $1,250.00.
const DATE_OR_TIME = new RegExp('^(' + [
  '\\d{4}-\\d{2}-\\d{2}T[\\d:.]+(Z|[+-]\\d{2}:?\\d{2})?', // 2026-10-14T16:00:00
  '\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2},?', // 2026-10-14, 2026/10/14
  '\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4},?', // 14/10/2026, 10-14-26
  '\\d{1,2}/\\d{1,2},?', // 10/14
  '\\d{1,2}:\\d{2}(:\\d{2})?', // 14:30, 14:30:05
].join('|') + ')$');
const HARMLESS_WORDS = /^(\$|usd|balance|ending|closing|close|eod|equity|cash|day|am|pm|ct|cst|cdt|et|est|edt|(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day)?)[:,.]?$/i;
const DAY_NUMBER = /^\d{1,3}[:.)]?$/;

export function parsePastedBalances(text) {
  const out = [];
  let started = false;
  String(text).split(/\r?\n/).forEach((lineText, i) => {
    const raw = lineText.trim();
    if (!raw) return;
    const line = i + 1;
    const push = (value, problem = null) => out.push({ value, raw, line, problem });
    if (!/\d/.test(raw)) {
      // A header before the data is skipped; "#N/A" or "-" inside the data keeps its row, so
      // a missing day never folds its profit or loss into the next one.
      if (started) push(null, 'unreadable');
      return;
    }
    started = true;
    const hasColumns = /[\t;|]/.test(raw);
    const tokens = raw.split(/[\t;|]+|\s+/).filter(Boolean).filter((t) => !DATE_OR_TIME.test(t));
    const words = tokens.filter((t) => !/\d/.test(t));
    if (words.some((w) => !HARMLESS_WORDS.test(w))) { push(null, 'unreadable'); return; }
    let nums = tokens.filter((t) => /\d/.test(t));
    const saysDay = words.some((w) => /^day[:,.]?$/i.test(w));
    if (nums.length === 2 && DAY_NUMBER.test(nums[0]) && (hasColumns || saysDay || /[:.)]$/.test(nums[0]))) {
      nums = [nums[1]];
    } else if (saysDay && nums.length === 1) {
      push(null, 'unreadable'); // "Day 3": the number is the day, not a balance
      return;
    }
    if (nums.length > 1) { push(null, 'several'); return; }
    const value = parseMoney(nums[0]);
    if (value === null) push(null, 'unreadable');
    else push(value);
  });
  return out;
}

// ---------- formatting ----------

export function formatMoney(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}$${dollars}.${rest}`;
}

// basis points -> "18.6%"; whole percents print without decimals ("30%").
export function formatPercent(bp) {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return '';
  const neg = bp < 0;
  const abs = Math.abs(bp);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  let body = `${whole}`;
  if (frac !== 0) body += '.' + String(frac).padStart(2, '0').replace(/0$/, '');
  return `${neg ? '-' : ''}${body}%`;
}

// ---------- integer helpers ----------

function ceilDiv(a, b) { // b > 0
  return -Math.floor(-a / b);
}

// Share of total profit, in basis points, rounded UP so the shown figure never reads as
// compliant while the exact one fails. Null when total profit is not positive.
export function shareBp(dayCents, totalCents) {
  if (!(totalCents > 0)) return null;
  return ceilDiv(dayCents * BP, totalCents);
}

// The smallest total profit at which a day of `dayCents` is within the limit.
export function totalNeededFor(dayCents, pctBp) {
  if (!(dayCents > 0)) return 0;
  return ceilDiv(dayCents * BP, pctBp);
}

// ---------- the daily log ----------

export function analyze({ startCents, targetCents, pctBp, minDays, balances }) {
  const errors = [];
  if (startCents === null || startCents === undefined) errors.push('Enter the starting balance.');
  if (!(targetCents > 0)) errors.push('Enter a profit target above $0.');
  if (!(pctBp > 0 && pctBp <= BP)) errors.push('Enter a consistency limit above 0% and at most 100%.');
  if (!(Number.isInteger(minDays) && minDays >= 1)) errors.push('Choose the minimum number of traded days.');
  if (errors.length) return { ready: false, errors };

  const days = [];
  let prev = startCents;
  (balances || []).forEach((bal, row) => {
    if (bal === null || bal === undefined) return;
    days.push({ row, day: days.length + 1, balance: bal, pnl: bal - prev });
    prev = bal;
  });

  const traded = days.length;
  const total = prev - startCents;
  let largest = 0;
  let largestDay = null;
  for (const d of days) {
    if (d.pnl > largest) { largest = d.pnl; largestDay = d.day; }
  }
  for (const d of days) {
    d.shareBp = d.pnl > 0 ? shareBp(d.pnl, total) : null;
    d.okAtTotal = d.pnl > 0 ? totalNeededFor(d.pnl, pctBp) : null;
    d.isLargest = d.day === largestDay;
  }

  const largestShareBp = largest > 0 ? shareBp(largest, total) : null;
  const consistencyTotal = totalNeededFor(largest, pctBp); // total at which the largest day is fine
  const requiredTotal = Math.max(targetCents, consistencyTotal);
  const consistent = total > 0 && largest * BP <= pctBp * total;
  const targetMet = total >= targetCents;
  const daysMet = traded >= minDays;
  const pass = consistent && targetMet && daysMet;

  const reasons = [];
  if (traded === 0) {
    reasons.push({ ok: false, key: 'consistency', text: 'No trading days entered yet.' });
  } else if (total <= 0) {
    reasons.push({ ok: false, key: 'consistency',
      text: `No net profit yet (total ${formatMoney(total)}), so the consistency rule cannot pass.` });
  } else {
    reasons.push({ ok: consistent, key: 'consistency', text: consistent
      ? `Largest day is ${formatPercent(largestShareBp)} of total profit, limit ${formatPercent(pctBp)}.`
      : `Largest day (${formatMoney(largest)}, day ${largestDay}) is ${formatPercent(largestShareBp)} of total profit, limit ${formatPercent(pctBp)}.` });
  }
  reasons.push({ ok: targetMet, key: 'target', text: targetMet
    ? `Total profit ${formatMoney(total)} reaches the ${formatMoney(targetCents)} target.`
    : `Total profit ${formatMoney(total)} is below the ${formatMoney(targetCents)} target (${formatMoney(targetCents - total)} to go).` });
  reasons.push({ ok: daysMet, key: 'days', text: daysMet
    ? `${traded} of ${minDays} days traded.`
    : `${traded} of ${minDays} days traded (${minDays - traded} more needed).` });

  // ---------- the inverse numbers ----------
  const inverse = {
    requiredTotal,
    requiredRaisedByConsistency: consistencyTotal > targetCents,
    largest,
    largestDay,
    largestOkAtTotal: largest > 0 ? consistencyTotal : null,
    stillNeeded: Math.max(0, requiredTotal - total),
    tomorrow: null,
    lossBuffer: null,
  };

  if (traded > 0) {
    // One more day of profit p leaves the account consistent when total + p > 0 and
    //   p <= largest:  largest <= limit x (total + p)  ->  p >= consistencyTotal - total
    //   p >  largest:  p <= limit x (total + p)        ->  p <= limit x total / (1 - limit)
    // so the allowed days form the range [lower, upper] below (empty when lower > upper).
    const lower = Math.max(0, consistencyTotal - total, 1 - total);
    let capAsNewLargest;
    // At 100% a new largest day p needs p <= total + p, which holds for any p once total >= 0.
    if (pctBp >= BP) capAsNewLargest = total >= 0 ? Infinity : -Infinity;
    else if (total > 0) capAsNewLargest = Math.floor((pctBp * total) / (BP - pctBp));
    else capAsNewLargest = -Infinity;
    const upper = Math.max(largest, capAsNewLargest);
    const possible = lower <= upper;
    const t = {
      consistentNow: consistent,
      lower,
      upper: Number.isFinite(upper) ? upper : null,
      possible,
      toTarget: null,
      toTargetConsistent: null,
      passInOneDay: null,
    };
    if (!targetMet) {
      t.toTarget = targetCents - total;
      t.toTargetConsistent = possible && t.toTarget >= lower && t.toTarget <= upper;
      const best = Math.max(t.toTarget, lower);
      t.passInOneDay = possible && best <= upper ? best : null;
    }
    inverse.tomorrow = t;
    // The biggest loss tomorrow that keeps the account consistent.
    if (consistent) inverse.lossBuffer = total - consistencyTotal;
  }

  return {
    ready: true,
    errors: [],
    days,
    traded,
    total,
    largest,
    largestDay,
    largestShareBp,
    requiredTotal,
    consistent,
    targetMet,
    daysMet,
    pass,
    reasons,
    inverse,
  };
}

// ---------- the three-way calculator ----------
// Fill any two of highest profit, total profit and limit to get the third. With only one of
// the money fields filled, the limit falls back to `defaultPctBp` (30%), as the sheet does.
export function calculate({ highest, total, pctBp, defaultPctBp = 3000 }) {
  const has = (v) => v !== null && v !== undefined;
  if (has(highest) && highest <= 0) return { error: 'Highest profit must be above $0.' };
  if (has(total) && total <= 0) return { error: 'Total profit must be above $0.' };

  if (has(highest) && has(total)) {
    return {
      solved: 'pct',
      highest,
      total,
      pctBp: shareBp(highest, total),
      limitBp: has(pctBp) ? pctBp : null,
      ok: has(pctBp) ? highest * BP <= pctBp * total : null,
      okAtTotal: has(pctBp) ? totalNeededFor(highest, pctBp) : null,
    };
  }
  if (!has(highest) && !has(total)) return { solved: null };
  const limit = has(pctBp) ? pctBp : defaultPctBp;
  const assumed = !has(pctBp);
  if (has(highest)) {
    return { solved: 'total', highest, pctBp: limit, assumed, total: totalNeededFor(highest, limit) };
  }
  return { solved: 'highest', total, pctBp: limit, assumed, highest: Math.floor((total * limit) / BP) };
}

// ---------- save to file / open saved file ----------
// A CSV that opens in Excel or Google Sheets and that this page can read back. Money is
// written as plain numbers (50600.00) so spreadsheets treat it as numbers. Anything typed
// (settings, calculator fields, rows that are not a number) is written as quoted text, so a
// spreadsheet never splits it on ; or runs it as a formula: text starting with ' = + - @ or
// a tab gets one extra leading ' that opening the file takes off again.

const CSV_TITLE = 'Consistency check';
const SETTING_LABELS = {
  start: 'Starting balance',
  target: 'Profit target',
  pct: 'Consistency limit (%)',
  minDays: 'Minimum traded days',
  calcHighest: 'Calculator: highest profit',
  calcTotal: 'Calculator: total profit',
  calcPct: 'Calculator: highest / total (%)',
};
const REQUIRED_SETTINGS = ['start', 'target', 'pct', 'minDays'];
const TABLE_HEAD = ['Row', 'Day', 'Balance', 'Profit/loss', 'Share of total (%)', 'OK once total profit reaches'];
const MAX_FILE_ROWS = 400;

function plainMoney(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
function plainPercent(bp) {
  if (bp === null || bp === undefined) return '';
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;
}
// Typed text: trimmed, guarded, and always quoted when written.
function textCell(raw) {
  const s = String(raw ?? '').trim();
  return { text: /^['=+\-@\t\r]/.test(s) ? `'${s}` : s };
}
function untext(v) {
  const s = String(v ?? '').trim();
  return /^'['=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}
function csvField(v) {
  if (v && typeof v === 'object') return v.text === '' ? '' : `"${v.text.replace(/"/g, '""')}"`;
  const s = String(v ?? '');
  return /[",;\t\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// state: the page's raw inputs { start, target, pct, minDays, balances[], calcHighest, ... }
// result: analyze() output for those inputs, plus inputErrors: the page's error lines (empty
// when every input reads). savedOn: 'YYYY-MM-DD', Chicago's date.
export function buildCsv(state, result, savedOn) {
  // "2026-10-22 (Chicago)" is text to a spreadsheet, so it is never shown month first.
  const rows = [[CSV_TITLE], ['Saved', `${savedOn} (Chicago)`]];
  for (const [key, label] of Object.entries(SETTING_LABELS)) rows.push([label, textCell(state[key])]);
  const problems = result && result.inputErrors ? result.inputErrors : [];
  const valid = Boolean(result && result.ready) && problems.length === 0;
  rows.push(['Result', !valid ? 'Check the inputs' : result.traded === 0 ? 'No days entered' : result.pass ? 'PASS' : 'FAIL']);
  for (const p of problems) rows.push(['Problem', textCell(p)]);
  if (valid && result.traded > 0) {
    rows.push(['Total profit', plainMoney(result.total)]);
    rows.push(['Largest day', result.largest > 0 ? plainMoney(result.largest) : '']);
    rows.push(['Largest day share (%)', plainPercent(result.largestShareBp)]);
    rows.push(['Profit target required', plainMoney(result.requiredTotal)]);
    rows.push(['Days traded', String(result.traded)]);
    for (const r of result.reasons) rows.push([r.ok ? 'Met' : 'Not met', textCell(r.text)]);
  }
  rows.push([]);
  rows.push(TABLE_HEAD);
  const byRow = new Map(valid ? result.days.map((d) => [d.row, d]) : []);
  const balances = [...(state.balances || [])];
  while (balances.length && !String(balances[balances.length - 1]).trim()) balances.pop();
  balances.forEach((raw, i) => {
    const d = byRow.get(i);
    const cents = parseMoney(raw);
    const balance = String(raw).trim() === '' ? '' : cents === null ? textCell(raw) : plainMoney(cents);
    rows.push([
      String(i + 1),
      d ? String(d.day) : '',
      balance,
      d ? plainMoney(d.pnl) : '',
      d && d.shareBp !== null ? plainPercent(d.shareBp) : '',
      d && d.okAtTotal !== null ? plainMoney(d.okAtTotal) : '',
    ]);
  });
  return '﻿' + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

// Splits CSV text into rows of fields (quotes, doubled quotes, separators and line breaks
// inside quotes). The separator is read from the table's header line ("Row,Day,Balance"),
// so a copy saved again by a spreadsheet with ; or tabs opens too.
export function parseCsvRows(text) {
  const s = String(text).replace(/^﻿/, '');
  const head = s.split(/\r?\n/).find((l) => /^"?Row"?[,;\t]/.test(l.trim())) || s.split(/\r?\n/, 1)[0] || '';
  const sep = /^"?Row"?;/.test(head.trim()) ? ';' : /^"?Row"?\t/.test(head.trim()) ? '\t'
    : head.includes(',') ? ',' : head.includes(';') ? ';' : head.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Reads a file saved by buildCsv back into raw page inputs. Only the inputs are read; the
// page works every figure out again, so an edited result column can never change a verdict.
// Anything missing, doubled or out of range is refused with a reason rather than filled in.
export function readSavedCsv(text) {
  const notOurs = { error: 'This is not a file saved by this page.' };
  const rows = parseCsvRows(text);
  const titleAt = rows.findIndex((r) => (r[0] || '').trim() === CSV_TITLE);
  const headAt = rows.findIndex((r) => (r[0] || '').trim() === 'Row' && (r[2] || '').trim() === 'Balance');
  if (titleAt === -1 || headAt === -1 || headAt < titleAt) return notOurs;
  const out = { balances: [] };
  const byLabel = new Map();
  for (const r of rows.slice(titleAt + 1, headAt)) {
    const label = (r[0] || '').trim();
    if (!Object.values(SETTING_LABELS).includes(label)) continue;
    if (byLabel.has(label)) return { error: `"${label}" appears twice in the file.` };
    byLabel.set(label, r[1] ?? '');
  }
  for (const [key, label] of Object.entries(SETTING_LABELS)) {
    if (byLabel.has(label)) out[key] = untext(byLabel.get(label));
    else if (REQUIRED_SETTINGS.includes(key)) return { error: `The file has no "${label}" line.` };
    else out[key] = '';
  }
  if (!['15', '10'].includes(out.minDays)) {
    return { error: `Minimum traded days in the file is "${out.minDays}"; it must be 15 or 10.` };
  }
  const seen = new Set();
  for (const r of rows.slice(headAt + 1)) {
    if (r.every((f) => !String(f).trim())) continue;
    const label = (r[0] || '').trim();
    const n = /^\d+$/.test(label) ? Number(label) : NaN;
    if (!Number.isInteger(n) || n < 1) return { error: `"${label}" in the Row column of the file is not a row number.` };
    if (n > MAX_FILE_ROWS) return { error: `Row ${n} in the file is past the last row (${MAX_FILE_ROWS}).` };
    if (seen.has(n)) return { error: `Row ${n} appears twice in the file.` };
    seen.add(n);
    while (out.balances.length < n - 1) out.balances.push('');
    out.balances[n - 1] = untext(r[2]);
  }
  return out;
}
