import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, parsePercent, analyze, buildCsv, readSavedCsv, parseCsvRows } from '../logic.js';

const fromPnl = (pnls, start = 50000) => {
  let b = start;
  return pnls.map((p) => (b += p));
};
const pageState = (over = {}) => ({
  start: '50000', target: '3000', pct: '30', minDays: '10', calcHighest: '', calcTotal: '', calcPct: '',
  balances: [], ...over,
});
// The same result the page builds: analyze() plus whether any row is not a number.
const resultFor = (st) => {
  const balances = st.balances.map((b) => (String(b).trim() ? parseMoney(b) : null));
  const bad = st.balances.some((b) => String(b).trim() && parseMoney(b) === null);
  const r = analyze({ startCents: parseMoney(st.start), targetCents: parseMoney(st.target),
    pctBp: parsePercent(st.pct), minDays: Number(st.minDays), balances });
  return { ...r, inputErrors: bad ? ['Row: not a number.'] : [] };
};

test('save file: a passing case writes settings, verdict and every day', () => {
  const pnls = [600, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 225, 100, 100];
  const st = pageState({ balances: fromPnl(pnls).map(String) });
  const csv = buildCsv(st, resultFor(st), '2026-10-22');
  assert.ok(csv.startsWith('﻿Consistency check\r\n'));
  assert.match(csv, /\r\nSaved,2026-10-22 \(Chicago\)\r\n/);
  assert.match(csv, /\r\nResult,PASS\r\n/);
  assert.match(csv, /\r\nTotal profit,3225\.00\r\n/);
  assert.match(csv, /\r\nLargest day share \(%\),18\.61\r\n/);
  assert.match(csv, /\r\nMet,"Largest day is 18\.61% of total profit, limit 30%\."\r\n/);
  assert.match(csv, /\r\nRow,Day,Balance,Profit\/loss,Share of total \(%\),OK once total profit reaches\r\n1,1,50600\.00,600\.00,18\.61,2000\.00\r\n/);
  assert.match(csv, /\r\n15,15,53225\.00,100\.00,3\.11,333\.34\r\n$/);
});

test('save file: a failing case says FAIL and which rule is not met', () => {
  const st = pageState({ minDays: '10', balances: ['51200', '51400'] });
  const csv = buildCsv(st, resultFor(st), '2026-10-22');
  assert.match(csv, /\r\nResult,FAIL\r\n/);
  assert.match(csv, /\r\nNot met,"Largest day \(\$1,200\.00, day 1\) is 85\.72% of total profit, limit 30%\."\r\n/);
});

test('save file: round trip gives back exactly the inputs', () => {
  const st = pageState({
    start: '50,000', target: '3000', pct: '30', minDays: '10', calcHighest: '600', calcTotal: '3,225', calcPct: '',
    balances: ['50,600', '', '50,900.5', 'oops, "quoted"', '', ''],
  });
  const back = readSavedCsv(buildCsv(st, resultFor(st), '2026-10-22'));
  assert.equal(back.error, undefined);
  assert.equal(back.start, '50,000');
  assert.equal(back.minDays, '10');
  assert.equal(back.calcHighest, '600');
  assert.equal(back.calcTotal, '3,225');
  assert.equal(back.calcPct, '');
  // valid amounts come back as plain numbers, text exactly, trailing empty rows dropped
  assert.deepEqual(back.balances, ['50600.00', '', '50900.50', 'oops, "quoted"']);
});

test('save file: text that a spreadsheet would run as a formula is neutralised and restored', () => {
  const st = pageState({ start: '=HYPERLINK("x")', balances: ['=1+1', '+5x', '@SUM(A1)', '-x', '50,100'] });
  const csv = buildCsv(st, resultFor(st), '2026-10-22');
  for (const row of parseCsvRows(csv)) {
    for (const field of row) assert.ok(!/^[=+@]/.test(field), `unsafe field ${field}`);
    // a text field starting with "-" must be guarded too; a number may start with "-"
    for (const field of row) if (/^-/.test(field)) assert.ok(/^-\d+\.\d{2}$/.test(field), `unsafe field ${field}`);
  }
  assert.match(csv, /\r\nResult,Check the inputs\r\nProblem,"Row: not a number\."\r\n/);
  const back = readSavedCsv(csv);
  assert.equal(back.start, '=HYPERLINK("x")');
  assert.deepEqual(back.balances, ['=1+1', '+5x', '@SUM(A1)', '-x', '50100.00']);
});

test('save file: negative amounts stay plain numbers', () => {
  const st = pageState({ balances: ['49,700'] });
  const csv = buildCsv(st, resultFor(st), '2026-10-22');
  assert.match(csv, /\r\n1,1,49700\.00,-300\.00,,\r\n/);
});

test('save file: an empty page still writes a file that opens again', () => {
  const st = pageState();
  const csv = buildCsv(st, resultFor(st), '2026-10-22');
  assert.match(csv, /\r\nResult,No days entered\r\n/);
  assert.deepEqual(readSavedCsv(csv).balances, []);
});

