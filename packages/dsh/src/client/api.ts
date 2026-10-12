import {
  BIZAGENT_UI_API,
  BIZAGENT_AGENT_DIRECTORY_API,
  BIZAGENT_PROJECT_REVIEW_API,
  BIZAGENT_LOCAL_HUMAN_STATUS_API,
  BIZAGENT_AGENT_SESSION_API,
  BIZAGENT_PROJECT_DELIVERY_FEEDBACK_API,
  BIZAGENT_PROJECT_ROLE_ASSIGNMENTS_API,
  BIZAGENT_PROJECT_NODE_REVIEW_API,
  BIZAGENT_PROJECT_INTERVENTION_API,
  BIZAGENT_PROJECT_PLAN_API,
  BIZAGENT_FRAME_STATUS_API,
  BIZAGENT_HUMAN_INBOX_API,
  type UiAgentDirectory,
  type UiAgentTarget,
  type UiApiError,
  type UiCreateHomeRequest,
  type UiCreateOrganizationRequest,
  type UiFrameParticipation,
  type UiHomeDetail,
  type UiLearningSchedule,
  type UiMemoryUseOutcomes,
  type UiOverview,
  type UiProjectList,
  type UiProjectDetail,
  type UiProjectReviewAccess,
  type UiProjectDeliveryFeedbackAccess,
  type UiProjectRoleAssignmentAccess,
  type UiProjectOutcomeReviewInbox,
  type UiProjectNodeReviewAccess,
  type UiProjectNodeReviewInbox,
  type UiProjectInterventionAccess,
  type UiProjectPlanAccess,
  type UiProjectPlanAction,
  type UiProposalDecisionRequest,
  type UiHumanInboxList,
  type UiHumanInboxDetail,
} from '../ui-contract.js'

export interface UiSharedKnowledgeReviews {
  count: number
  proposals: Array<{
    proposal: { id: string; fromAddress: string; target: { scope: 'common' } | { scope: 'line'; line: string };
      description: string; body: string; status: 'pending' | 'accepted' | 'rejected' }
    actions: { accept: boolean; reject: boolean }
  }>
}

