const API = "https://discord.com/api/v10";

export const Permission = {
  ADMINISTRATOR: 1n << 3n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  MANAGE_THREADS: 1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_GUILD: 1n << 5n,
};

export const ChannelType = { GUILD_TEXT: 0, GUILD_VOICE: 2, GUILD_ANNOUNCEMENT: 5, PUBLIC_THREAD: 11, PRIVATE_THREAD: 12, GUILD_STAGE_VOICE: 13 };
// Channels /purge, /anonymise and /schedule work on: text channels and the text chat built
// into voice and stage channels (where events happen).
export const JOB_CHANNEL_TYPES = [ChannelType.GUILD_TEXT, ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE];

export function hasPermission(bitfield, permission) {
  return bitfield != null && (BigInt(bitfield) & permission) === permission;
}

/** Thrown when this invocation has used up its Discord request allowance or time; the work resumes on the next cron run. */
export class OutOfBudget extends Error {}

export class DiscordError extends Error {
  constructor(status, body) {
    super(`Discord API ${status}: ${body?.message ?? "unknown error"}`);
    this.status = status;
    this.code = body?.code;
  }
}

/**
 * Small Discord REST client that counts requests. Workers Free allows 50 outbound
 * requests per invocation, so callers share one client and stop when it runs dry.
 */
export class DiscordClient {
  constructor(token, { budget = 45, deadline = Infinity } = {}) {
    this.token = token;
    this.budget = budget;
    this.deadline = deadline;
    this.used = 0;
  }

  /** The bot's own user ID, which is the first part of its token (base64). Null if unreadable. */
  userId() {
    try {
      const id = atob(this.token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"));
      return /^\d+$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  remaining() {
    return this.budget - this.used;
  }

  timeLeft() {
    return this.deadline - Date.now();
  }

  async request(method, path, { json, form, auth = true } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.used >= this.budget || this.timeLeft() <= 0) throw new OutOfBudget();
      this.used++;

      const headers = { "User-Agent": "DiscordBot (https://github.com/icecreamlorry/SimpleDiscordBot, 2.0)" };
      if (auth) headers.Authorization = `Bot ${this.token}`;
      let body;
      if (json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(json);
      } else if (form) {
        body = form;
      }

      const res = await fetch(API + path, { method, headers, body });
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const waitMs = Math.ceil((data.retry_after ?? 1) * 1000) + 100;
        if (waitMs > this.timeLeft()) throw new OutOfBudget();
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      if (!res.ok) throw new DiscordError(res.status, await res.json().catch(() => null));
      return res.status === 204 ? null : res.json();
    }
    throw new OutOfBudget(); // Still rate limited; try again next run.
  }

  /** Downloads a file from Discord's CDN (e.g. a message attachment). Counts towards the budget. */
  async download(url) {
    if (this.used >= this.budget || this.timeLeft() <= 0) throw new OutOfBudget();
    this.used++;
    const res = await fetch(url);
    if (!res.ok) throw new DiscordError(res.status, { message: `Could not download attachment (${res.status})` });
    return res.blob();
  }

  /** Edit the original response to an interaction (works for 15 minutes after it was created). */
  editOriginal(applicationId, token, { json, form }) {
    return this.request("PATCH", `/webhooks/${applicationId}/${token}/messages/@original`, { json, form, auth: false });
  }
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Returns the request body if Discord's Ed25519 signature is valid, otherwise null. */
export async function verifyInteraction(request, publicKeyHex) {
  const signature = hexToBytes(request.headers.get("X-Signature-Ed25519"));
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const publicKey = hexToBytes(publicKeyHex);
  if (!signature || !timestamp || !publicKey) return null;

  const body = await request.text(); // Interaction payloads are small (well under 1 MB).
  const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(timestamp + body));
  return valid ? body : null;
}
