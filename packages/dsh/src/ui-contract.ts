import type {
  AgentHome,
  AssetKind,
  AssetStatus,
  EvidenceRef,
  FitnessSignal,
  FrameMode,
  HomeAddress,
  HomeType,
  InboxMessage,
  InboxDelivery,
  InboxHumanNotification,
  HumanNotificationPreference,
  MemoryProposal,
  Organization,
} from './domain.js'
import type { FormalProject } from './project-ledger.js'
import type { FormalWork } from './work-ledger.js'
import type { MemoryUseOutcomePage } from './service.js'
import type { LearningScheduleStatus } from './learning-scheduler.js'
import type { HomeDirectoryEntry } from './home-directory.js'

export const BIZAGENT_UI_API = '/api/bizagent/v1'
/** Organization id of the one-click sample team; the UI shows a getting-started guide for it. */
export const BIZAGENT_SAMPLE_ORGANIZATION_ID = 'sample-shop'
export const BIZAGENT_AGENT_DIRECTORY_API = `${BIZAGENT_UI_API}/agents`
export const BIZAGENT_PROJECT_REVIEW_API = '/api/bizagent/project-review'
export const BIZAGENT_LOCAL_HUMAN_STATUS_API = '/api/bizagent/local-human/status'
export const BIZAGENT_AGENT_SESSION_API = '/api/bizagent/agent-session'

export interface UiProjectReviewAccess {
  canReview: boolean
  revision: number
  claimId: string | null
  outcomeReworkNotification?: { claimId: string; state: 'pending' | 'delivered' }
}
export interface UiProjectOutcomeReviewInbox {
  items: Array<{
    projectId: string; projectTitle: string; lead: string; goal: string; doneWhen: string
    revision: number; claimId: string; submittedAt: string
    summary: string; body: string; doneWhenAssessment: string
    work: Array<{ id: string; status: 'completed' | 'cancelled'
      resultSubject?: string; resultBody?: string
      resultArtifacts?: Array<{ path: string; sha256: string; bytes: number }> }>
    artifacts: Array<{ path: string; sha256: string; bytes: number }>
  }>
  nextOffset?: number
}
export const BIZAGENT_FRAME_STATUS_API = `${BIZAGENT_UI_API}/frames`
export const BIZAGENT_HUMAN_INBOX_API = '/api/bizagent/human-inbox'
export const BIZAGENT_SESSION_CONTEXT_API = `${BIZAGENT_UI_API}/session-context`
export const BIZAGENT_SESSION_CATALOG_API = `${BIZAGENT_UI_API}/sessions`

export type UiSessionKind = 'conversation' | 'principal' | 'project-main' | 'work' | 'learning' | 'inbox'
export type UiAgentRuntime = 'running' | 'idle' | 'unloaded'
export interface UiSessionSummary {
  sessionId: string
  home: UiFrameParticipation['primaryHome']
  kind: UiSessionKind
  runtime: UiAgentRuntime
  projectId?: string
  projectTitle?: string
  workId?: string
  workGoal?: string
  workStatus?: FormalWork['status']
}
export interface UiSessionActivity {
  id: string
  turn: number
  seq: number
  kind: 'memory' | 'proposal' | 'work' | 'project' | 'frame' | 'learning'
  action: string
  title: string
  status?: string
  entityId?: string
}
export interface UiSessionContext {
  summary: UiSessionSummary
  frames: UiFrameParticipation['frames']
  home: { activeAssets: number; candidates: number; pendingProposals: number }
  work: Array<Pick<FormalWork, 'id' | 'goal' | 'requester' | 'assignee' | 'status' | 'updatedAt'
    | 'workerSessionId' | 'returnToSessionId' | 'projectId' | 'resultSubject' | 'resultBody' | 'resultArtifacts'>
    & { runtime: UiAgentRuntime; requesterName: string; assigneeName: string }>
  projects: Array<Pick<FormalProject, 'id' | 'title' | 'status' | 'goal'>>
  activity: UiSessionActivity[]
  moreWork: boolean
}
export type UiHumanInboxSummary = Pick<InboxMessage,
  'id' | 'fromAddress' | 'to' | 'cc' | 'subject' | 'kind' | 'priority' | 'due' | 'replyTo' | 'humanAction' | 'sentAt'> & {
    delivery?: InboxDelivery; notification?: InboxHumanNotification }
