import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMoney, parsePercent, parsePastedBalances, formatMoney, formatPercent,
  shareBp, totalNeededFor, analyze, calculate,
} from '../logic.js';

const D = (dollars) => Math.round(dollars * 100); // dollars -> cents
const base = { startCents: D(50000), targetCents: D(3000), pctBp: 3000, minDays: 15 };
const run = (balancesDollars, over = {}) =>
  analyze({ ...base, ...over, balances: balancesDollars.map((b) => (b === null ? null : D(b))) });

// Balances from a list of daily P&L, starting at $50,000.
const fromPnl = (pnls, start = 50000) => {
  let b = start;
  return pnls.map((p) => (b += p));
};

// ---------- parsing and formatting ----------

test('parseMoney reads common platform formats', () => {
  assert.equal(parseMoney('50,123.45'), 5012345);
  assert.equal(parseMoney('$50,123.45'), 5012345);
  assert.equal(parseMoney('50123.4'), 5012340);
  assert.equal(parseMoney('50123'), 5012300);
  assert.equal(parseMoney(' 50,123.45 '), 5012345);
  assert.equal(parseMoney('-120'), -12000);
  assert.equal(parseMoney('$-120.50'), -12050);
  assert.equal(parseMoney('-$120.50'), -12050);
  assert.equal(parseMoney('(120.50)'), -12050);
  assert.equal(parseMoney('+100'), 10000);
  assert.equal(parseMoney('−100'), -10000);
  assert.equal(parseMoney('.5'), 50);
  assert.equal(parseMoney('-0'), 0);
  assert.equal(parseMoney('100 USD'), 10000);
  assert.equal(parseMoney('1,234,567.89'), 123456789);
  assert.equal(parseMoney('9,000,000,000'), 9e11); // the cap itself is allowed
});

