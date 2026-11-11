// /redundancy-pay: estimates a redundancy package and itemises how it was worked out.
// Nothing entered here is stored or logged.

// Statutory weekly pay cap.
export const WEEKLY_PAY_CAP = 751;
// Statutory pay needs 2 full years' service and only counts the most recent 20.
const STATUTORY_MIN_YEARS = 2;
const STATUTORY_MAX_YEARS = 20;
// Redundancy payments (statutory + enhanced together) are tax free up to this much.
export const TAX_FREE_LIMIT = 30000;
// Enhanced (ex-gratia) weeks of full pay by full years of service; 12+ years stays at 13.
const ENHANCED_WEEKS = [5, 5, 6, 6, 7, 7, 7, 8, 9, 10, 11, 12, 13];
const WORKING_DAYS_PER_YEAR = 260; // 52 weeks × 5 days

// Income tax bands for England, Wales and Northern Ireland, by total yearly income.
// The personal allowance is assumed to be used up by salary already.
const HIGHER_RATE_FROM = 50270;
const ADDITIONAL_RATE_FROM = 125140;
const TAX_BANDS = [
  { upTo: HIGHER_RATE_FROM, rate: 20, name: "basic rate" },
  { upTo: ADDITIONAL_RATE_FROM, rate: 40, name: "higher rate" },
  { upTo: Infinity, rate: 45, name: "additional rate" },
];
// Between these incomes the personal allowance is withdrawn, £1 for every £2 earned, and
// the withdrawn allowance is taxed at 40%: an extra 20% on income in this range.
const ALLOWANCE_TAPER = { from: 100000, to: ADDITIONAL_RATE_FROM, extraRate: 20 };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pence = (n) => Math.round(n * 100) / 100;
const money = (n) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const INDENT = "\u2003";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Parses DD/MM/YYYY (also with - or .) or YYYY-MM-DD into { y, m, d }, or null. */
export function parseDate(text) {
  const t = String(text).trim();
  let match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  let y, m, d;
  if (match) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return { y, m, d };
}

const formatDate = ({ y, m, d }) => `${d} ${MONTHS[m - 1]} ${y}`;
const dayNumber = ({ y, m, d }) => y * 10000 + m * 100 + d;

/** Complete years between two dates. */
export function fullYears(start, end) {
  const years = end.y - start.y - (end.m * 100 + end.d < start.m * 100 + start.d ? 1 : 0);
  return Math.max(0, years);
}

/**
 * Statutory weeks of pay. Counting back from the redundancy date, each full year of service
 * earns 1.5 weeks if the person was 41 or older at the start of it, 1 week if 22–40, and
 * half a week if under 22 (the same method as the GOV.UK table).
 */
export function statutoryWeeks(age, years) {
  const bands = [
    { label: "aged 41 or over", rate: 1.5, years: 0 },
    { label: "aged 22 to 40", rate: 1, years: 0 },
    { label: "aged under 22", rate: 0.5, years: 0 },
  ];
  if (years < STATUTORY_MIN_YEARS) return { weeks: 0, bands: [], counted: 0 };
  const counted = Math.min(years, STATUTORY_MAX_YEARS);
  for (let k = 1; k <= counted; k++) {
    const ageAtStart = age - k;
    bands[ageAtStart >= 41 ? 0 : ageAtStart >= 22 ? 1 : 2].years++;
  }
  const used = bands.filter((b) => b.years > 0);
  return { weeks: used.reduce((sum, b) => sum + b.years * b.rate, 0), bands: used, counted };
}

/**
 * Income tax on `extra` taxable pay received on top of a yearly `salary`: each slice is taxed
 * at the band it falls in. Returns the slices and the total.
 */
export function taxOnTop(salary, extra) {
  const top = salary + extra;
  const slices = [];
  let from = salary;
  for (const band of TAX_BANDS) {
    const amount = pence(Math.min(top, band.upTo) - Math.max(from, 0));
    if (top > from && band.upTo > from && amount > 0) {
      slices.push({ amount, rate: band.rate, name: band.name, tax: pence((amount * band.rate) / 100) });
      from = band.upTo;
    }
  }
  const tapered = pence(Math.max(0, Math.min(top, ALLOWANCE_TAPER.to) - Math.max(salary, ALLOWANCE_TAPER.from)));
  const taperTax = pence((tapered * ALLOWANCE_TAPER.extraRate) / 100);
  return { slices, tapered, taperTax, total: pence(slices.reduce((sum, x) => sum + x.tax, 0) + taperTax) };
}

