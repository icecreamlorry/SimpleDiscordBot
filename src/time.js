export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// A scheduled purge only fires within this many minutes after its time, so a missed
// run is skipped rather than clearing a channel hours late.
export const RUN_WINDOW_MINUTES = 15;

/** Wall-clock date, minute-of-day and weekday (Monday = 0) in the given time zone. */
export function localNow(timeZone, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: SHORT_DAYS.indexOf(parts.weekday),
  };
}

/** Parses "H:MM" or "HH:MM" (24h) into a normalised "HH:MM", or null. */
export function parseTime(text) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function runsOn(schedule, now) {
  return schedule.day === "daily" || Number(schedule.day) === now.weekday;
}

/** True if today's slot for this schedule has already started. */
export function slotStarted(schedule, now) {
  return runsOn(schedule, now) && now.minutes >= toMinutes(schedule.time);
}

export function isDue(schedule, now) {
  if (schedule.last_run === now.date || !runsOn(schedule, now)) return false;
  const start = toMinutes(schedule.time);
  return now.minutes >= start && now.minutes < start + RUN_WINDOW_MINUTES;
}

export function describeDay(day) {
  return day === "daily" ? "every day" : `every ${DAY_NAMES[Number(day)]}`;
}