test('parseMoney rejects what is not one amount', () => {
  for (const bad of ['', '  ', 'abc', '2026-10-22', '1,23', '12,3456', '1.2.3', '$', '.', '--5', '-(5)', '-$-5', '5-', '1e5', null, undefined,
    // two columns glued together must never become one number
    '1\t50,123.45', '50000\t500', '1 2', '12 34', '1  234',
    // more than two decimals: a European thousands group, never rounded cents
    '1.234', '50.123', '1.005', '0.999', '50.000,00',
    // above the $9 billion cap
    '9,000,000,000.01', '100000000000']) {
    assert.equal(parseMoney(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parsePercent takes 0 < p <= 100', () => {
  assert.equal(parsePercent('30'), 3000);
  assert.equal(parsePercent('30%'), 3000);
  assert.equal(parsePercent('12.5 %'), 1250);
  assert.equal(parsePercent('100'), 10000);
  assert.equal(parsePercent('0.01'), 1);
  assert.equal(parsePercent('.5'), 50);
  assert.equal(parsePercent('0.29'), 29);
  assert.equal(parsePercent('33.33'), 3333);
  for (const bad of ['0', '-5', '100.01', '150', 'x', '', '0.001', '12.345']) assert.equal(parsePercent(bad), null, bad);
});

const values = (entries) => entries.map((e) => e.value);

test('pasted balances: one per line, header and blank lines skipped', () => {
  const text = 'Date\tBalance\n2026-10-01\t50,250.00\n2026-10-02\t50,100.50\r\n\n51000\n';
  const out = parsePastedBalances(text);
  assert.deepEqual(values(out), [5025000, 5010050, 5100000]);
  assert.deepEqual(out.map((e) => e.problem), [null, null, null]);
});

test('pasted balances: a day number is dropped only where it is clearly a day number', () => {
  const lines = ['1\t50,250.00', '2\t50250', '3;$50,300', '4|50,400.00', 'Day 5: 50,500.00', '6. 50,600',
    '7) $50,700.00', 'Day 8 50,800', 'day 9\t50,900'];
  assert.deepEqual(values(parsePastedBalances(lines.join('\n'))),
    [5025000, 5025000, 5030000, 5040000, 5050000, 5060000, 5070000, 5080000, 5090000]);
});

test('pasted balances: a space-separated pair is never split or glued', () => {
  const out = parsePastedBalances('1 250.00\n12 150 250.00\n50 123.45\n2 100 500.00');
  assert.deepEqual(values(out), [null, null, null, null]);
  assert.deepEqual(out.map((e) => e.problem), ['several', 'several', 'several', 'several']);
});

test('pasted balances: a line that cannot be read keeps its place as an error', () => {
  const out = parsePastedBalances('50,100\n50.100,00\n50,300');
  assert.deepEqual(values(out), [5010000, null, 5030000]);
  assert.equal(out[1].raw, '50.100,00');
  assert.equal(out[1].line, 2);
  assert.equal(out[1].problem, 'unreadable');
});

test('pasted balances: a gap inside the data keeps its row, so days never merge', () => {
  const out = parsePastedBalances('Date\tBalance\n1\t50,100.00\n#N/A\n3\t50,300.00\n-\nLoading...');
  assert.deepEqual(values(out), [5010000, null, 5030000, null, null]);
});

test('pasted balances: a day number beside an unreadable balance is never taken as the balance', () => {
  const out = parsePastedBalances('1\t50,600\n3\t50.900,00\n2026-10-03 14:30 51,000\n22-10-2026\t51,100');
  assert.deepEqual(values(out), [5060000, null, 5100000, 5110000]);
});

test('pasted balances: dates, times, weekdays and money words are ignored', () => {
  const lines = [
    '10/14/2026 50,123.45 USD',
    '10/14/2026 50123.45',
    '2026-10-14 USD 50,123.45',
    '50,123.45 $',
    'Mon 10/14 50123.45',
    'Tuesday, 10/14/2026, 50,123.45',
    '2026/10/14 50,123.45',
    '2026-10-14T16:00:00 50,123.45',
    '2026-10-14T16:00:00Z\t$50,123.45',
    '10/14/2026 4:00 PM CT 50,123.45',
    'Balance: $50,123.45',
    'EOD balance 50,123.45',
    '(50,123.45)',
  ];
  const out = parsePastedBalances(lines.join('\n'));
  assert.deepEqual(values(out), [...Array(lines.length - 1).fill(5012345), -5012345]);
});

test('pasted balances: a whole-dollar balance with a currency word is still read', () => {
  assert.deepEqual(values(parsePastedBalances('10/14/2026 50123 USD\n10/14/2026 $ 50123\nBalance 50250')),
    [5012300, 5012300, 5025000]);
});

test('pasted balances: never guesses between two amounts', () => {
  const out = parsePastedBalances('2026-10-16\t51,200.00\t+200.00\n50123.45 3\n50,000 51,000 52,000\n14 Oct 2026 50,250.00');
  assert.deepEqual(values(out), [null, null, null, null]);
  assert.deepEqual(out.map((e) => e.problem), ['several', 'several', 'several', 'unreadable']);
});

test('pasted balances: any other figure with a label is refused', () => {
  const lines = ['Realized P&L 250.00', 'Daily P&L: $1,250.00', 'Max Drawdown 2,500.00', 'Commission 4.50',
    'Net Liq 50,250.00', 'Trades 12 1,250.00', 'October 2026', 'Week 3', 'Account 12345', 'Day 1',
    'Total: 53,225.00', '10/14/2026\t$50,123.45\tClosed', '- 50'];
  const out = parsePastedBalances(lines.join('\n'));
  assert.deepEqual(values(out), Array(lines.length).fill(null));
  assert.ok(out.every((e) => e.problem === 'unreadable'));
});

test('formatting', () => {
  assert.equal(formatMoney(5012345), '$50,123.45');
  assert.equal(formatMoney(-12050), '-$120.50');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(5), '$0.05');
  assert.equal(formatPercent(3000), '30%');
  assert.equal(formatPercent(1860), '18.6%');
  assert.equal(formatPercent(1861), '18.61%');
  assert.equal(formatPercent(5), '0.05%');
  assert.equal(formatPercent(-1250), '-12.5%');
  assert.equal(formatMoney(null), '');
});

// ---------- the rule ----------

test('the example from the request: a $600 day in $3,225 total is 18.61% and passes', () => {
  const pnls = [600, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 225, 100, 100];
  const r = run(fromPnl(pnls));
  assert.equal(r.total, D(3225));
  assert.equal(r.largest, D(600));
  assert.equal(r.largestDay, 1);
  assert.equal(r.largestShareBp, 1861); // 18.6047% rounded up
  assert.equal(r.consistent, true);
  assert.equal(r.pass, true);
  assert.equal(r.inverse.largestOkAtTotal, D(2000)); // "the $600 day becomes compliant at $2,000"
  assert.equal(r.days[0].okAtTotal, D(2000));
  assert.equal(r.days[0].isLargest, true);
  assert.equal(r.days[1].isLargest, false);
  assert.equal(r.inverse.stillNeeded, 0);
  assert.equal(r.inverse.tomorrow.consistentNow, true);
  assert.equal(r.inverse.tomorrow.lower, 0);
  assert.equal(r.inverse.tomorrow.toTarget, null); // target met: no target sentences
  assert.equal(r.inverse.tomorrow.passInOneDay, null);
  assert.deepEqual(r.reasons.map((x) => x.ok), [true, true, true]);
});

test('exactly at the limit passes; one cent over fails', () => {
  const at = run(fromPnl([900, 700, 700, 700]), { minDays: 4 });
  assert.equal(at.total, D(3000));
  assert.equal(at.largestShareBp, 3000);
  assert.equal(at.consistent, true);
  assert.equal(at.pass, true);
  const over = run(fromPnl([900.01, 700, 700, 699.99]), { minDays: 4 });
  assert.equal(over.total, D(3000));
  assert.equal(over.consistent, false);
  assert.equal(over.pass, false);
  assert.equal(over.largestShareBp, 3001); // shown as 30.01%, never as a passing 30%
  assert.match(over.reasons[0].text, /\$900\.01, day 1\) is 30\.01% of total profit, limit 30%/);
  assert.equal(over.reasons[0].ok, false);
  assert.equal(over.inverse.tomorrow.consistentNow, false);
  assert.equal(at.inverse.requiredRaisedByConsistency, false); // $900 / 30% is exactly the target
});

test('losing days never count as the largest day but do lower the total', () => {
  const r = run(fromPnl([500, -1500, 800, 400, 900, 700, 600, 700]), { minDays: 8 });
  assert.equal(r.total, D(3100));
  assert.equal(r.largest, D(900));
  assert.equal(r.largestDay, 5);
  assert.equal(r.days[1].pnl, D(-1500));
  assert.equal(r.days[1].shareBp, null);
  assert.equal(r.consistent, true); // 900 / 3100 = 29.03%
  assert.equal(r.pass, true);
});

test('the profit target required rises above the target when one day is too big', () => {
  const r = run(fromPnl([1200, 600, 600, 600]), { minDays: 4 });
  assert.equal(r.total, D(3000));
  assert.equal(r.consistent, false);
  assert.equal(r.requiredTotal, D(4000));
  assert.equal(r.inverse.requiredRaisedByConsistency, true);
  assert.equal(r.inverse.stillNeeded, D(1000));
});

test('a single winning day is 100% of profit and fails', () => {
  const r = run([53000], { minDays: 1 });
  assert.equal(r.total, D(3000));
  assert.equal(r.largestShareBp, 10000);
  assert.equal(r.consistent, false);
  assert.equal(r.pass, false);
  assert.equal(r.requiredTotal, D(10000));
  assert.equal(r.inverse.tomorrow.possible, false); // needs $7,000 more, bigger than the $3,000 day
});

test('net loss: consistency cannot pass and nothing suggests otherwise', () => {
  const r = run(fromPnl([400, -900, -200]));
  assert.equal(r.total, D(-700));
  assert.equal(r.consistent, false);
  assert.equal(r.largestShareBp, null);
  assert.match(r.reasons[0].text, /No net profit yet \(total -\$700\.00\)/);
  assert.equal(r.inverse.lossBuffer, null);
  assert.equal(r.inverse.tomorrow.possible, false);
});

test('zero total: flat days count as traded but cannot pass', () => {
  const r = run([50000, 50000, 50000], { minDays: 3 });
  assert.equal(r.traded, 3);
  assert.equal(r.total, 0);
  assert.equal(r.largest, 0);
  assert.equal(r.consistent, false);
  assert.equal(r.daysMet, true);
  assert.equal(r.pass, false);
  assert.equal(r.inverse.tomorrow.possible, false);
});

test('no days entered', () => {
  const r = run([null, null]);
  assert.equal(r.traded, 0);
  assert.equal(r.pass, false);
  assert.equal(r.reasons[0].text, 'No trading days entered yet.');
  assert.equal(r.inverse.tomorrow, null);
});

test('blank rows are skipped and P&L runs from the previous filled balance', () => {
  const r = run([50300, null, 50100, null, null, 50600], { minDays: 3 });
  assert.equal(r.traded, 3);
  assert.deepEqual(r.days.map((d) => [d.row, d.day, d.pnl]), [[0, 1, D(300)], [2, 2, D(-200)], [5, 3, D(500)]]);
  assert.equal(r.total, D(600));
});

test('minimum days: 10 and 15', () => {
  const pnls = Array(12).fill(250); // $3,000 over 12 days, each 8.33%
  assert.equal(run(fromPnl(pnls), { minDays: 10 }).pass, true);
  const r15 = run(fromPnl(pnls), { minDays: 15 });
  assert.equal(r15.pass, false);
  assert.equal(r15.reasons[2].text, '12 of 15 days traded (3 more needed).');
});

test('profit target not met', () => {
  const r = run(fromPnl([200, 200, 200]), { minDays: 3 });
  assert.equal(r.targetMet, false);
  assert.match(r.reasons[1].text, /below the \$3,000\.00 target \(\$2,400\.00 to go\)/);
});

test('a 100% limit with a net loss: no single day can make it consistent', () => {
  const r = run([51000, 49000], { pctBp: 10000, minDays: 1 });
  assert.equal(r.total, D(-1000));
  assert.equal(r.inverse.tomorrow.possible, false);
  assert.equal(r.inverse.tomorrow.passInOneDay, null);
  assert.equal(r.inverse.tomorrow.toTargetConsistent, false);
});

test('a 100% limit at zero total: any winning day at least the old largest works', () => {
  const r = run([51000, 50000], { pctBp: 10000, minDays: 1 });
  assert.equal(r.total, 0);
  assert.equal(r.inverse.tomorrow.possible, true);
  assert.equal(r.inverse.tomorrow.lower, D(1000));
  assert.equal(r.inverse.tomorrow.upper, null);
});

test('two equal winning days: the first one is named as the largest', () => {
  const r = run(fromPnl([500, 500, 400]), { minDays: 3 });
  assert.equal(r.largestDay, 1);
  assert.deepEqual(r.days.map((d) => d.isLargest), [true, false, false]);
});

test('zero total leaves the per-day and largest-day figures empty', () => {
  const r = run([50000, 50000]);
  assert.equal(r.inverse.largestOkAtTotal, null);
});

test('a non-integer minimum and a missing start are refused', () => {
  assert.equal(analyze({ ...base, minDays: 1.5, balances: [] }).ready, false);
  assert.equal(analyze({ ...base, startCents: undefined, balances: [] }).ready, false);
});

test('a 100% limit never fails consistency on a profitable account without losses', () => {
  const r = run([53000], { minDays: 1, pctBp: 10000 });
  assert.equal(r.consistent, true);
  assert.equal(r.pass, true);
  assert.equal(r.inverse.tomorrow.upper, null); // no cap
});

test('bad settings return errors instead of a verdict', () => {
  assert.equal(analyze({ ...base, startCents: null, balances: [] }).ready, false);
  assert.equal(analyze({ ...base, targetCents: 0, balances: [] }).ready, false);
  assert.equal(analyze({ ...base, pctBp: 0, balances: [] }).ready, false);
  assert.equal(analyze({ ...base, pctBp: 10001, balances: [] }).ready, false);
  assert.equal(analyze({ ...base, minDays: 0, balances: [] }).ready, false);
});

test('helpers', () => {
  assert.equal(shareBp(D(600), D(3225)), 1861);
  assert.equal(shareBp(D(1), 0), null);
  assert.equal(shareBp(D(1), D(-5)), null);
  assert.equal(totalNeededFor(D(600), 3000), D(2000));
  assert.equal(totalNeededFor(D(100), 3000), 33334); // $333.333... rounds up to $333.34
  assert.equal(totalNeededFor(-5, 3000), 0);
});

// ---------- the inverse numbers, checked against brute force ----------

// Is the account consistent after adding one more day of `p` cents?
function consistentAfter(balances, p, pctBp) {
  const last = balances.length ? balances[balances.length - 1] : base.startCents;
  const r = analyze({ ...base, pctBp, balances: [...balances, last + p] });
  return r.consistent;
}

function rng(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
}

test('tomorrow window [lower, upper] matches brute force on random accounts', () => {
  const rand = rng(12345);
  let checked = 0;
  for (let n = 0; n < 400; n++) {
    const days = 1 + Math.floor(rand() * 8);
    const pnls = Array.from({ length: days }, () => Math.round((rand() * 1600 - 500) * 100));
    let b = base.startCents;
    const balances = pnls.map((p) => (b += p));
    const LIMITS = [1, 50, 1500, 2500, 3000, 4000, 5000, 9999, 10000];
    const pctBp = LIMITS[Math.floor(rand() * LIMITS.length)];
    const r = analyze({ ...base, pctBp, balances });
    const t = r.inverse.tomorrow;
    assert.ok(t.lower >= 0, `lower is never negative n=${n}`);
    if (t.consistentNow) assert.equal(t.lower, 0, `lower is 0 when consistent n=${n}`);
    // every boundary claim holds exactly at the cent
    if (t.possible) {
      assert.ok(consistentAfter(balances, t.lower, pctBp), `lower ok n=${n}`);
      if (t.upper !== null) {
        assert.ok(consistentAfter(balances, t.upper, pctBp), `upper ok n=${n}`);
        assert.ok(!consistentAfter(balances, t.upper + 1, pctBp), `upper+1 fails n=${n}`);
      }
      if (t.lower > 0) assert.ok(!consistentAfter(balances, t.lower - 1, pctBp), `lower-1 fails n=${n}`);
      const mid = t.upper === null ? t.lower * 2 + 1 : Math.floor((t.lower + t.upper) / 2);
      assert.ok(consistentAfter(balances, mid, pctBp), `mid ok n=${n}`);
    }
    // and a coarse scan never finds a consistent day the window says is impossible
    const hi = Math.max(1, Math.abs(r.total) * 4 + r.largest * 4);
    for (let k = 0; k <= 200; k++) {
      const p = Math.round((hi * k) / 200);
      const ok = consistentAfter(balances, p, pctBp);
      const inWindow = t.possible && p >= t.lower && (t.upper === null || p <= t.upper);
      assert.equal(ok, inWindow, `n=${n} p=${p} window=[${t.lower},${t.upper}] possible=${t.possible}`);
      checked++;
    }
    // the loss buffer
    if (r.inverse.lossBuffer !== null) {
      assert.ok(consistentAfter(balances, -r.inverse.lossBuffer, pctBp), `loss buffer ok n=${n}`);
      assert.ok(!consistentAfter(balances, -r.inverse.lossBuffer - 1, pctBp), `loss buffer +1 fails n=${n}`);
    }
    // whether a day of exactly the missing amount stays consistent
    if (t.toTarget !== null) {
      assert.equal(t.toTargetConsistent, consistentAfter(balances, t.toTarget, pctBp), `toTargetConsistent n=${n}`);
    }
    // the smallest single day that passes target + consistency
    if (t.toTarget !== null && t.passInOneDay === null && t.upper !== null) {
      // nothing from the target up to well past the window passes in one day
      for (const p of [t.toTarget, t.upper, t.upper + 1, t.toTarget * 2]) {
        const a = analyze({ ...base, pctBp, minDays: 1, balances: [...balances, balances.at(-1) + p] });
        assert.ok(!(a.consistent && a.targetMet), `no one-day pass n=${n} p=${p}`);
      }
    }
    if (t.toTarget !== null && t.passInOneDay !== null) {
      const after = (p) => analyze({ ...base, pctBp, minDays: 1, balances: [...balances, balances.at(-1) + p] });
      assert.ok(after(t.passInOneDay).consistent && after(t.passInOneDay).targetMet, `passInOneDay n=${n}`);
      if (t.passInOneDay > 0) {
        const prev = after(t.passInOneDay - 1);
        assert.ok(!(prev.consistent && prev.targetMet), `passInOneDay is the smallest n=${n}`);
      }
    }
  }
  assert.equal(checked, 400 * 201);
});

// Independent of analyze(): consistency from the raw P&L list in BigInt.
function oracleConsistent(pnls, pctBp) {
  const total = pnls.reduce((a, b) => a + BigInt(b), 0n);
  const largest = pnls.reduce((a, b) => (BigInt(b) > a ? BigInt(b) : a), 0n);
  return total > 0n && largest * 10000n <= BigInt(pctBp) * total;
}

test('the verdict agrees with an independent BigInt oracle', () => {
  const rand = rng(777);
  for (let n = 0; n < 3000; n++) {
    const days = 1 + Math.floor(rand() * 10);
    const pnls = Array.from({ length: days }, () => Math.round((rand() * 2000 - 600) * 100));
    const pctBp = [1, 2999, 3000, 3001, 5000, 10000][Math.floor(rand() * 6)];
    let b = base.startCents;
    const r = analyze({ ...base, pctBp, balances: pnls.map((p) => (b += p)) });
    assert.equal(r.consistent, oracleConsistent(pnls, pctBp), `n=${n}`);
  }
});

test('passInOneDay lands exactly on the top of the window', () => {
  const pnls = [600, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 225, 100, 100];
  const at = run(fromPnl(pnls), { targetCents: D(3225) + 138214 });
  assert.equal(at.inverse.tomorrow.passInOneDay, 138214);
  assert.equal(at.inverse.tomorrow.toTargetConsistent, true);
  const past = run(fromPnl(pnls), { targetCents: D(3225) + 138215 });
  assert.equal(past.inverse.tomorrow.passInOneDay, null);
  assert.equal(past.inverse.tomorrow.toTargetConsistent, false);
});

test('the request\'s "up to $X tomorrow" figure: $3,225 total, $600 largest', () => {
  const pnls = [600, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 225, 100, 100];
  const r = run(fromPnl(pnls));
  // p <= 0.3 x (3225 + p) -> p <= 1382.14
  assert.equal(r.inverse.tomorrow.upper, 138214);
  assert.equal(r.inverse.lossBuffer, D(1225)); // total can drop to $2,000
});

// ---------- the three-way calculator ----------

test('calculator: any two give the third', () => {
  const a = calculate({ highest: D(600), total: D(3225), pctBp: null });
  assert.equal(a.solved, 'pct');
  assert.equal(a.pctBp, 1861);
  assert.equal(a.ok, null);
  const b = calculate({ highest: D(600), total: null, pctBp: 3000 });
  assert.deepEqual([b.solved, b.total, b.assumed], ['total', D(2000), false]);
  const c = calculate({ highest: null, total: D(3225), pctBp: 3000 });
  assert.deepEqual([c.solved, c.highest], ['highest', 96750]);
});

test('calculator: one money field assumes 30%', () => {
  const b = calculate({ highest: D(600), total: null, pctBp: null });
  assert.deepEqual([b.solved, b.total, b.pctBp, b.assumed], ['total', D(2000), 3000, true]);
  const c = calculate({ highest: null, total: D(1000), pctBp: null });
  assert.deepEqual([c.solved, c.highest, c.assumed], ['highest', D(300), true]);
});

test('calculator: all three filled checks the pair against the limit', () => {
  const ok = calculate({ highest: D(900), total: D(3000), pctBp: 3000 });
  assert.equal(ok.ok, true);
  const bad = calculate({ highest: D(1200), total: D(3000), pctBp: 3000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.okAtTotal, D(4000));
});

test('calculator: rounding never overstates what is allowed', () => {
  const c = calculate({ highest: null, total: 333, pctBp: 3000 }); // $3.33 total
  assert.equal(c.highest, 99); // 0.999 -> 99 cents, never $1.00
  assert.ok(c.highest * 10000 <= 3000 * 333);
  const t = calculate({ highest: 100, total: null, pctBp: 3000 });
  assert.equal(t.total, 334);
  assert.ok(100 * 10000 <= 3000 * t.total);
});

test('calculator: empty, only a percent, and non-positive values', () => {
  assert.equal(calculate({ highest: null, total: null, pctBp: null }).solved, null);
  assert.equal(calculate({ highest: null, total: null, pctBp: 3000 }).solved, null);
  assert.ok(calculate({ highest: 0, total: D(10), pctBp: null }).error);
  assert.ok(calculate({ highest: D(10), total: D(-10), pctBp: null }).error);
  assert.ok(calculate({ highest: null, total: 0, pctBp: null }).error);
  assert.equal(calculate({ highest: D(900), total: D(3000), pctBp: 3000 }).limitBp, 3000);
  assert.equal(calculate({ highest: 60000 }).total, D(2000)); // omitted fields count as empty
});

test('parseMoney: no spaces inside an amount, so a row the paste note flags never counts', () => {
  for (const bad of ['1 250.00', '50 123.45', '1 234 567.89', '12 150 250.00', '50 123.45']) {
    assert.equal(parseMoney(bad), null, bad);
  }
  assert.equal(parseMoney(' - 50 '), -5000); // a space after the sign is fine
  assert.equal(parseMoney('$ 50,123.45'), 5012345);
});