/** Works out every part of the package. Money values are rounded to the penny. */
export function calculate({ start, end, age, salary, holidayDays, noticeWeeks }) {
  const years = fullYears(start, end);
  const weeklyPay = salary / 52;
  const cappedWeeklyPay = Math.min(weeklyPay, WEEKLY_PAY_CAP);
  const dailyPay = salary / WORKING_DAYS_PER_YEAR;

  const statutory = statutoryWeeks(age, years);
  const statutoryPay = pence(statutory.weeks * cappedWeeklyPay);

  const enhancedWeeks = ENHANCED_WEEKS[Math.min(years, ENHANCED_WEEKS.length - 1)];
  const enhancedPay = pence(enhancedWeeks * weeklyPay);

  const noticePay = pence(noticeWeeks * weeklyPay);
  const holidayPay = pence(holidayDays * dailyPay);
  const pilon = pence(noticePay + holidayPay);

  const redundancyTotal = pence(statutoryPay + enhancedPay);
  const redundancyTaxable = pence(Math.max(0, redundancyTotal - TAX_FREE_LIMIT));
  // Everything taxable sits on top of the year's salary.
  const taxable = pence(redundancyTaxable + pilon);
  const taxBreakdown = taxOnTop(salary, taxable);
  const tax = taxBreakdown.total;
  const gross = pence(redundancyTotal + pilon);

  return {
    start, end, age, salary, holidayDays, noticeWeeks,
    years, weeklyPay, cappedWeeklyPay, dailyPay,
    statutory, statutoryPay, enhancedWeeks, enhancedPay,
    noticePay, holidayPay, pilon,
    redundancyTotal, redundancyTaxable, taxable, taxBreakdown, tax,
    gross, net: pence(gross - tax),
  };
}

/** The itemised breakdown as a Discord message. */
export function formatBreakdown(r) {
  const lines = [
    "## Redundancy pay estimate",
    `Service: ${formatDate(r.start)} to ${formatDate(r.end)} = **${plural(r.years, "full year")}**`,
    `Weekly pay: ${money(r.salary)} ÷ 52 = ${money(r.weeklyPay)}`,
    "",
    "**1. Statutory redundancy pay**",
  ];
  if (r.years < STATUTORY_MIN_YEARS) {
    lines.push(`Not eligible: needs ${STATUTORY_MIN_YEARS} full years of service. ${money(0)}`);
  } else {
    if (r.weeklyPay > WEEKLY_PAY_CAP) lines.push(`Weekly pay is capped at ${money(WEEKLY_PAY_CAP)} for this part.`);
    if (r.years > STATUTORY_MAX_YEARS) lines.push(`Only the most recent ${STATUTORY_MAX_YEARS} years count.`);
    for (const b of r.statutory.bands) lines.push(`${plural(b.years, "year")} ${b.label} × ${b.rate} = ${plural(b.years * b.rate, "week")}`);
    lines.push(`${plural(r.statutory.weeks, "week")} × ${money(r.cappedWeeklyPay)} = **${money(r.statutoryPay)}**`);
  }
  lines.push(
    "",
    "**2. Enhanced redundancy pay (ex-gratia)**",
    `${plural(r.years, "year")} of service = ${plural(r.enhancedWeeks, "week")} × ${money(r.weeklyPay)} = **${money(r.enhancedPay)}**`,
    "",
    "**3. Payment in lieu of notice (PILON)**",
    `Notice: ${plural(r.noticeWeeks, "week")} × ${money(r.weeklyPay)} = ${money(r.noticePay)}`,
    `Holiday: ${plural(r.holidayDays, "day")} × ${money(r.dailyPay)} (salary ÷ ${WORKING_DAYS_PER_YEAR}) = ${money(r.holidayPay)}`,
    `PILON total = **${money(r.pilon)}**`,
    "",
    "**Tax**",
    `Redundancy payments (1 + 2) = ${money(r.redundancyTotal)}. The first ${money(TAX_FREE_LIMIT)} is tax free.`,
    r.redundancyTaxable > 0 ? `${money(r.redundancyTaxable)} is over the limit and taxable.` : "That's under the limit, so no tax on these.",
    `PILON ${money(r.pilon)} is taxable in full.`,
    `Taxable total = ${money(r.taxable)}, taxed on top of your ${money(r.salary)} salary:`,
    ...r.taxBreakdown.slices.map((x) => `${INDENT}${money(x.amount)} × ${x.rate}% (${x.name}) = ${money(x.tax)}`),
    ...(r.taxBreakdown.taperTax > 0
      ? [`${INDENT}${money(r.taxBreakdown.tapered)} falls between £100,000 and £125,140, where the personal allowance is withdrawn: + ${ALLOWANCE_TAPER.extraRate}% = ${money(r.taxBreakdown.taperTax)}`]
      : []),
    `Total tax = **${money(r.tax)}**`,
    "",
    `**Total before tax: ${money(r.gross)}**`,
    `**Total after tax: ${money(r.net)}**`,
    "",
    "-# Estimate only. Income tax uses England, Wales and NI bands and assumes this year's tax-free allowance is already used and the payout comes on top of a full year's salary. National Insurance isn't included. Holiday pay assumes a 5-day week.",
  );
  return lines.join("\n");
}

/** Validates the command's inputs. Returns { input } or { problem }. */
export function readInputs({ startDate, redundancyDate, age, salary, holidayDays, noticeWeeks }, today) {
  const start = parseDate(startDate);
  if (!start) return { problem: "I couldn't read the start date. Use DD/MM/YYYY, e.g. `01/03/2015`." };
  const end = redundancyDate ? parseDate(redundancyDate) : today;
  if (!end) return { problem: "I couldn't read the redundancy date. Use DD/MM/YYYY, e.g. `30/11/2026`." };
  if (dayNumber(start) > dayNumber(end)) return { problem: "The start date is after the redundancy date." };
  if (age - fullYears(start, end) < 13) return { problem: "That age doesn't fit with the start date. Check both." };
  return { input: { start, end, age, salary, holidayDays, noticeWeeks } };
}