export interface UiHumanInboxList {
  address: string
  notificationPreference: Pick<HumanNotificationPreference, 'recipient' | 'enabled' | 'revision'>
    & { updatedAt?: string }
  messages: UiHumanInboxSummary[]
  nextBeforeMessageId?: string
}
export interface UiHumanInboxDetail {
  message: InboxMessage
  delivery?: InboxDelivery
  notification?: InboxHumanNotification
}
export type LearningKind = Exclude<AssetKind, 'identity'>
export type UiLearningSchedule = LearningScheduleStatus
export type UiMemoryUseOutcomes = MemoryUseOutcomePage
export type UiAgentDirectory = { count: number; homes: HomeDirectoryEntry[] }
export type UiAgentTarget = HomeDirectoryEntry
export interface UiFrameParticipation {
  sessionId: string
  primaryHome: { address: HomeAddress; displayName: string; scope: UiHomeSummary['scope'] }
  frames: Array<{
    address: HomeAddress
    displayName: string
    mode: FrameMode
    focused: boolean
    refreshRequired: boolean
  }>
}

export interface UiAssetCounts {
  memory: number
  insight: number
  knowledge: number
  method: number
}

export interface UiHomeSummary {
  address: HomeAddress
  /** Host-known Workspace for an explicitly bound Business Home chat. */
  chatWorkspacePath?: string
  /** `personal` for the person's own Homes in the data root, outside any organization. */
  scope: 'personal' | 'organization'
  type: HomeType
  displayName: string
  revision: number
  status: AgentHome['status']
  updatedAt: string
  assetCount: number
  activeAssetCount: number
  counts: UiAssetCounts
  incomingPending: number
  outgoingPending: number
  episodes: number
}

export interface UiAsset {
  id: string
  ownerAddress: HomeAddress
  kind: LearningKind
  title?: string
  description: string
  body: string
  tags: string[]
  sourceRefs: EvidenceRef[]
  confidence: number
  fitness: number
  status: AssetStatus
  revision: number
  proposalId?: string
  proposalApplications?: Array<{ proposalId: string; revision: number; bodySha256: string }>
  createdAt: string
  updatedAt: string
  receiptCount: number
  lastSignal?: FitnessSignal
}

export interface UiHomeDetail {
  home: AgentHome
  identity: string
  assets: UiAsset[]
  proposals: MemoryProposal[]
  episodes: number
  worklogCount: number
  worklogs: Array<{
    id: string
    sessionId: string
    revision: number
    description: string
    body: string
    status: 'ongoing' | 'completed' | 'blocked' | 'failed'
    origin?: 'agent' | 'work-result' | 'session-activity'
    recordedAt: string
    files: string[]
    workId?: string
    projectId?: string
  }>
}

export interface UiOverview {
  generatedAt: string
  /** BizAgent data root: the personal space, with organizations under `orgs/`. */
  homeRoot: string
  organizationLocation?: {
    organizationId: string
    organizationRoot: string
    /** Set for an organization still at its pre-1.0 place, `<workspace>/bizagent/<id>`. */
    legacyWorkspacePath?: string
  }
  organization?: Organization
  homes: UiHomeSummary[]
  proposals: MemoryProposal[]
  totals: {
    homes: number
    assets: number
    activeAssets: number
    pendingProposals: number
    episodes: number
  }
  health: {
    ok: boolean
    issues: string[]
  }
}

export interface UiCreateHomeRequest {
  address: string
  displayName?: string
  owner?: string
  identity?: string
}

export interface UiCreateOrganizationRequest {
  id: string
  name: string
  mission: string
  members: Array<{
    id: string
    displayName: string
    roleId: string
    roleName: string
    responsibility: string
  }>
  capabilities: Array<{
    id: string
    displayName: string
    responsibility: string
  }>
}

export interface UiProposalDecisionRequest {
  ownerAddress: string
  proposalId: string
  action: 'accept' | 'reject'
  decision: string
}

export interface UiApiError {
  error: {
    code: string
    message: string
  }
}

export interface UiProjectList {
  homeAddress: HomeAddress
  projects: FormalProject[]
  nextBeforeProjectId?: string
}

export interface UiProjectDetail {
  project: FormalProject
  work: FormalWork[]
}
