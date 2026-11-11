import assert from "node:assert/strict";
import { test } from "node:test";
import { calculate, formatBreakdown, fullYears, parseDate, readInputs, statutoryWeeks, taxOnTop } from "../src/redundancy.js";

const date = (text) => parseDate(text);

test("dates parse in UK and ISO form, and bad dates are refused", () => {
  assert.deepEqual(date("01/03/2015"), { y: 2015, m: 3, d: 1 });
  assert.deepEqual(date("2015-03-01"), { y: 2015, m: 3, d: 1 });
  assert.equal(date("31/02/2020"), null);
  assert.equal(date("March 2015"), null);
});

test("only whole years of employment count", () => {
  assert.equal(fullYears(date("10/11/2020"), date("09/11/2026")), 5);
  assert.equal(fullYears(date("10/11/2020"), date("10/11/2026")), 6);
});

test("statutory weeks match the GOV.UK table", () => {
  assert.equal(statutoryWeeks(42, 2).weeks, 2.5); // one year at 41+, one at 22-40
  assert.equal(statutoryWeeks(22, 2).weeks, 1);
  assert.equal(statutoryWeeks(23, 2).weeks, 1.5);
  assert.equal(statutoryWeeks(45, 10).weeks, 12);
  assert.equal(statutoryWeeks(61, 25).weeks, 30); // capped at 20 years
  assert.equal(statutoryWeeks(30, 1).weeks, 0); // under 2 years: not eligible
});

test("a full worked example", () => {
  const r = calculate({ start: date("01/03/2015"), end: date("10/11/2026"), age: 44, salary: 45000, holidayDays: 5, noticeWeeks: 12 });
  assert.equal(r.years, 11);
  assert.equal(r.statutory.weeks, 12.5); // 3 years at 41+ (4.5) + 8 years at 22-40 (8)
  assert.equal(r.statutoryPay, 9387.5); // weekly pay capped at £751
  assert.equal(r.enhancedWeeks, 12);
  assert.equal(r.enhancedPay, 10384.62);
  assert.equal(r.noticePay, 10384.62);
  assert.equal(r.holidayPay, 865.38);
  assert.equal(r.pilon, 11250);
  assert.equal(r.redundancyTaxable, 0); // 19,772.12 is under £30,000
  assert.equal(r.taxable, 11250); // just the PILON
  // On top of £45,000: £5,270 reaches the £50,270 threshold at 20%, the other £5,980 is at 40%.
  assert.deepEqual(r.taxBreakdown.slices.map((x) => [x.amount, x.rate, x.tax]), [[5270, 20, 1054], [5980, 40, 2392]]);
  assert.equal(r.tax, 3446);
  assert.equal(r.gross, 31022.12);
  assert.equal(r.net, 27576.12);

  const text = formatBreakdown(r);
  assert.match(text, /3 years aged 41 or over × 1\.5 = 4\.5 weeks/);
  assert.match(text, /£5,980\.00 × 40% \(higher rate\) = £2,392\.00/);
  assert.match(text, /Total after tax: £27,576\.12/);
  assert.ok(text.length < 2000, "fits in one Discord message");
});

test("enhanced weeks follow the service table", () => {
  const weeks = (years) => calculate({ start: { y: 2026 - years, m: 1, d: 1 }, end: date("01/06/2026"), age: 50, salary: 52000, holidayDays: 0, noticeWeeks: 0 }).enhancedWeeks;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 30].map(weeks), [5, 5, 6, 6, 7, 7, 7, 8, 9, 10, 11, 12, 13, 13, 13]);
});

test("redundancy pay over £30,000 is taxed on the excess", () => {
  const r = calculate({ start: date("01/01/2000"), end: date("01/06/2026"), age: 60, salary: 104000, holidayDays: 0, noticeWeeks: 0 });
  // Statutory: 20 years, 19 at 41+ (ages 59..41) and 1 at 40 = 29.5 weeks x 751; enhanced: 13 x 2000.
  assert.equal(r.statutoryPay, 22154.5);
  assert.equal(r.enhancedPay, 26000);
  assert.equal(r.redundancyTaxable, 18154.5);
  // All at 40%, plus 20% more because it falls where the personal allowance is withdrawn.
  assert.equal(r.taxBreakdown.taperTax, 3630.9);
  assert.equal(r.tax, 10892.7);
});

test("inputs are checked", () => {
  const today = { y: 2026, m: 11, d: 10 };
  const base = { age: 40, salary: 30000, holidayDays: 0, noticeWeeks: 4 };
  assert.match(readInputs({ ...base, startDate: "soon" }, today).problem, /start date/);
  assert.match(readInputs({ ...base, startDate: "01/01/2030" }, today).problem, /after the redundancy date/);
  assert.match(readInputs({ ...base, age: 20, startDate: "01/01/2000" }, today).problem, /doesn't fit/);
  assert.deepEqual(readInputs({ ...base, startDate: "01/01/2020" }, today).input.end, today);
});

test("tax follows the bands the extra pay falls into", () => {
  const rates = (salary, extra) => taxOnTop(salary, extra).slices.map((x) => [x.amount, x.rate]);
  assert.deepEqual(rates(30000, 10000), [[10000, 20]]);
  assert.deepEqual(rates(60000, 10000), [[10000, 40]]);
  assert.deepEqual(rates(120000, 10000), [[5140, 40], [4860, 45]]);
  assert.deepEqual(rates(40000, 100000), [[10270, 20], [74870, 40], [14860, 45]]);
  assert.equal(taxOnTop(30000, 10000).total, 2000);
  assert.equal(taxOnTop(30000, 10000).taperTax, 0);
  assert.equal(taxOnTop(120000, 10000).taperTax, 1028); // £5,140 in the withdrawal range
  assert.equal(taxOnTop(50000, 0).total, 0);
});
