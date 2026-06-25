// The out-of-band envelope, in one pure module: format on the way INTO a session (the host
// injecting a job result / cron line / teammate message) and parse on the way OUT (the browser
// client classifying a replayed user turn as an injection, not something the human typed).
// No node imports — client.ts (browser-bundled) imports this at runtime; session.ts re-exports
// the format half for hosts.

/** Where an injected line came from. Anything that is NOT the direct turn-taker typing — a job
 *  result, another person in a room, a teammate agent, a cron firing, a system notice — is
 *  out-of-band and must be marked so the agent reads it as such, never as the user's own words. */
export type InboundKind = "user" | "agent" | "system" | "cron" | "job";

/** A structured out-of-band line to inject. `from` names the sender (a person, an agent slug, a
 *  cron name); `tag` overrides the default headline for the kind (jobs use it for done/failed). */
export interface Inbound {
  kind: InboundKind;
  text: string;
  from?: string;
  tag?: string;
}

const INBOUND_TAG: Record<InboundKind, string> = {
  user: "message",
  agent: "agent message",
  system: "system",
  cron: "scheduled trigger",
  job: "background task",
};

/** Every headline `parseInbound` recognizes: the per-kind defaults plus the two job-settle tags
 *  `formatJobResult` mints. A new tag MUST be added here or replayed injections of it render as
 *  user bubbles again. Closed set on purpose — a human can legitimately type `[anything]\n…`,
 *  so unknown headlines stay classified as real user text. */
const KNOWN_TAGS = new Set<string>([...Object.values(INBOUND_TAG), "background task finished", "background task FAILED"]);

/** The one envelope every out-of-band line wears: `[<tag> — <from>]\n<text>`. Pure and SDK-free,
 *  so the host can format a line the same way whether it injects a room message, a teammate's
 *  reply, or a cron prompt. `formatJobResult` is a special case of this. */
export function formatInbound(m: Inbound): string {
  const tag = m.tag ?? INBOUND_TAG[m.kind];
  const headline = m.from ? `${tag} — ${m.from}` : tag;
  return `[${headline}]\n${m.text}`;
}

/** The line injected back into the conversation when a job settles. Clearly marked so the agent
 *  reads it as an out-of-band result, not as something the user typed. */
export function formatJobResult(ticket: string, label: string | undefined, body: string, status: "done" | "failed"): string {
  const tag = status === "done" ? "background task finished" : "background task FAILED";
  return formatInbound({ kind: "job", tag, from: label ?? ticket, text: body });
}

/** A recognized injected line, split back into its parts. */
export interface ParsedInbound {
  tag: string;
  from?: string;
  text: string;
}

/** Inverse of `formatInbound` for KNOWN tags only: `[<tag> — <from>]\n<text>` → its parts, or
 *  undefined when the text is an ordinary user turn. This is how a UI tells an injection apart
 *  from a typed message — both land in the transcript as plain user lines. */
export function parseInbound(text: string): ParsedInbound | undefined {
  const nl = text.indexOf("\n");
  if (nl < 3 || text[0] !== "[" || text[nl - 1] !== "]") return undefined;
  const headline = text.slice(1, nl - 1);
  const sep = headline.indexOf(" — ");
  const tag = sep === -1 ? headline : headline.slice(0, sep);
  if (!KNOWN_TAGS.has(tag)) return undefined;
  const from = sep === -1 ? undefined : headline.slice(sep + 3);
  return { tag, ...(from ? { from } : {}), text: text.slice(nl + 1) };
}
