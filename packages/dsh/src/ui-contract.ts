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
export const BIZAGENT_AGENT_DIRECTORY_API = `${BIZAGENT_UI_API}/agents`
export const BIZAGENT_PROJECT_REVIEW_API = '/api/bizagent/project-review'
export const BIZAGENT_LOCAL_HUMAN_STATUS_API = '/api/bizagent/local-human/status'
export const BIZAGENT_AGENT_SESSION_API = '/api/bizagent/agent-session'
export const BIZAGENT_PROJECT_DELIVERY_FEEDBACK_API = '/api/bizagent/project-delivery-feedback'
export const BIZAGENT_PROJECT_ROLE_ASSIGNMENTS_API = '/api/bizagent/project-role-assignments'
export const BIZAGENT_PROJECT_NODE_REVIEW_API = '/api/bizagent/project-node-review'
export const BIZAGENT_PROJECT_INTERVENTION_API = '/api/bizagent/project-intervention'
export const BIZAGENT_PROJECT_PLAN_API = '/api/bizagent/project-plan'

export interface UiProjectRoleAssignmentAccess {
  projectId: string
  projectRevision: number
  revision: number
  canManage: boolean
  roles: Array<{ roleHome: string; responsibility: string }>
  bindings: Array<{ roleHome: string; principal: string; byPrincipal: string; at: string }>
  suggestions: Array<{ id: string; roleHome: string; proposedPrincipal: string;
    reason: string; bySessionId: string; at: string;
    status: 'pending' | 'accepted' | 'rejected' | 'superseded' }>
  candidates?: Array<{ id: string; label: string }>
}

export interface UiProjectDeliveryFeedbackAccess {
  projectId: string
  revision: number
  canFeedback: boolean
  workingAssets: Array<{ path: string; revision: number; sha256: string; bytes: number }>
  submitted: { claimId: string; artifacts: Array<{ path: string; sha256: string; bytes: number }> } | null
  feedback: Array<{ id: string; path: string; version: 'working' | 'submitted' | 'accepted'
    sha256: string; section?: string; body: string; at: string
    bySessionId?: string; byPrincipal?: string
    resolution?: { reply: string; path: string; workingRevision: number; sha256: string; at: string } }>
}

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
export interface UiProjectNodeReviewAccess {
  canReview: boolean
  revision: number
  workId: string | null
}
export interface UiProjectNodeReviewInbox {
  items: Array<{
    projectId: string; projectTitle: string; revision: number
    nodeId: string; nodeTitle: string; reviewCriteria: string; reviewerHome: string
    workId: string; completedAt: string; resultSubject: string; resultBody: string
    resultArtifacts: Array<{ path: string; sha256: string; bytes: number }>
    assignedPrincipal?: string
  }>
  nextOffset?: number
}
export interface UiProjectInterventionAccess {
  revision: number
  canPause: boolean
  canResume: boolean
}
export interface UiProjectPlanAccess {
  revision: number
  workflowRevision: number | null
  canSetProgression?: boolean
  progressionNotification?: { revision: number; state: 'pending' | 'delivered' }
  canAmend: boolean
  canRebuild: boolean
  canReopen: boolean
  canReassign?: boolean
  reviewerCandidates?: Array<{ userId: string; name: string }>
}
export interface UiProjectPlanStep {
  id: string; title: string; intent: string; executor: string
  acceptanceCriteria: string; after: string[]
  reviewer?: string | undefined; reviewCriteria?: string | undefined
}
export type UiProjectPlanAction = { action: 'progression'; projectId: string;
  expectedRevision: number; mode: 'automatic' | 'reviewed'; reason: string
  reviewers: Array<{ nodeId: string; reviewerHome: string }>
} | { action: 'reopen'; projectId: string;
  expectedRevision: number; nodeId: string; reason: string } | {
  action: 'reassign'; projectId: string; expectedRevision: number
  nodeId: string; workId: string; expectedPrincipal: string | null
  assignedPrincipal: string; reason: string
} | {
  action: 'amend' | 'rebuild'; projectId: string; expectedRevision: number
  expectedWorkflowRevision: number; reason: string; idempotencyKey: string
  proposalKey?: string
  restartNodeIds?: string[]; workflow: { summary: string; steps: UiProjectPlanStep[] }
}
export const BIZAGENT_FRAME_STATUS_API = `${BIZAGENT_UI_API}/frames`
export const BIZAGENT_HUMAN_INBOX_API = '/api/bizagent/human-inbox'
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
  primaryHome: { address: HomeAddress; displayName: string }
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
  homeRoot: string
  organizationLocation?: {
    workspacePath: string
    organizationId: string
    organizationRoot: string
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
  workspacePath: string
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
  progress: Record<string, NonNullable<UiProjectDetail['workflow']>>
  nextBeforeProjectId?: string
}

export interface UiProjectDetail {
  project: FormalProject
  work: FormalWork[]
  workflow?: {
    nodes: Array<{
      id: string; title: string; executor: string; after: string[]
      status: 'pending' | 'ready' | 'running' | 'waiting' | 'done'
      attempts: number; latestWorkId?: string; latestWorkStatus?: FormalWork['status']
    }>
    readyNodeIds: string[]
  }
}