test('open file: only the inputs are read, so an edited result column changes nothing', () => {
  const st = pageState({ balances: ['50600', '51000'] });
  const csv = buildCsv(st, resultFor(st), '2026-10-22')
    .replace('Result,FAIL', 'Result,PASS')
    .replace('1,1,50600.00,600.00', '1,1,50600.00,1.00');
  const back = readSavedCsv(csv);
  assert.equal(back.error, undefined);
  assert.deepEqual(back.balances, ['50600.00', '51000.00']);
});

test('open file: a copy saved again by a spreadsheet still opens', () => {
  const resaved = 'Consistency check;\r\nStarting balance;50000\r\nProfit target;3000\r\nConsistency limit (%);30\r\n' +
    'Minimum traded days;15\r\n;\r\nRow;Day;Balance;Profit/loss\r\n1;1;50600;600\r\n3;;50900;\r\n';
  const back = readSavedCsv(resaved);
  assert.equal(back.error, undefined);
  assert.equal(back.start, '50000');
  assert.deepEqual(back.balances, ['50600', '', '50900']);
});

test('open file: anything else is refused with a reason', () => {
  assert.ok(readSavedCsv('Date,Balance\n2026-10-01,50000\n').error);
  assert.ok(readSavedCsv('').error);
  assert.ok(readSavedCsv('Consistency check\nRow,Day,Balance\nx,1,50000\n').error);
  assert.ok(readSavedCsv('Consistency check\nRow,Day,Balance\n401,1,50000\n').error);
  assert.ok(readSavedCsv('Consistency check\nRow,Day,Balance\n0,1,50000\n').error);
});

test('csv rows: quotes, doubled quotes and line breaks inside quotes', () => {
  assert.deepEqual(parseCsvRows('a,"b,c","d ""e""","f\ng"\r\nh'), [['a', 'b,c', 'd "e"', 'f\ng'], ['h']]);
  assert.deepEqual(parseCsvRows('﻿x;y\n1;2'), [['x', 'y'], ['1', '2']]);
});

test('save file: a leading quote never turns a non-number into a number on reopening', () => {
  const st = pageState({ start: "'+50000", balances: ["'-5", "''=x", '50,100'] });
  const back = readSavedCsv(buildCsv(st, resultFor(st), '2026-10-22'));
  assert.equal(back.start, "'+50000");
  assert.deepEqual(back.balances, ["'-5", "''=x", '50100.00']);
  assert.equal(parseMoney(back.balances[0]), null); // still not a number, still an error
});

test('save file: typed text is always quoted, so ; and leading spaces cannot start a formula', () => {
  const st = pageState({ pct: 'x;=1+1', start: ' =HYPERLINK("x")', balances: ['a;=1+1', '\t=2'] });
  const csv = buildCsv(st, resultFor(st), '2026-10-22');
  assert.match(csv, /\r\nConsistency limit \(%\),"x;=1\+1"\r\n/);
  assert.match(csv, /\r\nStarting balance,"'=HYPERLINK\(""x""\)"\r\n/);
  assert.match(csv, /\r\n1,,"a;=1\+1",,,\r\n2,,"'=2",,,\r\n/);
  // split on ; the way a European spreadsheet would, outside quotes: no field starts a formula
  for (const row of parseCsvRows(csv.replace(/,/g, ';'))) {
    for (const f of row) assert.ok(!/^\s*[=+@]/.test(f) && !/^-[^\d]/.test(f), `unsafe field ${JSON.stringify(f)}`);
  }
});

test('open file: a semicolon copy without padding on the first line still opens', () => {
  const resaved = 'Consistency check\r\nStarting balance;50000\r\nProfit target;3000\r\nConsistency limit (%);30\r\n' +
    'Minimum traded days;10\r\n\r\nRow;Day;Balance;Profit/loss\r\n1;1;50600;600\r\n';
  const back = readSavedCsv(resaved);
  assert.equal(back.error, undefined);
  assert.equal(back.minDays, '10');
  assert.deepEqual(back.balances, ['50600']);
});

test('open file: missing, doubled or out-of-range lines are refused, never filled in', () => {
  const st = pageState({ balances: ['50600', '50800'] });
  const good = buildCsv(st, resultFor(st), '2026-10-22');
  assert.match(readSavedCsv(good.replace(/Starting balance,[^\r]*\r\n/, '')).error, /no "Starting balance" line/);
  // the page always uses 10 days, so any value, or no line at all, still opens
  assert.equal(readSavedCsv(good.replace('Minimum traded days,"10"', 'Minimum traded days,12')).error, undefined);
  const noDaysLine = good.replace(/Minimum traded days,[^\r]*\r\n/, '');
  assert.ok(!noDaysLine.includes('Minimum traded days'));
  assert.equal(readSavedCsv(noDaysLine).error, undefined);
  assert.match(readSavedCsv(good.replace('Profit target,"3000"', 'Profit target,"3000"\r\nProfit target,"9000"')).error, /appears twice/);
  assert.match(readSavedCsv(good + '1,,99999,,,\r\n').error, /Row 1 appears twice/);
  assert.match(readSavedCsv(good + '401,,1,,,\r\n').error, /past the last row \(400\)/);
  assert.match(readSavedCsv(good + '1.5,,1,,,\r\n').error, /not a row number/);
  assert.equal(readSavedCsv(good).error, undefined);
});
