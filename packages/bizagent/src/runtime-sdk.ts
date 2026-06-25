// Agent SDK runtime adapter — the parallel of runtime-cli, wiring this business's harness
// into a claude_code `query()` IN-PROCESS: appendSystemPrompt + PreToolUse/UserPromptSubmit/
// Stop hook callbacks, all calling the SAME core decisions as the CLI (hooks.ts). Pure
// options assembly — no SDK import here; SessionManager (session.ts) loads the SDK and runs.
import { businessDir } from "./paths";
import { buildSystemPrompt } from "./context";
import { linkedModuleDirs } from "./module";
import { knowledgeLayerDirs } from "./knowledge";
import { guardHook, injectHook, stopHook } from "./hooks";

// Minimal local shapes — we don't import the SDK's types, so core stays installable without
// it. Field names match Claude Code's hook contract (snake_case), same as the CLI hooks.
type HookInput = {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  transcript_path?: string;
};
type HookOutput = Record<string, unknown>;
type HookCallback = (input: HookInput) => Promise<HookOutput>;

function debugHookError(event: string, e: unknown): void {
  if (process.env.BIZ_DEBUG) console.error(`[biz hook ${event}] error:`, e instanceof Error ? e.message : e);
}

export interface SdkOptions {
  cwd: string;
  /** Real dirs whose content the session reads through symlink mounts (targets sit outside cwd):
   *  a business session's linked modules (`modules/<name>`) plus every workspace's shared
   *  knowledge layers (`knowledge/common`, `knowledge/<line>`). Writes into any of them are
   *  denied by the guard hook. */
  additionalDirectories: string[];
  systemPrompt: { type: "preset"; preset: "claude_code"; append: string };
  hooks: Record<string, Array<{ hooks: HookCallback[] }>>;
}

/**
 * Build the `query()` options that wire the harness in-process for one session: the
 * launch context as appendSystemPrompt, plus the three hook callbacks translated from the
 * runtime-neutral decisions in hooks.ts to the SDK's HookJSONOutput shape (same family as
 * the CLI's JSON). Pure + testable — no `query()` call, no SDK import.
 *
 * Note: do NOT enable project `settingSources` on the query, or the business's materialized
 * `.claude/settings.json` hooks would fire too and double-run alongside these in-process ones.
 */
export function buildSdkOptions(o: { root: string; slug: string; runId: string; req?: string }): SdkOptions {
  const cwd = businessDir(o.root, o.slug);
  const one = (cb: HookCallback) => [{ hooks: [cb] }];

  return {
    cwd,
    additionalDirectories: [...linkedModuleDirs(o.root, o.slug), ...knowledgeLayerDirs(o.root, o.slug)],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildSystemPrompt({ root: o.root, slug: o.slug, runId: o.runId, req: o.req }),
    },
    hooks: {
      // Each callback is fail-open: a throwing hook (e.g. a flaky remote) must never break the
      // conversation — log it (when BIZ_DEBUG) and fall through to "allow / no-op".
      PreToolUse: one(async (input) => {
        try {
          const ti = input.tool_input ?? {};
          const out = guardHook({
            cwd,
            toolName: input.tool_name,
            filePath: ti.file_path as string | undefined,
            content: typeof ti.content === "string" ? ti.content : undefined,
            oldString: typeof ti.old_string === "string" ? ti.old_string : undefined,
            newString: typeof ti.new_string === "string" ? ti.new_string : undefined,
          });
          return out
            ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: out.deny } }
            : {};
        } catch (e) {
          debugHookError("PreToolUse", e);
          return {};
        }
      }),
      UserPromptSubmit: one(async (input) => {
        try {
          const out = await injectHook({ cwd, runId: o.runId, transcriptPath: input.transcript_path });
          return out ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: out.context } } : {};
        } catch (e) {
          debugHookError("UserPromptSubmit", e);
          return {};
        }
      }),
      Stop: one(async (input) => {
        try {
          const out = await stopHook({ cwd, runId: o.runId, stopActive: input.stop_hook_active === true });
          return "block" in out ? { decision: "block", reason: out.block } : {};
        } catch (e) {
          debugHookError("Stop", e);
          return {};
        }
      }),
    },
  };
}
