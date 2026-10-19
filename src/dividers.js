// Date dividers for anonymised channels: reposts lose their original times, so the bot posts
// "── 12 October 2026 ──" whenever the original posting date changes.
import { messageTime } from "./messages.js";
import { localNow } from "./time.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DIVIDER = new RegExp(`^── (\\d{1,2}) (${MONTHS.join("|")}) (\\d{4}) ──$`);

/** "2026-10-12" → "── 12 October 2026 ──" */
export function dividerText(date) {
  const [y, m, d] = date.split("-").map(Number);
  return `── ${d} ${MONTHS[m - 1]} ${y} ──`;
}

/** The date ("YYYY-MM-DD") a divider message marks, or null if it isn't one. */
export function dividerDate(content) {
  const match = DIVIDER.exec(content ?? "");
  if (!match) return null;
  const month = String(MONTHS.indexOf(match[2]) + 1).padStart(2, "0");
  return `${match[3]}-${month}-${match[1].padStart(2, "0")}`;
}

/** The local date ("YYYY-MM-DD") a message was posted, from its ID. */
export function messageDate(id, timeZone) {
  return localNow(timeZone, new Date(messageTime(id))).date;
}
