// Turns a Discord poll into a text summary of its results, for reposting. Only vote totals
// are used, never who voted.

function emojiText(emoji) {
  if (!emoji) return "";
  return emoji.id ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : emoji.name;
}

const votes = (n) => `${n} ${n === 1 ? "vote" : "votes"}`;

/**
 * Example:
 *   📊 Poll: Where should we meet?
 *   🍕 Pizza place: 7 votes (54%)
 *   ☕ Café: 4 votes (31%)
 *   13 votes in total (poll closed, final results)
 */
export function formatPoll(poll, now = Date.now()) {
  const counts = new Map((poll.results?.answer_counts ?? []).map((c) => [c.id, c.count]));
  const hasResults = poll.results != null;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  const lines = [`📊 Poll: ${poll.question?.text ?? ""}`];
  for (const answer of poll.answers ?? []) {
    const label = [emojiText(answer.poll_media?.emoji), answer.poll_media?.text].filter(Boolean).join(" ");
    if (!hasResults) {
      lines.push(label);
      continue;
    }
    const count = counts.get(answer.answer_id) ?? 0; // Answers with no votes are left out by Discord.
    const percent = total ? Math.round((count / total) * 100) : 0;
    lines.push(`${label}: ${votes(count)} (${percent}%)`);
  }

  const closed = poll.results?.is_finalized === true || (poll.expiry != null && Date.parse(poll.expiry) <= now);
  const status = closed ? "poll closed, final results" : "poll still open when this channel was anonymised";
  const multi = poll.allow_multiselect ? "; people could pick more than one answer" : "";
  lines.push(hasResults ? `${votes(total)} in total (${status}${multi})` : `(${closed ? "poll closed" : "poll still open"}; results unavailable)`);
  return lines.join("\n");
}