export interface BizAgentUiPort {
  localHumanStatus?(signal?: AbortSignal): Promise<{ available: boolean; authenticated: boolean }>
  setLocalHumanToken?(token: string | undefined): Promise<boolean>
  openAgentSession?(input: { homeAddress: string } | { projectId: string }): Promise<{
    kind: 'principal' | 'project-main'; homeAddress: string; logicalAddress: string;
    sessionId: string; workspacePath: string; projectId?: string }>
  agentDirectory(sessionId: string, query: string, signal?: AbortSignal): Promise<UiAgentDirectory>
  resolveAgentTarget(sessionId: string, target: string, signal?: AbortSignal): Promise<UiAgentTarget>
  frameParticipation(sessionId: string, signal?: AbortSignal): Promise<UiFrameParticipation>
  overview(signal?: AbortSignal): Promise<UiOverview>
  humanInbox(direction: 'incoming' | 'outgoing', pendingOnly: boolean,
    beforeMessageId?: string, signal?: AbortSignal): Promise<UiHumanInboxList | undefined>
  humanInboxDetail(messageId: string, signal?: AbortSignal): Promise<UiHumanInboxDetail>
  setHumanNotificationPreference(enabled: boolean, expectedRevision: number): Promise<{
    preference: UiHumanInboxList['notificationPreference'] }>
  handleHumanInbox(messageId: string): Promise<unknown>
  replyHumanInbox(messageId: string, subject: string, body: string, idempotencyKey: string): Promise<unknown>
  home(address: string, signal?: AbortSignal): Promise<UiHomeDetail>
  learningSchedule(home: string, signal?: AbortSignal): Promise<UiLearningSchedule>
  memoryUseOutcomes(sessionId: string, assetId: string, beforeWorkId?: string,
    signal?: AbortSignal): Promise<UiMemoryUseOutcomes>
  configureLearningSchedule(home: string, expectedRevision: number, enabled: boolean,
    cron: string, dailyRuns: number): Promise<UiLearningSchedule>
  createHome(request: UiCreateHomeRequest, signal?: AbortSignal): Promise<UiHomeDetail>
  createOrganization(request: UiCreateOrganizationRequest, signal?: AbortSignal): Promise<UiOverview>
  decideProposal(request: UiProposalDecisionRequest, signal?: AbortSignal): Promise<UiHomeDetail>
  proposalReviewActions?(ownerAddress: string, proposalId: string,
    signal?: AbortSignal): Promise<{ accept: boolean; reject: boolean }>
  sharedKnowledgeReviews?(signal?: AbortSignal): Promise<UiSharedKnowledgeReviews | undefined>
  decideSharedKnowledge?(input: { proposalId: string; action: 'accept' | 'reject'; decision: string }): Promise<unknown>
  projects(sessionId: string, beforeProjectId?: string, signal?: AbortSignal): Promise<UiProjectList>
  projectDetail(sessionId: string, projectId: string, signal?: AbortSignal): Promise<UiProjectDetail>
  projectReviewAccess?(projectId: string, signal?: AbortSignal): Promise<UiProjectReviewAccess | undefined>
  projectDeliveryFeedbackAccess?(projectId: string,
    signal?: AbortSignal): Promise<UiProjectDeliveryFeedbackAccess | undefined>
  projectRoleAssignmentsAccess?(projectId: string, roleHome?: string,
    signal?: AbortSignal): Promise<UiProjectRoleAssignmentAccess | undefined>
  decideProjectRoleAsHuman?(input: { projectId: string; roleHome: string;
    action: 'assign' | 'clear' | 'reject'; targetPrincipal?: string; suggestionId?: string;
    expectedProjectRevision: number; expectedBindingRevision: number;
    idempotencyKey: string; reason: string }): Promise<unknown>
  commentProjectDeliveryAsHuman?(input: { projectId: string; path: string;
    version: 'working' | 'submitted'; expectedSha256: string; expectedProjectRevision: number;
    idempotencyKey: string; section?: string; body: string }): Promise<unknown>
  projectOutcomeReviewInbox?(offset?: number,
    signal?: AbortSignal): Promise<UiProjectOutcomeReviewInbox | undefined>
  reviewProjectAsHuman?(input: { projectId: string; claimId: string; expectedRevision: number;
    decision: 'accept' | 'rework'; reason: string }): Promise<unknown>
  downloadProjectReviewArtifact?(input: { projectId: string; claimId: string;
    artifactPath: string; workId?: string }): Promise<Blob>
  projectNodeReviewAccess?(projectId: string, nodeId: string,
    signal?: AbortSignal): Promise<UiProjectNodeReviewAccess | undefined>
  projectNodeReviewInbox?(offset?: number,
    signal?: AbortSignal): Promise<UiProjectNodeReviewInbox | undefined>
  reviewProjectNodeAsHuman?(input: { projectId: string; nodeId: string; workId: string;
    expectedRevision: number; decision: 'approve' | 'rework'; reason: string }): Promise<unknown>
  projectInterventionAccess?(projectId: string,
    signal?: AbortSignal): Promise<UiProjectInterventionAccess | undefined>
  projectInterventionAsHuman?(input: { action: 'pause'; projectId: string;
    expectedRevision: number; reason: string } | { action: 'resume'; projectId: string;
    expectedRevision: number }): Promise<unknown>
  projectPlanAccess?(projectId: string, signal?: AbortSignal,
    nodeId?: string): Promise<UiProjectPlanAccess | undefined>
  projectPlanActionAsHuman?(input: UiProjectPlanAction): Promise<unknown>
}

export class BizAgentUiHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

export class BizAgentUiHttpPort implements BizAgentUiPort {
  private localHumanToken: string | undefined

  private humanHeaders(): Record<string, string> {
    return this.localHumanToken === undefined ? {} : { Authorization: `Bearer ${this.localHumanToken}` }
  }

