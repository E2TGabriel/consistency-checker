# Consistency Checker

A single static page that checks an evaluation's consistency rule. It replaces the
"Maintain Consistency" Google Sheet.

- No login, no backend, no database, no tracking, no outside requests. A Content Security
  Policy blocks the page from contacting anything.
- The case lives in the link's `#` fragment, which browsers never send to a server, so a
  shared link carries the numbers without them reaching GitHub.
- Updates as you type. Works on a phone. Follows the system's dark or light setting.

## The rule

- Daily profit or loss = that day's balance minus the previous one (day 1: minus the start).
- Total profit = last balance minus the starting balance.
- Largest day = the biggest winning day. Losing days never count as the largest.
- Consistent = total profit above $0 and largest day <= limit x total profit (exactly at the
  limit passes).
- Profit target required = max(profit target, largest day / limit).
- Pass = consistent, total profit >= profit target, and traded days >= the minimum (15 or 10).
  Every row with a balance counts as a traded day; empty rows are skipped.

Pasted text: one balance per line (paste the balance column, not daily profit or loss).
Dates, times, a few plain words (balance, close, weekday names, $, USD) and a day number in
its own column, or written "1:" / "1." / "1)" / "Day 1", are ignored. The page never
guesses: a line with any other word, more than one amount, or a space-separated pair such
as "1 250.00" stays in its row as an error to fix, and a note names those rows. A gap such
as "#N/A" inside the pasted data keeps its row, so two days never merge into one.

Money is held in integer cents and the limit in basis points, so pass or fail never depends
on floating point rounding. Shown percentages round up, so a failing share never displays
as the limit itself.

## Files

- `index.html`, `styles.css`, `app.js`: the page.
- `logic.js`: the rule, as pure functions.
- `tests/logic.test.js`: `npm test` (Node 18 or later, no packages).

Opening `index.html` straight from disk does not work (browsers block module scripts on
`file://`). Use the Pages link, or serve the folder, for example `python -m http.server`.

## Link format

`#s=50000&t=3000&c=30&d=15&b=50600_50800_51000` : starting balance, profit target,
limit %, minimum days, balances separated by `_` (an empty slot is an empty row).
`ch`, `ct`, `cp` hold the quick calculator's fields.
