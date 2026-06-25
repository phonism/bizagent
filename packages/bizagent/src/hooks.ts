// Hook decisions — runtime-neutral. The CLI maps these to Claude Code's JSON wire format
// (permissionDecision / additionalContext / decision); a future SDK runtime maps the SAME
// decisions to its own hook-callback returns. So the policy lives here once, not per runtime.
//
// Each function takes the business cwd plus the raw fields a hook event carries, resolves
// the root/business itself, and returns a small outcome the runtime renders. No I/O, no exit.
import path from "node:path";
import { findRoot, findBusiness } from "./paths";
import { readFileOr } from "./fsutil";
import {
  validateMemoryWrite,
  validateModuleDirWrite,
  worklogWritten,
  updateIndex,
  freshIndexSince,
  worklogLine,
  publishWorklogs,
  publishMemories,
  publishTranscript,
  pullRemoteIndex,
  pullRemoteMemory,
  recordTranscriptPath,
} from "./governance";
import { resolveRemote, Remote } from "./remote";
import { loadPrompt, renderPrompt } from "./prompts";
import { snapshotOnStop } from "./snapshot";

/** PreToolUse: deny a malformed memory write, or allow (null). */
export type GuardOutcome = { deny: string } | null;

function editedContent(filePath: string, oldString?: string, newString?: string): string | undefined {
  if (oldString === undefined || newString === undefined) return undefined;
  const before = readFileOr(filePath);
  if (!before.includes(oldString)) return undefined;
  return before.replace(oldString, newString);
}

export function guardHook(o: {
  cwd: string;
  toolName?: string;
  filePath?: string;
  content?: string;
  oldString?: string;
  newString?: string;
}): GuardOutcome {
  if ((o.toolName === "Write" || o.toolName === "Edit") && o.filePath) {
    const root = findRoot(o.cwd);
    if (root) {
      const filePath = path.resolve(o.cwd, o.filePath);
      // A module's directory is writable only from its own workspace — business sessions read
      // their mounts but never change them (changes go through a deliverables clone).
      const ws = findBusiness(o.cwd);
      if (ws) {
        const modCheck = validateModuleDirWrite({ root, wsSlug: ws.slug, filePath });
        if (!modCheck.ok) return { deny: modCheck.reason ?? "module directory is read-only from this session" };
      }
      const content = o.content ?? (o.toolName === "Edit" ? editedContent(filePath, o.oldString, o.newString) : undefined);
      const check = validateMemoryWrite({ root, filePath, content });
      if (!check.ok) return { deny: check.reason ?? "invalid memory write" };
    }
  }
  return null;
}

/** UserPromptSubmit: context to inject this turn (other sessions' new work), or nothing.
 *  When a remote is configured, first pull other users' new index lines into the local index
 *  (best-effort) — so cross-user work surfaces through the same delta as cross-session work.
 *  Pass `remote` explicitly to override; omit it to resolve from config; pass null to disable. */
export type InjectOutcome = { context: string } | null;

export async function injectHook(o: {
  cwd: string;
  runId?: string;
  remote?: Remote | null;
  /** The hook event's `transcript_path` — recorded into the run dir so the live view and history
   *  replay can find this session's transcript. Pass it through verbatim; non-strings are ignored. */
  transcriptPath?: unknown;
}): Promise<InjectOutcome> {
  const ws = findBusiness(o.cwd);
  if (!ws || !o.runId) return null;
  recordTranscriptPath({ root: ws.root, slug: ws.slug, runId: o.runId, transcriptPath: o.transcriptPath });
  const remote = o.remote === undefined ? await resolveRemote(ws.root, ws.slug) : o.remote;
  if (remote) {
    await pullRemoteIndex({ root: ws.root, slug: ws.slug, remote }); // other sessions' worklogs
    await pullRemoteMemory({ root: ws.root, slug: ws.slug, remote }); // other users' business memory
  }
  const fresh = freshIndexSince({ root: ws.root, slug: ws.slug, runId: o.runId });
  if (!fresh.length) return null;
  return { context: renderPrompt(loadPrompt("reminder-new-sessions"), { ENTRIES: fresh.join("\n") }) };
}

/** Stop: block (with feedback) if the worklog is missing, else index the finished sessions.
 *  Pass runId only when worklog enforcement should apply (the real Stop hook); omit it for a
 *  plain re-index. stopActive guards against an infinite block loop. When a remote is
 *  configured, publish newly-indexed worklogs plus this run's current body (latest wins, so
 *  in-progress updates reach other users too). Best-effort — publishing never fails the hook. */
export type StopOutcome = { block: string } | { indexed: number };

export async function stopHook(o: {
  cwd: string;
  runId?: string;
  stopActive: boolean;
  remote?: Remote | null;
}): Promise<StopOutcome> {
  const ws = findBusiness(o.cwd);
  if (!ws) return { indexed: 0 };
  if (o.runId && !o.stopActive && !worklogWritten({ root: ws.root, slug: ws.slug, runId: o.runId })) {
    return {
      block: renderPrompt(loadPrompt("reminder-worklog-missing"), {
        WORKLOG_PATH: `.bizagent/deliverables/${o.runId}/worklog.md`,
      }),
    };
  }
  const result = updateIndex({ root: ws.root, slug: ws.slug });

  // The turn is genuinely over (not blocked back) — commit the root's file state. Files are
  // the SoT here, and the turn is the natural mis-operation unit: this is what makes any agent
  // file damage attributable and reversible. Never throws, never blocks the hook meaningfully.
  await snapshotOnStop({ root: ws.root, slug: ws.slug, runId: o.runId });

  const remote = o.remote === undefined ? await resolveRemote(ws.root, ws.slug) : o.remote;
  if (remote) {
    const entries = [...result.added];
    // Re-publish this run's body every turn (latest wins) even after it's indexed once, so
    // others see progress; the remote dedups the index line by runId.
    if (o.runId && !entries.some((e) => e.runId === o.runId) && worklogWritten({ root: ws.root, slug: ws.slug, runId: o.runId })) {
      entries.push({ runId: o.runId, line: worklogLine(ws.root, ws.slug, o.runId) });
    }
    if (entries.length) await publishWorklogs({ root: ws.root, slug: ws.slug, remote, entries });
    await publishMemories({ root: ws.root, slug: ws.slug, remote }); // share this business's business memory
    // Mirror this turn's new transcript lines for the hub's read-only session view (no-op
    // unless the remote opted into transcripts). Last: it's the bulkiest publish.
    if (o.runId) await publishTranscript({ root: ws.root, slug: ws.slug, runId: o.runId, remote });
  }
  return { indexed: result.added.length };
}
