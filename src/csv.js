export const MEMBER_CSV_HEADER = "username,server_display_name,roles";

// Role names can contain commas, so roles are joined with this instead.
export const ROLE_SEPARATOR = "; ";

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

/**
 * Maps role ID -> { name, position } for a server's roles, leaving out @everyone
 * (whose ID is the server's ID) since every member has it.
 */
export function roleNameLookup(roles, guildId) {
  return new Map(roles.filter((r) => r.id !== guildId).map((r) => [r.id, { name: r.name, position: r.position }]));
}

/** A member's role names, highest role first, matching the order Discord shows them. */
export function memberRoles(member, roleNames) {
  return member.roles
    .map((id) => roleNames.get(id))
    .filter(Boolean)
    .sort((a, b) => b.position - a.position)
    .map((r) => r.name)
    .join(ROLE_SEPARATOR);
}

export function memberRow(member, roleNames = new Map()) {
  return [member.user.username, serverDisplayName(member), memberRoles(member, roleNames)].map(csvField).join(",");
}