  async localHumanStatus(signal?: AbortSignal): Promise<{ available: boolean; authenticated: boolean }> {
    const response = await fetch(BIZAGENT_LOCAL_HUMAN_STATUS_API, {
      cache: 'no-store', credentials: 'same-origin', headers: this.humanHeaders(),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.headers.get('Content-Type')?.startsWith('application/json')) {
      return { available: false, authenticated: false }
    }
    const value = await response.json() as { userId?: unknown; error?: unknown }
    const authenticated = response.ok && typeof value.userId === 'string'
    if (!authenticated && response.status === 401) this.localHumanToken = undefined
    return { available: authenticated || response.status === 401
      && value.error === 'authentication-required', authenticated }
  }

  async setLocalHumanToken(token: string | undefined): Promise<boolean> {
    if (token === undefined) { this.localHumanToken = undefined; return false }
    this.localHumanToken = undefined
    const response = await fetch(BIZAGENT_LOCAL_HUMAN_STATUS_API, {
      cache: 'no-store', credentials: 'same-origin', headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok || !response.headers.get('Content-Type')?.startsWith('application/json')) return false
    const value = await response.json() as { userId?: unknown }
    if (typeof value.userId !== 'string') return false
    this.localHumanToken = token
    return true
  }

  openAgentSession(input: { homeAddress: string } | { projectId: string }): Promise<{
    kind: 'principal' | 'project-main'; homeAddress: string; logicalAddress: string;
    sessionId: string; workspacePath: string; projectId?: string }> {
    return post(BIZAGENT_AGENT_SESSION_API, input, this.humanHeaders())
  }

  agentDirectory(sessionId: string, query: string, signal?: AbortSignal): Promise<UiAgentDirectory> {
    const params = new URLSearchParams({ sessionId, query, limit: '50' })
    return request(`${BIZAGENT_AGENT_DIRECTORY_API}?${params}`, signal === undefined ? {} : { signal })
  }

  resolveAgentTarget(sessionId: string, target: string, signal?: AbortSignal): Promise<UiAgentTarget> {
    const params = new URLSearchParams({ sessionId, target })
    return request(`${BIZAGENT_AGENT_DIRECTORY_API}/resolve?${params}`, signal === undefined ? {} : { signal })
  }

  frameParticipation(sessionId: string, signal?: AbortSignal): Promise<UiFrameParticipation> {
    const params = new URLSearchParams({ sessionId })
    return request(`${BIZAGENT_FRAME_STATUS_API}?${params}`,
      signal === undefined ? {} : { signal })
  }

  overview(signal?: AbortSignal): Promise<UiOverview> {
    return request(`${BIZAGENT_UI_API}/overview`, signal === undefined ? {} : { signal })
  }

  async humanInbox(direction: 'incoming' | 'outgoing', pendingOnly: boolean,
    beforeMessageId?: string, signal?: AbortSignal): Promise<UiHumanInboxList | undefined> {
    const query = new URLSearchParams({ direction, pendingOnly: String(pendingOnly), limit: '20' })
    if (beforeMessageId !== undefined) query.set('beforeMessageId', beforeMessageId)
    const response = await fetch(`${BIZAGENT_HUMAN_INBOX_API}?${query}`,
      { cache: 'no-store', credentials: 'same-origin', headers: this.humanHeaders(),
        ...(signal === undefined ? {} : { signal }) })
    if ([401, 403, 404].includes(response.status)) return undefined
    const value = await response.json() as UiHumanInboxList | UiApiError
    if (!response.ok) throw new Error((value as UiApiError).error?.message
      || `Human Inbox request failed (${String(response.status)})`)
    return value as UiHumanInboxList
  }

  humanInboxDetail(messageId: string, signal?: AbortSignal): Promise<UiHumanInboxDetail> {
    const query = new URLSearchParams({ messageId })
    return request(`${BIZAGENT_HUMAN_INBOX_API}?${query}`, {
      headers: this.humanHeaders(), ...(signal === undefined ? {} : { signal }),
    })
  }

  setHumanNotificationPreference(enabled: boolean, expectedRevision: number): Promise<{
    preference: UiHumanInboxList['notificationPreference'] }> {
    return post(BIZAGENT_HUMAN_INBOX_API, { action: 'notification-preference', enabled, expectedRevision }, this.humanHeaders())
  }

  handleHumanInbox(messageId: string): Promise<unknown> {
    return post(BIZAGENT_HUMAN_INBOX_API, { action: 'handle', messageId }, this.humanHeaders())
  }

  replyHumanInbox(messageId: string, subject: string, body: string, idempotencyKey: string): Promise<unknown> {
    return post(BIZAGENT_HUMAN_INBOX_API, { action: 'reply', messageId, subject, body, idempotencyKey }, this.humanHeaders())
  }

  home(address: string, signal?: AbortSignal): Promise<UiHomeDetail> {
    return request(`${BIZAGENT_UI_API}/home?address=${encodeURIComponent(address)}`, signal === undefined ? {} : { signal })
  }

  learningSchedule(home: string, signal?: AbortSignal): Promise<UiLearningSchedule> {
    return request(`${BIZAGENT_UI_API}/learning/schedule?home=${encodeURIComponent(home)}`,
      signal === undefined ? {} : { signal })
  }

  memoryUseOutcomes(sessionId: string, assetId: string, beforeWorkId?: string,
    signal?: AbortSignal): Promise<UiMemoryUseOutcomes> {
    const query = new URLSearchParams({ sessionId, assetId })
    if (beforeWorkId !== undefined) query.set('beforeWorkId', beforeWorkId)
    return request(`${BIZAGENT_UI_API}/learning/use-outcomes?${query}`,
      signal === undefined ? {} : { signal })
  }

  configureLearningSchedule(home: string, expectedRevision: number, enabled: boolean,
    cron: string, dailyRuns: number): Promise<UiLearningSchedule> {
    return post(`${BIZAGENT_UI_API}/learning/schedule/configure`, {
      home, expectedRevision, enabled, cron, dailyRuns,
    })
  }

  createHome(input: UiCreateHomeRequest, signal?: AbortSignal): Promise<UiHomeDetail> {
    return request(`${BIZAGENT_UI_API}/homes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  createOrganization(input: UiCreateOrganizationRequest, signal?: AbortSignal): Promise<UiOverview> {
    return request(`${BIZAGENT_UI_API}/organization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  decideProposal(input: UiProposalDecisionRequest, signal?: AbortSignal): Promise<UiHomeDetail> {
    return request(`${BIZAGENT_UI_API}/proposals/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.humanHeaders() },
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  async proposalReviewActions(ownerAddress: string, proposalId: string,
    signal?: AbortSignal): Promise<{ accept: boolean; reject: boolean }> {
    try {
      const query = new URLSearchParams({ ownerAddress, proposalId })
      const response = await fetch(`${BIZAGENT_UI_API}/proposals/decision?${query}`,
        { headers: this.humanHeaders(), ...(signal === undefined ? {} : { signal }) })
      if (!response.ok) return { accept: false, reject: false }
      const result = await response.json() as { actions?: { accept?: boolean; reject?: boolean } }
      return { accept: result.actions?.accept === true, reject: result.actions?.reject === true }
    } catch { return { accept: false, reject: false } }
  }

  async sharedKnowledgeReviews(signal?: AbortSignal): Promise<UiSharedKnowledgeReviews | undefined> {
    const response = await fetch('/api/bizagent/shared-knowledge/decision', {
      cache: 'no-store', credentials: 'same-origin', headers: this.humanHeaders(),
      ...(signal === undefined ? {} : { signal }),
    })
    if ([401, 403, 404].includes(response.status)) return undefined
    if (!response.ok) throw new BizAgentUiHttpError('Shared Knowledge review failed', response.status)
    return await response.json() as UiSharedKnowledgeReviews
  }

  decideSharedKnowledge(input: { proposalId: string; action: 'accept' | 'reject'; decision: string }): Promise<unknown> {
    return post('/api/bizagent/shared-knowledge/decision', input, this.humanHeaders())
  }

  projects(sessionId: string, beforeProjectId?: string, signal?: AbortSignal): Promise<UiProjectList> {
    const query = new URLSearchParams({ sessionId, ...(beforeProjectId === undefined ? {} : { beforeProjectId }) })
    return request(`${BIZAGENT_UI_API}/projects?${query}`, signal === undefined ? {} : { signal })
  }
  projectDetail(sessionId: string, projectId: string, signal?: AbortSignal): Promise<UiProjectDetail> {
    const query = new URLSearchParams({ sessionId, projectId })
    return request(`${BIZAGENT_UI_API}/projects/detail?${query}`, signal === undefined ? {} : { signal })
  }

  async projectReviewAccess(projectId: string,
    signal?: AbortSignal): Promise<UiProjectReviewAccess | undefined> {
    const query = new URLSearchParams({ projectId })
    const response = await fetch(`${BIZAGENT_PROJECT_REVIEW_API}?${query}`, {
      cache: 'no-store', credentials: 'same-origin', headers: this.humanHeaders(),
      ...(signal === undefined ? {} : { signal }),
    })
    if ([401, 403, 404].includes(response.status)) return undefined
    return parseResponse(response)
  }

  async projectDeliveryFeedbackAccess(projectId: string,
    signal?: AbortSignal): Promise<UiProjectDeliveryFeedbackAccess | undefined> {
    const query = new URLSearchParams({ projectId })
    const response = await fetch(`${BIZAGENT_PROJECT_DELIVERY_FEEDBACK_API}?${query}`, {
      cache: 'no-store', credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    if ([401, 403, 404].includes(response.status)) return undefined
    return parseResponse(response)
  }

  commentProjectDeliveryAsHuman(input: { projectId: string; path: string;
    version: 'working' | 'submitted'; expectedSha256: string; expectedProjectRevision: number;
    idempotencyKey: string; section?: string; body: string }): Promise<unknown> {
    return post(BIZAGENT_PROJECT_DELIVERY_FEEDBACK_API, input)
  }

  async projectRoleAssignmentsAccess(projectId: string, roleHome?: string,
    signal?: AbortSignal): Promise<UiProjectRoleAssignmentAccess | undefined> {
    const query = new URLSearchParams({ projectId,
      ...(roleHome === undefined ? {} : { roleHome }) })
    const response = await fetch(`${BIZAGENT_PROJECT_ROLE_ASSIGNMENTS_API}?${query}`, {
      cache: 'no-store', credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    if ([401, 403, 404].includes(response.status)) return undefined
    return parseResponse(response)
  }

  decideProjectRoleAsHuman(input: { projectId: string; roleHome: string;
    action: 'assign' | 'clear' | 'reject'; targetPrincipal?: string; suggestionId?: string;
    expectedProjectRevision: number; expectedBindingRevision: number;
    idempotencyKey: string; reason: string }): Promise<unknown> {
    return post(BIZAGENT_PROJECT_ROLE_ASSIGNMENTS_API, input)
  }

  async projectOutcomeReviewInbox(offset = 0,
    signal?: AbortSignal): Promise<UiProjectOutcomeReviewInbox | undefined> {
    const query = new URLSearchParams({ inbox: '1', offset: String(offset) })
    const response = await fetch(`${BIZAGENT_PROJECT_REVIEW_API}?${query}`, {
      cache: 'no-store', credentials: 'same-origin', headers: this.humanHeaders(),
      ...(signal === undefined ? {} : { signal }),
    })
    if ([401, 403, 404].includes(response.status)) return undefined
    return parseResponse(response)
  }

  reviewProjectAsHuman(input: { projectId: string; claimId: string; expectedRevision: number;
    decision: 'accept' | 'rework'; reason: string }): Promise<unknown> {
    return post(BIZAGENT_PROJECT_REVIEW_API, input, this.humanHeaders())
  }

  async downloadProjectReviewArtifact(input: { projectId: string; claimId: string;
    artifactPath: string; workId?: string }): Promise<Blob> {
    const query = new URLSearchParams({ projectId: input.projectId, claimId: input.claimId,
      artifactPath: input.artifactPath,
      ...(input.workId === undefined ? {} : { workId: input.workId }) })
    const response = await fetch(`${BIZAGENT_PROJECT_REVIEW_API}?${query}`, {
      cache: 'no-store', credentials: 'same-origin', headers: this.humanHeaders(),
    })
    if (!response.ok) throw new BizAgentUiHttpError(`Project artifact download failed (${response.status})`, response.status)
    return response.blob()
  }
  async projectNodeReviewAccess(projectId: string, nodeId: string,
    signal?: AbortSignal): Promise<UiProjectNodeReviewAccess | undefined> {
    const query = new URLSearchParams({ projectId, nodeId })
    const response = await fetch(`${BIZAGENT_PROJECT_NODE_REVIEW_API}?${query}`, {
      cache: 'no-store', credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    if ([401, 403, 404].includes(response.status)) return undefined
    return parseResponse(response)
  }
  async projectNodeReviewInbox(offset = 0,
    signal?: AbortSignal): Promise<UiProjectNodeReviewInbox | undefined> {
    const query = new URLSearchParams({ inbox: '1', offset: String(offset) })
    const response = await fetch(`${BIZAGENT_PROJECT_NODE_REVIEW_API}?${query}`, {
      cache: 'no-store', credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    if ([401, 403, 404].includes(response.status)) return undefined
    return parseResponse(response)
  }
  reviewProjectNodeAsHuman(input: { projectId: string; nodeId: string; workId: string;
    expectedRevision: number; decision: 'approve' | 'rework'; reason: string }): Promise<unknown> {
    return post(BIZAGENT_PROJECT_NODE_REVIEW_API, input)
  }
  async projectInterventionAccess(projectId: string,
    signal?: AbortSignal): Promise<UiProjectInterventionAccess | undefined> {
    const query = new URLSearchParams({ projectId })
    const response = await fetch(`${BIZAGENT_PROJECT_INTERVENTION_API}?${query}`, {
      cache: 'no-store', credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    if ([401, 403, 404].includes(response.status)) return undefined
    return parseResponse(response)
  }
  projectInterventionAsHuman(input: { action: 'pause'; projectId: string;
    expectedRevision: number; reason: string } | { action: 'resume'; projectId: string;
    expectedRevision: number }): Promise<unknown> {
    return post(BIZAGENT_PROJECT_INTERVENTION_API, input)
  }
  async projectPlanAccess(projectId: string,
    signal?: AbortSignal, nodeId?: string): Promise<UiProjectPlanAccess | undefined> {
    const query = new URLSearchParams({ projectId, ...(nodeId === undefined ? {} : { nodeId }) })
    const response = await fetch(`${BIZAGENT_PROJECT_PLAN_API}?${query}`, {
      cache: 'no-store', credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    if ([401, 403, 404].includes(response.status)) return undefined
    return parseResponse(response)
  }
  projectPlanActionAsHuman(input: UiProjectPlanAction): Promise<unknown> {
    return post(BIZAGENT_PROJECT_PLAN_API, input)
  }
}

function post<T>(path: string, body: unknown, headers: HeadersInit = {}): Promise<T> {
  return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

async function request<T>(input: string, init: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    cache: 'no-store',
    credentials: 'same-origin',
  })
  return parseResponse<T>(response)
}

async function parseResponse<T>(response: Response): Promise<T> {
  const value = await response.json() as T | UiApiError | { error: string }
  if (!response.ok) {
    const failure = (value as UiApiError | { error: string }).error
    throw new BizAgentUiHttpError((typeof failure === 'string' ? failure : failure?.message)
      || `BizAgent UI request failed (${String(response.status)})`, response.status,
    typeof failure === 'string' ? undefined : failure?.code)
  }
  return value as T
}
