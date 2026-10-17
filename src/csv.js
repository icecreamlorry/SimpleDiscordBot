export const MEMBER_CSV_HEADER = "username,server_display_name";

export function csvField(value) {
  let text = String(value ?? "");
  // Display names are free text; stop spreadsheet apps treating them as formulas.
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The name shown for a member in this server: server nickname, else global display name, else username. */
export function serverDisplayName(member) {
  return member.nick ?? member.user.global_name ?? member.user.username;
}

export function memberRow(member) {
  return `${csvField(member.user.username)},${csvField(serverDisplayName(member))}`;
}
