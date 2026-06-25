// Minimal frontmatter (constrained schema, zero-dependency).
// A memory unit = frontmatter + body. Only the scalar/array/boolean forms we use
// are supported — we deliberately avoid pulling in gray-matter.

export type FrontMatter = Record<string, unknown>;
const FENCE = "---";

export function parse(raw: string): { data: FrontMatter; body: string } {
  if (!raw.startsWith(FENCE)) return { data: {}, body: raw };
  const end = raw.indexOf("\n" + FENCE, FENCE.length);
  if (end === -1) return { data: {}, body: raw };

  const fmText = raw.slice(FENCE.length, end).trim();
  const body = raw.slice(end + 1 + FENCE.length).replace(/^\n+/, "");
  const data: FrontMatter = {};

  for (const line of fmText.split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val: unknown = line.slice(i + 1).trim();
    const s = val as string;
    if (s.startsWith("[") && s.endsWith("]")) {
      val = s
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    } else if (s === "true") val = true;
    else if (s === "false") val = false;
    else if (s !== "" && !Number.isNaN(Number(s))) val = Number(s);
    data[key] = val;
  }
  return { data, body: body.trimEnd() + "\n" };
}

export function stringify(data: FrontMatter, body: string): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(", ")}]`);
    else lines.push(`${k}: ${v}`);
  }
  return `${FENCE}\n${lines.join("\n")}\n${FENCE}\n\n${body.trim()}\n`;
}
