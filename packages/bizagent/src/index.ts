// Programmatic public API — this is the surface that makes "feature parity" real.
// The CLI (cli.ts) and SDK users import the very same core functions; the CLI holds
// no logic of its own.
//
//   import { initRoot, newBusiness, writeMemory, recall, assemble } from "bizagent";
//   const r   = initRoot({ root: "./acme" });
//   const ws  = newBusiness({ root: r.root, slug: "webstore", line: "commerce" });
//
// Exactly equivalent to `biz init` / `biz new webstore --line commerce`.

export { initRoot, newLine, listLines, newBusiness, listBusinesses, deleteBusiness, newModule, linkModule, unlinkModule, newAssistant, rootSummary, bizVersion } from "./root";
export type {
  InitRootOptions,
  InitRootResult,
  LineMeta,
  NewBusinessOptions,
  NewBusinessResult,
  NewModuleOptions,
  NewModuleResult,
  NewAssistantOptions,
  NewAssistantResult,
  RootSummary,
} from "./root";

export { readModuleMeta, writeModuleMeta, updateModuleMeta, listModuleSlugs, businessesLinking, linkedModuleDirs, moduleStatus, moduleClaudeMdReady } from "./module";
export type { ModuleMeta, ModuleMetaPatch, ModuleStatus } from "./module";

export { readAssistantMeta, writeAssistantMeta, updateAssistantMeta, listAssistants, listAssistantConfigured, assistantClaudeMdPath } from "./assistant";
export type { AssistantMeta, AssistantMetaPatch } from "./assistant";

export { ensureRequirement, readRequirementDoc, setRequirementGoal, recordRunReq, runReq, recordRunTask, runTask, recordRunModel, runModel, recordRunRequester, runRequester, runSessionId, runForSessionId, listRequirements, validReqId, deleteRequirement, renameRequirement } from "./requirement";
export type { RequirementEntry } from "./requirement";

export { createWebServer, startWebServer, webConfig, createBizHandler } from "./web";

export { toSSE, nodeListener } from "./http-adapter";
export type { Handler } from "./http-adapter";

export { createBizClient, reduceSession, initialSessionState, readSSE } from "./client";
export type { BizClient, SessionHandle, SessionState, TimelineItem, JobCard, BusinessInfo, ModuleInfo, SkillInfo, SkillDetail } from "./client";

export { writeMemory, recall, readAllMemory, readMemoryDir, assemble } from "./memory";
export type { Layer, MemoryRecord, WriteMemoryOptions, RecallOptions } from "./memory";

export {
  validateMemoryWrite,
  validateModuleDirWrite,
  worklogWritten,
  updateIndex,
  freshIndexSince,
  publishWorklogs,
  publishMemories,
  publishTranscript,
  pullRemoteIndex,
  pullRemoteMemory,
  promote,
  extractConclusions,
  readWorklogIndex,
  readWorklog,
  listRuns,
  deleteRun,
  setRunTitle,
  runTitle,
  listDeliverables,
} from "./governance";
export type { WriteCheck, IndexResult, PromoteResult, WorklogIndexEntry, RunEntry } from "./governance";

export { fileRemote, httpRemote, resolveRemote, applyTranscriptChunk } from "./remote";
export type { Remote, IndexEntry, Blob, RemoteFactory } from "./remote";

export { hubIndex, hubFetchWorklog, hubPublishWorklog, hubFetchMemory, hubPublishMemory, hubPublishTranscript, hubManifest, readHubFile } from "./hub";
export type { ManifestEntry } from "./hub";

export { ensureSkillsLink, listSkills, skillFiles, readSkillFile, rootSkillsDir } from "./skill";
export type { SkillFileEntry } from "./skill";

export { listKnowledge, readKnowledgeFile, listLineKnowledge, readLineKnowledgeFile, workspaceKnowledgeLayers, ensureKnowledgeLinks, knowledgeLayerDirs } from "./knowledge";
export type { KnowledgeLayer, KnowledgeLayerKind, KnowledgeFileEntry } from "./knowledge";

export { guardHook, injectHook, stopHook } from "./hooks";
export type { GuardOutcome, InjectOutcome, StopOutcome } from "./hooks";

export { snapshotOnStop, resolveSnapshotConfig } from "./snapshot";
export type { SnapshotConfig } from "./snapshot";

export { readBusinessMeta, writeBusinessMeta, updateBusinessMeta } from "./meta";
export type { BusinessMeta, BusinessMetaPatch } from "./meta";

export { runAgent, resolveAgentBin, resolveClaudeExecutable, makeRunId } from "./runtime-cli";
export type { RunAgentOptions } from "./runtime-cli";

export { buildSdkOptions } from "./runtime-sdk";
export type { SdkOptions } from "./runtime-sdk";

export {
  createSessionManager,
  makeInputChannel,
  Broadcast,
  JobRegistry,
  formatJobResult,
  formatInbound,
  makeSessionRegistry,
  mapMessage,
  extractUsage,
  toolResultText,
  sessionIdOf,
  makeWorklogWatcher,
  wrapStopHooks,
} from "./session";
export type { SessionManager, BizSession, SessionEvent, SessionUsage, JobContext, Identity, AuthConfig, SdkUserMessage, Inbound, InboundKind, SessionRegistry } from "./session";

export { transcriptToEvents, readTranscriptEvents, makeTranscriptTailer, runHistory } from "./transcript";

export { loadPrompt, renderPrompt, resolveCustom, buildWorklogPrompt, buildBusinessSetupPrompt, buildKnowledgeRefreshSetupPrompt, buildNewSubscriptionSetupPrompt, buildModuleSetupPrompt } from "./prompts";

export { buildSystemPrompt, renderBusinessMemory, buildCapabilitiesPrompt } from "./context";

export { nowIso, toIso, inUtc8 } from "./time";

export { findRoot, findBusiness } from "./paths";
export { businessDir, businessLine, listLineSlugs, transcriptMirrorPath } from "./paths";
export { moduleWorkspaceId, parseModuleWorkspaceId, MODULE_WS_PREFIX, moduleConfigPath } from "./paths";
export { assistantWorkspaceId, parseAssistantWorkspaceId, ASSISTANT_WS_PREFIX, assistantDir, assistantConfigPath, listAssistantSlugs } from "./paths";

export { scope, scopeKey, parseScope, childOf, parentOf, isRoot, within, scopeEq } from "./scope";
export type { Scope } from "./scope";

export { identityModelResolver } from "./model";
export type { ModelResolver, ResolvedModel, ModelContext } from "./model";

export {
  clampDelay,
  chainExhausted,
  dueWakeups,
  WAKEUP_MIN_DELAY,
  WAKEUP_MAX_DELAY,
  WAKEUP_MAX_CHAIN,
} from "./schedule";
export type { WakeupRow, SchedulerStore } from "./schedule";

export { noopNotifier, withScope } from "./notify";
export type { Notification, Notifier } from "./notify";

export { fileScheduler } from "./scheduler-file";

export {
  snapshotActiveTurns,
  recoverableTurns,
  recoverActiveTurns,
  busyCount,
  makeDrainController,
  RECOVER_MAX_AGE_MS,
  RECOVER_MAX_SESSIONS,
  DEFAULT_RECOVER_NUDGE,
} from "./graceful";
export type { ActiveTurn, ActiveTurnStore, DrainController } from "./graceful";

export { fileActiveTurnStore } from "./active-turns-file";
