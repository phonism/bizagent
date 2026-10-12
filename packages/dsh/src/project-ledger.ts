import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { HomeAddressSchema, UserAddressSchema, stableId, type HomeAddress } from './domain.js'

const ProjectWorkSnapshotSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['completed', 'cancelled']),
  resultMessageId: z.string().min(1).optional(),
})

const ProjectClaimSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1).max(200),
  body: z.string().min(1).max(15000),
  doneWhenAssessment: z.string().min(1).max(4000),
  work: z.array(ProjectWorkSnapshotSchema),
  artifacts: z.array(z.object({
    path: z.string().max(500).refine(path => path.startsWith('artifacts/')
      && !path.includes('\\') && !path.includes('\0')
      && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
    'Project artifact path must be canonical under artifacts/'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
    snapshot: z.literal(true),
  })).max(10).optional(),
  submittedBySessionId: z.string().min(1),
  submittedAt: z.string().min(1),
})

const ProjectWorkingAssetSchema = z.object({
  path: z.string().max(500).refine(path =>
    (path === 'decisions.md' || path.startsWith('artifacts/') || path.startsWith('context/'))
      && !path.includes('\\') && !path.includes('\0')
      && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
  'Project working asset path must be canonical under artifacts/, context/, or decisions.md'),
  revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
  previousSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  baseProjectRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(128),
  publishedBySessionId: z.string().min(1),
  publishedAt: z.string().datetime(),
})

const ProjectDeliveryFeedbackSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1).max(128),
  path: ProjectWorkingAssetSchema.shape.path,
  version: z.enum(['working', 'submitted', 'accepted']),
  workingRevision: z.number().int().positive().optional(),
  claimId: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
  section: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(5000),
  bySessionId: z.string().min(1).optional(),
  byPrincipal: z.string().trim().min(1).max(200).optional(),
  at: z.string().datetime(),
  resolution: z.object({
    reply: z.string().trim().min(1).max(5000),
    path: ProjectWorkingAssetSchema.shape.path,
    workingRevision: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bySessionId: z.string().min(1).optional(),
    byPrincipal: z.string().trim().min(1).max(200).optional(),
    at: z.string().datetime(),
  }).optional(),
}).superRefine((feedback, context) => {
  if ((feedback.bySessionId === undefined) === (feedback.byPrincipal === undefined)
    || (feedback.version === 'working') !== (feedback.workingRevision !== undefined)
    || (feedback.version === 'working') === (feedback.claimId !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Project feedback actor or source is invalid' })
  }
  if (feedback.resolution !== undefined
    && (feedback.resolution.bySessionId === undefined) === (feedback.resolution.byPrincipal === undefined)) {
    context.addIssue({ code: 'custom', message: 'Project feedback resolution needs one actor' })
  }
})

const ProjectRoleSuggestionSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1).max(128),
  roleHome: HomeAddressSchema.refine(value => value.startsWith('role:'),
    'Project role suggestion requires a Role Home'),
  proposedPrincipal: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2000),
  baseProjectRevision: z.number().int().positive(),
  baseRoleRevision: z.number().int().nonnegative(),
  bySessionId: z.string().min(1),
  at: z.string().datetime(),
})

const ProjectRoleDecisionSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1).max(128),
  action: z.enum(['assign', 'clear', 'reject']),
  roleHome: HomeAddressSchema.refine(value => value.startsWith('role:'),
    'Project role decision requires a Role Home'),
  principal: z.string().trim().min(1).max(200).optional(),
  previousPrincipal: z.string().trim().min(1).max(200).optional(),
  suggestionId: z.string().min(1).optional(),
  baseProjectRevision: z.number().int().positive(),
  baseBindingRevision: z.number().int().nonnegative(),
  bindingRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(2000),
  byPrincipal: z.string().trim().min(1).max(200),
  at: z.string().datetime(),
}).superRefine((decision, context) => {
  if ((decision.action === 'assign') !== (decision.principal !== undefined)
    || (decision.action === 'reject' && decision.suggestionId === undefined)) {
    context.addIssue({ code: 'custom', message: 'Project role decision action is invalid' })
  }
})

export function projectHumanMessageId(projectId: string, lead: string, requestId: string): string {
  return stableId('inbox', `${lead}:${stableId('project-human-key', `${projectId}:${requestId}`)}`)
}

const ProjectHumanHandoffSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().min(1).max(128),
  question: z.string().trim().min(1).max(3000),
  reason: z.string().trim().min(1).max(3000),
  assignee: z.union([UserAddressSchema,
    HomeAddressSchema.refine(value => value.startsWith('role:'), 'human handoff Role must be a Role Home')]),
  recipient: UserAddressSchema,
  fallbackRecipient: UserAddressSchema.optional(),
  options: z.array(z.object({ label: z.string().trim().min(1).max(80),
    detail: z.string().trim().max(200).optional() })).min(2).max(6).optional(),
  contextRefs: z.array(z.string().trim().min(1).max(500)).max(16),
  baseProjectRevision: z.number().int().positive(),
  executionEpoch: z.number().int().nonnegative(),
  bySessionId: z.string().min(1),
  requestedAt: z.string().datetime(),
  messageId: z.string().min(1),
  resolution: z.object({
    replyMessageId: z.string().min(1),
    decision: z.string().trim().min(1).max(16000),
    byUser: UserAddressSchema,
    resumedBySessionId: z.string().min(1),
    at: z.string().datetime(),
  }).optional(),
})

const ProjectReviewSchema = z.object({
  claimId: z.string().min(1),
  decision: z.enum(['accept', 'rework']),
  reason: z.string().min(1).max(4000),
  reviewedBySessionId: z.string().min(1).optional(),
  reviewedByPrincipal: z.string().trim().min(1).max(200).optional(),
  reviewedAt: z.string().min(1),
}).superRefine((review, context) => {
  if ((review.reviewedBySessionId === undefined) === (review.reviewedByPrincipal === undefined)) {
    context.addIssue({ code: 'custom', message: 'Project review needs exactly one Session or human principal' })
  }
})

const ProjectWorkflowStepSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  title: z.string().min(1).max(120),
  intent: z.string().min(1).max(4000),
  executor: HomeAddressSchema,
  acceptanceCriteria: z.string().min(1).max(4000),
  after: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)).max(12),
  reviewer: HomeAddressSchema.optional(),
  reviewCriteria: z.string().min(1).max(4000).optional(),
})

export const ProjectWorkflowSchema = z.object({
  revision: z.number().int().positive(),
  summary: z.string().min(1).max(2000),
  steps: z.array(ProjectWorkflowStepSchema).min(1).max(12),
  frozenAt: z.string().min(1),
}).superRefine((workflow, context) => {
  const byId = new Map(workflow.steps.map(step => [step.id, step]))
  if (byId.size !== workflow.steps.length) {
    context.addIssue({ code: 'custom', path: ['steps'], message: 'duplicate Workflow node ID' })
  }
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (id: string): void => {
    if (visited.has(id) || visiting.has(id)) return
    visiting.add(id)
    const step = byId.get(id)
    for (const dependency of step?.after ?? []) {
      if (!byId.has(dependency)) {
        context.addIssue({ code: 'custom', path: ['steps'], message: `unknown Workflow dependency: ${dependency}` })
      } else if (visiting.has(dependency)) {
        context.addIssue({ code: 'custom', path: ['steps'], message: 'Workflow dependencies contain a cycle' })
      } else {
        visit(dependency)
      }
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of workflow.steps) {
    if (new Set(step.after).size !== step.after.length) {
      context.addIssue({ code: 'custom', path: ['steps'], message: `duplicate dependencies on ${step.id}` })
    }
    if ((step.reviewer === undefined) !== (step.reviewCriteria === undefined)) {
      context.addIssue({ code: 'custom', path: ['steps'], message: `Workflow node ${step.id} requires reviewer and review criteria together` })
    }
    visit(step.id)
  }
})

export type ProjectWorkflow = z.infer<typeof ProjectWorkflowSchema>

const ProjectWorkflowAmendmentSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
  proposalKey: z.string().min(1).max(128).optional(),
  reason: z.string().min(1).max(4000),
  before: ProjectWorkflowSchema,
  after: ProjectWorkflowSchema,
  mode: z.enum(['in-place', 'rebuild']).optional(),
  executionEpoch: z.number().int().positive().optional(),
  retained: z.array(z.object({ nodeId: z.string().min(1), workId: z.string().min(1) })).optional(),
  restartNodeIds: z.array(z.string().min(1)).optional(),
  bySessionId: z.string().min(1).optional(),
  byPrincipal: z.string().min(1).max(200).optional(),
  at: z.string().datetime(),
}).superRefine((amendment, context) => {
  if ((amendment.bySessionId === undefined) === (amendment.byPrincipal === undefined)) {
    context.addIssue({ code: 'custom', message: 'Workflow amendment needs exactly one principal or Session' })
  }
  if (amendment.mode === 'rebuild') {
    if (amendment.executionEpoch === undefined || amendment.retained === undefined
      || amendment.restartNodeIds === undefined) {
      context.addIssue({ code: 'custom', message: 'Workflow rebuild needs an execution epoch and retention decision' })
    }
    const nextIds = new Set(amendment.after.steps.map(step => step.id))
    if (new Set(amendment.retained?.map(item => item.nodeId)).size !== amendment.retained?.length
      || new Set(amendment.retained?.map(item => item.workId)).size !== amendment.retained?.length
      || amendment.retained?.some(item => !nextIds.has(item.nodeId))
      || new Set(amendment.restartNodeIds).size !== amendment.restartNodeIds?.length) {
      context.addIssue({ code: 'custom', message: 'Workflow rebuild retention or restart IDs are invalid' })
    }
  } else if (amendment.executionEpoch !== undefined || amendment.retained !== undefined
    || amendment.restartNodeIds !== undefined) {
    context.addIssue({ code: 'custom', message: 'in-place amendment cannot carry a rebuild decision' })
  }
})

const ProjectWorkflowProposalSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
  reason: z.string().min(1).max(4000),
  workflow: ProjectWorkflowSchema,
  baseWorkflowRevision: z.number().int().positive(),
  executionEpoch: z.number().int().nonnegative(),
  bySessionId: z.string().min(1),
  at: z.string().datetime(),
}).superRefine((proposal, context) => {
  if (proposal.workflow.revision !== proposal.baseWorkflowRevision + 1) {
    context.addIssue({ code: 'custom', message: 'Workflow proposal must target the next Workflow revision' })
  }
})

const ProjectProgressionChangeSchema = z.object({
  revision: z.number().int().positive(),
  mode: z.enum(['automatic', 'reviewed']),
  reviewers: z.array(z.object({ nodeId: z.string().min(1), reviewerHome: HomeAddressSchema })).max(12),
  reason: z.string().min(1).max(4000),
  byPrincipal: z.string().min(1).max(200),
  at: z.string().datetime(),
}).superRefine((change, context) => {
  if ((change.mode === 'automatic' && change.reviewers.length !== 0)
    || new Set(change.reviewers.map(item => item.nodeId)).size !== change.reviewers.length) {
    context.addIssue({ code: 'custom', message: 'Project progression reviewer arrangement is invalid' })
  }
})

const ProjectInterventionEventSchema = z.object({
  action: z.enum(['pause', 'resume']),
  reason: z.string().min(1).max(4000),
  bySessionId: z.string().min(1).optional(),
  byPrincipal: z.string().min(1).max(200).optional(),
  at: z.string().datetime(),
  epoch: z.number().int().nonnegative(),
}).superRefine((event, context) => {
  if ((event.bySessionId === undefined) === (event.byPrincipal === undefined)) {
    context.addIssue({ code: 'custom', message: 'Project intervention needs exactly one principal or Session' })
  }
})

const ProjectInterventionSchema = z.object({
  epoch: z.number().int().nonnegative(),
  paused: z.boolean(),
  history: z.array(ProjectInterventionEventSchema).min(1),
})

const ProjectNodeReviewSchema = z.object({
  nodeId: z.string().min(1),
  workId: z.string().min(1),
  resultMessageId: z.string().min(1),
  decision: z.enum(['approve', 'rework']),
  reason: z.string().min(1).max(4000),
  reviewer: HomeAddressSchema,
  reviewedBySessionId: z.string().min(1).optional(),
  reviewedByPrincipal: z.string().min(1).max(200).optional(),
  reviewedAt: z.string().min(1),
}).superRefine((review, context) => {
  if ((review.reviewedBySessionId === undefined) === (review.reviewedByPrincipal === undefined)) {
    context.addIssue({ code: 'custom', message: 'Workflow review needs exactly one principal or Session' })
  }
})

const ProjectNodeReviewerAssignmentSchema = z.object({
  nodeId: z.string().min(1),
  workId: z.string().min(1),
  reviewerHome: HomeAddressSchema,
  previousPrincipal: z.string().min(1).max(200).optional(),
  assignedPrincipal: z.string().min(1).max(200),
  assignedByPrincipal: z.string().min(1).max(200),
  reason: z.string().min(1).max(4000),
  at: z.string().datetime(),
})

const ProjectNodeReopenSchema = z.object({
  nodeId: z.string().min(1),
  workId: z.string().min(1),
  rootNodeId: z.string().min(1),
  reason: z.string().min(1).max(4000),
  reopenedBySessionId: z.string().min(1).optional(),
  reopenedByPrincipal: z.string().min(1).max(200).optional(),
  reopenedAt: z.string().min(1),
}).superRefine((reopen, context) => {
  if ((reopen.reopenedBySessionId === undefined) === (reopen.reopenedByPrincipal === undefined)) {
    context.addIssue({ code: 'custom', message: 'Workflow reopen needs exactly one principal or Session' })
  }
})

export const ProjectSeatSchema = z.object({
  id: z.string().regex(/^seat-[a-f0-9]{20}$/),
  address: z.string().min(1).max(200),
  homeAddress: HomeAddressSchema,
  responsibility: z.string().min(1).max(1000),
  status: z.enum(['active', 'released']),
  joinedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  releasedAt: z.string().datetime().optional(),
}).superRefine((seat, context) => {
  if ((seat.status === 'released') !== (seat.releasedAt !== undefined)) {
    context.addIssue({ code: 'custom', path: ['releasedAt'], message: 'released Seat needs a release time' })
  }
})

export type ProjectSeat = Omit<z.infer<typeof ProjectSeatSchema>, 'homeAddress'> & {
  homeAddress: HomeAddress
}

const ProjectSeatEventSchema = z.object({
  seatAddress: z.string().min(1).max(200),
  homeAddress: HomeAddressSchema,
  action: z.enum(['joined', 'responsibility-updated', 'released', 'rejoined']),
  responsibility: z.string().min(1).max(1000),
  bySessionId: z.string().min(1),
  at: z.string().datetime(),
})

export const FormalProjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  idempotencyKey: z.string().min(1).max(128),
  lead: HomeAddressSchema,
  driver: z.string().regex(/^project:project-[a-f0-9]{20}$/).optional(),
  createdBySessionId: z.string().min(1).optional(),
  createdByPrincipal: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(120),
  goal: z.string().min(1).max(4000),
  doneWhen: z.string().min(1).max(2000),
  workflow: ProjectWorkflowSchema.optional(),
  workflowAmendments: z.array(ProjectWorkflowAmendmentSchema).optional(),
  workflowProposals: z.array(ProjectWorkflowProposalSchema).optional(),
  progressionChanges: z.array(ProjectProgressionChangeSchema).optional(),
  intervention: ProjectInterventionSchema.optional(),
  status: z.enum(['open', 'blocked', 'awaiting_acceptance', 'accepted']),
  revision: z.number().int().positive(),
  claims: z.array(ProjectClaimSchema),
  workingAssets: z.array(ProjectWorkingAssetSchema).max(1000).optional(),
  deliveryFeedback: z.array(ProjectDeliveryFeedbackSchema).max(1000).optional(),
  roleSuggestions: z.array(ProjectRoleSuggestionSchema).max(500).optional(),
  roleDecisions: z.array(ProjectRoleDecisionSchema).max(500).optional(),
  humanHandoffs: z.array(ProjectHumanHandoffSchema).max(100).optional(),
  reviews: z.array(ProjectReviewSchema),
  nodeReviews: z.array(ProjectNodeReviewSchema).optional(),
  nodeReviewerAssignments: z.array(ProjectNodeReviewerAssignmentSchema).optional(),
  nodeReopens: z.array(ProjectNodeReopenSchema).optional(),
  seats: z.array(ProjectSeatSchema).max(32).optional(),
  seatEvents: z.array(ProjectSeatEventSchema).optional(),
  currentClaimId: z.string().min(1).optional(),
  acceptedClaimId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).superRefine((project, context) => {
  if (project.driver !== undefined && project.driver !== `project:${project.id}`) {
    context.addIssue({ code: 'custom', path: ['driver'], message: 'Project driver must be its own Main address' })
  }
  if ((project.createdBySessionId === undefined) === (project.createdByPrincipal === undefined)) {
    context.addIssue({ code: 'custom', message: 'Project needs exactly one creation principal or Session' })
  }
  const handoffs = project.humanHandoffs ?? []
  const pendingHandoffs = handoffs.filter(item => item.resolution === undefined)
  if (new Set(handoffs.map(item => item.requestId)).size !== handoffs.length
    || new Set(handoffs.map(item => item.id)).size !== handoffs.length
    || pendingHandoffs.length > 1
    || (pendingHandoffs.length === 1 && pendingHandoffs[0] !== handoffs.at(-1))
    || (project.status === 'blocked') !== (pendingHandoffs.length === 1)) {
    context.addIssue({ code: 'custom', path: ['humanHandoffs'],
      message: 'Project human handoff state must match the current blocker' })
  }
  for (const [index, handoff] of handoffs.entries()) {
    const roleDecision = handoff.assignee.startsWith('role:')
      ? (project.roleDecisions ?? []).filter(item => item.roleHome === handoff.assignee
        && item.at <= handoff.requestedAt).at(-1) : undefined
    if (handoff.id !== stableId('project-human-handoff', `${project.id}:${handoff.requestId}`)
      || handoff.messageId !== projectHumanMessageId(project.id, project.lead, handoff.requestId)
      || handoff.baseProjectRevision >= project.revision
      || (index > 0 && handoff.requestedAt < handoffs[index - 1]!.requestedAt)
      || new Set((handoff.options ?? []).map(item => item.label)).size !== (handoff.options?.length ?? 0)
      || (handoff.assignee.startsWith('user:') && handoff.recipient !== handoff.assignee)
      || handoff.fallbackRecipient === handoff.recipient
      || (handoff.assignee.startsWith('role:') && (roleDecision?.action !== 'assign'
        || `user:${roleDecision.principal}` !== handoff.recipient))
      || (handoff.resolution !== undefined && (![handoff.recipient, handoff.fallbackRecipient]
        .includes(handoff.resolution.byUser)
        || handoff.resolution.at < handoff.requestedAt))) {
      context.addIssue({ code: 'custom', path: ['humanHandoffs', index],
        message: 'Project human handoff history is invalid' })
    }
  }
  const claimIds = new Set(project.claims.map(claim => claim.id))
  const reviewedIds = new Set(project.reviews.map(review => review.claimId))
  const reviewedWorkIds = new Set((project.nodeReviews ?? []).map(review => review.workId))
  const reopenedWorkIds = new Set((project.nodeReopens ?? []).map(reopen => reopen.workId))
  const seats = project.seats ?? []
  if (new Set(seats.map(seat => seat.homeAddress)).size !== seats.length
    || new Set(seats.map(seat => seat.address)).size !== seats.length) {
    context.addIssue({ code: 'custom', path: ['seats'], message: 'Project Seat Home and address must be unique' })
  }
  for (const [index, seat] of seats.entries()) {
    if (seat.id !== stableId('seat', seat.homeAddress)
      || seat.address !== `seat:${project.id}:${seat.id}`
      || seat.homeAddress === project.lead || seat.homeAddress.startsWith('personal:')) {
      context.addIssue({ code: 'custom', path: ['seats', index], message: 'Project Seat identity is invalid' })
    }
  }
  for (const [index, event] of (project.seatEvents ?? []).entries()) {
    if (!seats.some(seat => seat.address === event.seatAddress && seat.homeAddress === event.homeAddress)) {
      context.addIssue({ code: 'custom', path: ['seatEvents', index], message: 'Project Seat event has no matching Seat' })
    }
  }
  if (claimIds.size !== project.claims.length) {
    context.addIssue({ code: 'custom', path: ['claims'], message: 'duplicate Project claim' })
  }
  for (const [index, claim] of project.claims.entries()) {
    const paths = (claim.artifacts ?? []).map(artifact => artifact.path)
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: 'custom', path: ['claims', index, 'artifacts'], message: 'duplicate Project artifact' })
    }
  }
  if (reviewedIds.size !== project.reviews.length) {
    context.addIssue({ code: 'custom', path: ['reviews'], message: 'duplicate Project review' })
  }
  if (reviewedWorkIds.size !== (project.nodeReviews ?? []).length) {
    context.addIssue({ code: 'custom', path: ['nodeReviews'], message: 'duplicate Workflow Work review' })
  }
  if (reopenedWorkIds.size !== (project.nodeReopens ?? []).length) {
    context.addIssue({ code: 'custom', path: ['nodeReopens'], message: 'duplicate Workflow Work reopen' })
  }
  if (project.revision !== 1
    + project.claims.length + (project.workingAssets?.length ?? 0)
    + (project.deliveryFeedback?.length ?? 0)
    + (project.deliveryFeedback ?? []).filter(item => item.resolution !== undefined).length
    + (project.roleSuggestions?.length ?? 0) + (project.roleDecisions?.length ?? 0)
    + handoffs.length + handoffs.filter(item => item.resolution !== undefined).length
    + project.reviews.length + (project.nodeReviews?.length ?? 0)
    + (project.nodeReviewerAssignments?.length ?? 0)
    + (project.nodeReopens?.length ?? 0) + (project.seatEvents?.length ?? 0)
    + (project.workflowAmendments?.length ?? 0)
    + (project.workflowProposals?.length ?? 0)
    + (project.progressionChanges?.length ?? 0)
    + (project.intervention?.history.length ?? 0)) {
    context.addIssue({ code: 'custom', path: ['revision'], message: 'Project revision does not match its history' })
  }
  const amendments = project.workflowAmendments ?? []
  const workingAssets = project.workingAssets ?? []
  if (new Set(workingAssets.map(item => item.idempotencyKey)).size !== workingAssets.length) {
    context.addIssue({ code: 'custom', path: ['workingAssets'], message: 'duplicate Project working asset key' })
  }
  const latestAsset = new Map<string, (typeof workingAssets)[number]>()
  for (const [index, asset] of workingAssets.entries()) {
    const previous = latestAsset.get(asset.path)
    if (asset.revision !== (previous?.revision ?? 0) + 1
      || asset.previousSha256 !== previous?.sha256
      || (index > 0 && asset.baseProjectRevision <= workingAssets[index - 1]!.baseProjectRevision)
      || asset.baseProjectRevision >= project.revision
      || (index > 0 && asset.publishedAt < workingAssets[index - 1]!.publishedAt)) {
      context.addIssue({ code: 'custom', path: ['workingAssets', index],
        message: 'Project working asset revision chain is invalid' })
    }
    latestAsset.set(asset.path, asset)
  }
  const feedback = project.deliveryFeedback ?? []
  if (new Set(feedback.map(item => item.idempotencyKey)).size !== feedback.length) {
    context.addIssue({ code: 'custom', path: ['deliveryFeedback'], message: 'duplicate Project feedback key' })
  }
  for (const [index, item] of feedback.entries()) {
    const working = item.workingRevision === undefined ? undefined
      : workingAssets.find(asset => asset.path === item.path && asset.revision === item.workingRevision)
    const claim = item.claimId === undefined ? undefined
      : project.claims.find(value => value.id === item.claimId)
    const artifact = claim?.artifacts?.find(value => value.path === item.path)
    if (item.id !== stableId('project-feedback', `${project.id}:${item.idempotencyKey}`)
      || (item.version === 'working'
        ? working?.sha256 !== item.sha256 || working.bytes !== item.bytes || item.at < working.publishedAt
        : artifact?.sha256 !== item.sha256 || artifact.bytes !== item.bytes || item.at < claim!.submittedAt)
      || (index > 0 && item.at < feedback[index - 1]!.at)) {
      context.addIssue({ code: 'custom', path: ['deliveryFeedback', index],
        message: 'Project feedback source is invalid' })
    }
    if (item.resolution !== undefined) {
      const resolved = workingAssets.find(asset => asset.path === item.resolution!.path
        && asset.revision === item.resolution!.workingRevision)
      if (resolved?.sha256 !== item.resolution.sha256
        || item.resolution.at < item.at || (resolved && item.resolution.at < resolved.publishedAt)) {
        context.addIssue({ code: 'custom', path: ['deliveryFeedback', index, 'resolution'],
          message: 'Project feedback resolution source is invalid' })
      }
    }
  }
  const roleSuggestions = project.roleSuggestions ?? []
  const roleDecisions = project.roleDecisions ?? []
  if (new Set(roleSuggestions.map(item => item.idempotencyKey)).size !== roleSuggestions.length) {
    context.addIssue({ code: 'custom', path: ['roleSuggestions'], message: 'duplicate Project role suggestion key' })
  }
  if (new Set(roleDecisions.map(item => item.idempotencyKey)).size !== roleDecisions.length) {
    context.addIssue({ code: 'custom', path: ['roleDecisions'], message: 'duplicate Project role decision key' })
  }
  const roleEventBases = [...roleSuggestions, ...roleDecisions].map(item => item.baseProjectRevision)
  if (new Set(roleEventBases).size !== roleEventBases.length) {
    context.addIssue({ code: 'custom', path: ['roleDecisions'],
      message: 'Project role events reuse a Project revision' })
  }
  const roleHomes = new Set(seats.map(seat => seat.homeAddress))
  for (const [index, suggestion] of roleSuggestions.entries()) {
    const expectedBaseRoleRevision = roleDecisions.filter(item => item.roleHome === suggestion.roleHome
      && item.action !== 'reject' && item.baseProjectRevision < suggestion.baseProjectRevision).length
    if (suggestion.id !== stableId('project-role-suggestion', `${project.id}:${suggestion.idempotencyKey}`)
      || !roleHomes.has(suggestion.roleHome)
      || suggestion.baseProjectRevision >= project.revision
      || suggestion.baseRoleRevision !== expectedBaseRoleRevision
      || (index > 0 && (suggestion.at < roleSuggestions[index - 1]!.at
        || suggestion.baseProjectRevision <= roleSuggestions[index - 1]!.baseProjectRevision))) {
      context.addIssue({ code: 'custom', path: ['roleSuggestions', index],
        message: 'Project role suggestion source is invalid' })
    }
  }
  const decidedSuggestions = new Set<string>()
  const roleBindings = new Map<string, string>()
  const roleRevisions = new Map<string, number>()
  let bindingRevision = 0
  for (const [index, decision] of roleDecisions.entries()) {
    const suggestion = decision.suggestionId === undefined ? undefined
      : roleSuggestions.find(item => item.id === decision.suggestionId)
    const previous = roleBindings.get(decision.roleHome)
    const roleRevision = roleRevisions.get(decision.roleHome) ?? 0
    if (decision.id !== stableId('project-role-decision', `${project.id}:${decision.idempotencyKey}`)
      || !roleHomes.has(decision.roleHome)
      || decision.baseProjectRevision >= project.revision
      || decision.previousPrincipal !== previous
      || (index > 0 && (decision.at < roleDecisions[index - 1]!.at
        || decision.baseProjectRevision <= roleDecisions[index - 1]!.baseProjectRevision))
      || (decision.suggestionId !== undefined && (suggestion === undefined
        || suggestion.roleHome !== decision.roleHome || suggestion.at > decision.at
        || decidedSuggestions.has(decision.suggestionId)))
      || (decision.action === 'clear' && decision.suggestionId !== undefined)
      || (decision.action === 'assign' && suggestion !== undefined
        && (suggestion.proposedPrincipal !== decision.principal
          || suggestion.baseRoleRevision !== roleRevision))) {
      context.addIssue({ code: 'custom', path: ['roleDecisions', index],
        message: 'Project role decision source is invalid' })
    }
    if (decision.suggestionId !== undefined) decidedSuggestions.add(decision.suggestionId)
    if (decision.action === 'reject') {
      if (decision.baseBindingRevision !== bindingRevision
        || decision.bindingRevision !== bindingRevision) {
        context.addIssue({ code: 'custom', path: ['roleDecisions', index],
          message: 'Project role binding revision is invalid' })
      }
      continue
    }
    bindingRevision++
    if (decision.baseBindingRevision !== bindingRevision - 1
      || decision.bindingRevision !== bindingRevision) {
      context.addIssue({ code: 'custom', path: ['roleDecisions', index],
        message: 'Project role binding revision is invalid' })
    }
    roleRevisions.set(decision.roleHome, roleRevision + 1)
    if (decision.action === 'assign') roleBindings.set(decision.roleHome, decision.principal!)
    else roleBindings.delete(decision.roleHome)
  }
  const proposals = project.workflowProposals ?? []
  const progressionChanges = project.progressionChanges ?? []
  if (progressionChanges.length > 0 && project.workflow === undefined) {
    context.addIssue({ code: 'custom', path: ['progressionChanges'],
      message: 'Project progression requires a Workflow' })
  }
  for (const [index, change] of progressionChanges.entries()) {
    if (change.revision !== index + 1 || (index > 0 && change.at < progressionChanges[index - 1]!.at)) {
      context.addIssue({ code: 'custom', path: ['progressionChanges', index],
        message: 'Project progression history is invalid' })
    }
  }
  if (proposals.length > 0 && project.workflow === undefined) {
    context.addIssue({ code: 'custom', path: ['workflowProposals'], message: 'Workflow proposal needs an existing Workflow' })
  }
  if (new Set(proposals.map(item => item.idempotencyKey)).size !== proposals.length) {
    context.addIssue({ code: 'custom', path: ['workflowProposals'], message: 'duplicate Workflow proposal key' })
  }
  for (const [index, proposal] of proposals.entries()) {
    if (proposal.baseWorkflowRevision > (project.workflow?.revision ?? 0)
      || (index > 0 && proposal.at < proposals[index - 1]!.at)) {
      context.addIssue({ code: 'custom', path: ['workflowProposals', index],
        message: 'Workflow proposal history is invalid' })
    }
  }
  if (amendments.length > 0 && project.workflow === undefined) {
    context.addIssue({ code: 'custom', path: ['workflowAmendments'], message: 'amended Project needs a Workflow' })
  }
  if (new Set(amendments.map(item => item.idempotencyKey)).size !== amendments.length) {
    context.addIssue({ code: 'custom', path: ['workflowAmendments'], message: 'duplicate Workflow amendment key' })
  }
  for (const [index, amendment] of amendments.entries()) {
    if (amendment.proposalKey !== undefined && !proposals.some(proposal =>
      proposal.idempotencyKey === amendment.proposalKey && proposal.at <= amendment.at
      && proposal.baseWorkflowRevision === amendment.before.revision)) {
      context.addIssue({ code: 'custom', path: ['workflowAmendments', index],
        message: 'Workflow amendment proposal reference is invalid' })
    }
    if (amendment.before.revision !== index + 1 || amendment.after.revision !== index + 2
      || (index > 0 && JSON.stringify(amendments[index - 1]?.after) !== JSON.stringify(amendment.before))) {
      context.addIssue({ code: 'custom', path: ['workflowAmendments', index],
        message: 'Workflow amendment revisions do not form one history' })
    }
    const nextIds = new Set(amendment.after.steps.map(step => step.id))
    if (amendment.mode !== 'rebuild' && amendment.before.steps.some(step => !nextIds.has(step.id))) {
      context.addIssue({ code: 'custom', path: ['workflowAmendments', index],
        message: 'in-place Workflow amendment cannot remove a node' })
    }
  }
  if (project.workflow !== undefined && (project.workflow.revision !== amendments.length + 1
    || (amendments.length > 0
      && JSON.stringify(amendments.at(-1)?.after) !== JSON.stringify(project.workflow)))) {
    context.addIssue({ code: 'custom', path: ['workflow'], message: 'current Workflow must match its amendment history' })
  }
  const historicalNodeIds = new Set([project.workflow, ...amendments.map(item => item.before)]
    .flatMap(workflow => workflow?.steps.map(step => step.id) ?? []))
  for (const [index, change] of progressionChanges.entries()) {
    if (change.reviewers.some(item => !historicalNodeIds.has(item.nodeId))) {
      context.addIssue({ code: 'custom', path: ['progressionChanges', index],
        message: 'Project progression references an unknown Workflow node' })
    }
  }
  const intervention = project.intervention
  if (intervention !== undefined) {
    let epoch = 0
    let paused = false
    for (const [index, event] of intervention.history.entries()) {
      if (event.action === 'pause' && paused) {
        context.addIssue({ code: 'custom', path: ['intervention', 'history', index],
          message: 'Project cannot be paused twice without resuming' })
      }
      if (event.action === 'resume' && !paused) {
        context.addIssue({ code: 'custom', path: ['intervention', 'history', index],
          message: 'Project cannot resume before a pause' })
      }
      if (event.action === 'resume') epoch++
      paused = event.action === 'pause'
      if (event.epoch !== epoch) {
        context.addIssue({ code: 'custom', path: ['intervention', 'history', index],
          message: 'Project execution epoch does not match intervention history' })
      }
    }
    if (intervention.epoch !== epoch || intervention.paused !== paused
      || (intervention.paused && !['open', 'blocked'].includes(project.status))) {
      context.addIssue({ code: 'custom', path: ['intervention'],
        message: 'Project intervention state does not match its history or status' })
    }
  }
  for (const [index, amendment] of amendments.entries()) {
    if (amendment.mode === 'rebuild' && !intervention?.history.some(event => event.action === 'pause'
      && event.epoch + 1 === amendment.executionEpoch && event.at <= amendment.at)) {
      context.addIssue({ code: 'custom', path: ['workflowAmendments', index],
        message: 'Workflow rebuild must belong to a paused execution epoch' })
    }
  }
  if (project.currentClaimId !== undefined && !claimIds.has(project.currentClaimId)) {
    context.addIssue({ code: 'custom', path: ['currentClaimId'], message: 'current claim is missing' })
  }
  if (project.currentClaimId !== project.claims.at(-1)?.id) {
    context.addIssue({ code: 'custom', path: ['currentClaimId'], message: 'current claim must be the latest version' })
  }
  if (project.acceptedClaimId !== undefined && !claimIds.has(project.acceptedClaimId)) {
    context.addIssue({ code: 'custom', path: ['acceptedClaimId'], message: 'accepted claim is missing' })
  }
  if (project.status === 'awaiting_acceptance' && project.currentClaimId === undefined) {
    context.addIssue({ code: 'custom', path: ['currentClaimId'], message: 'submission is required' })
  }
  if (project.status === 'accepted' && project.acceptedClaimId === undefined) {
    context.addIssue({ code: 'custom', path: ['acceptedClaimId'], message: 'acceptance is required' })
  }
  if (project.status === 'accepted' && (project.acceptedClaimId !== project.currentClaimId
    || project.reviews.at(-1)?.decision !== 'accept'
    || project.reviews.at(-1)?.claimId !== project.currentClaimId)) {
    context.addIssue({ code: 'custom', path: ['acceptedClaimId'], message: 'accepted Project requires a review of the current claim' })
  }
  if (project.status === 'awaiting_acceptance' && reviewedIds.has(project.currentClaimId ?? '')) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'pending claim is already reviewed' })
  }
  if (['open', 'blocked'].includes(project.status) && project.claims.length > 0
    && (project.reviews.at(-1)?.decision !== 'rework'
      || project.reviews.at(-1)?.claimId !== project.currentClaimId)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'open Project with a claim requires rework' })
  }
  for (const [index, review] of project.reviews.entries()) {
    if (!claimIds.has(review.claimId)) {
      context.addIssue({ code: 'custom', path: ['reviews', index], message: 'reviewed claim is missing' })
    }
  }
  for (const [index, review] of (project.nodeReviews ?? []).entries()) {
    const historicalSteps = [project.workflow, ...amendments.map(item => item.before)]
      .flatMap(workflow => workflow?.steps ?? [])
    if (!historicalSteps.some(step => step.id === review.nodeId && step.reviewer === review.reviewer)
      && !progressionChanges.some(change => change.at <= review.reviewedAt
        && change.reviewers.some(item =>
        item.nodeId === review.nodeId && item.reviewerHome === review.reviewer))) {
      context.addIssue({ code: 'custom', path: ['nodeReviews', index], message: 'Workflow reviewer is not assigned to this node' })
    }
  }
  const assignedPrincipalByWork = new Map<string, string>()
  const assignmentNodeByWork = new Map<string, string>()
  const assignmentHomeByWork = new Map<string, string>()
  for (const [index, assignment] of (project.nodeReviewerAssignments ?? []).entries()) {
    const historicalSteps = [project.workflow, ...amendments.map(item => item.before)]
      .flatMap(workflow => workflow?.steps ?? [])
    if (!historicalSteps.some(step => step.id === assignment.nodeId
      && step.reviewer === assignment.reviewerHome)
      && !progressionChanges.some(change => change.at <= assignment.at
        && change.reviewers.some(item =>
        item.nodeId === assignment.nodeId && item.reviewerHome === assignment.reviewerHome))
      || assignment.previousPrincipal !== assignedPrincipalByWork.get(assignment.workId)
      || assignment.assignedPrincipal === assignment.previousPrincipal
      || (assignmentNodeByWork.has(assignment.workId)
        && assignmentNodeByWork.get(assignment.workId) !== assignment.nodeId)
      || (assignmentHomeByWork.has(assignment.workId)
        && assignmentHomeByWork.get(assignment.workId) !== assignment.reviewerHome)) {
      context.addIssue({ code: 'custom', path: ['nodeReviewerAssignments', index],
        message: 'Workflow reviewer assignment history is invalid' })
    }
    assignedPrincipalByWork.set(assignment.workId, assignment.assignedPrincipal)
    assignmentNodeByWork.set(assignment.workId, assignment.nodeId)
    assignmentHomeByWork.set(assignment.workId, assignment.reviewerHome)
  }
  for (const [index, review] of (project.nodeReviews ?? []).entries()) {
    const assigned = assignedPrincipalByWork.get(review.workId)
    if (assigned !== undefined && review.reviewedByPrincipal !== assigned) {
      context.addIssue({ code: 'custom', path: ['nodeReviews', index],
        message: 'Workflow review was not made by its assigned human reviewer' })
    }
  }
  for (const [index, reopen] of (project.nodeReopens ?? []).entries()) {
    const historicalIds = new Set([project.workflow, ...amendments.map(item => item.before)]
      .flatMap(workflow => workflow?.steps.map(step => step.id) ?? []))
    if (!historicalIds.has(reopen.nodeId) || !historicalIds.has(reopen.rootNodeId)) {
      context.addIssue({ code: 'custom', path: ['nodeReopens', index], message: 'reopened Workflow node is missing' })
    }
  }
})

export type FormalProject = Omit<z.infer<typeof FormalProjectSchema>, 'lead' | 'seats'> & {
  lead: HomeAddress
  seats?: ProjectSeat[]
}

export function projectRoleAssignmentState(project: FormalProject): {
  revision: number
  bindings: Array<{ roleHome: string; principal: string; byPrincipal: string; at: string }>
  suggestions: Array<NonNullable<FormalProject['roleSuggestions']>[number] & {
    status: 'pending' | 'accepted' | 'rejected' | 'superseded'
    decidedByPrincipal?: string; decidedAt?: string
  }>
} {
  const bindings = new Map<string, { roleHome: string; principal: string;
    byPrincipal: string; at: string }>()
  const roleRevisions = new Map<string, number>()
  const decisions = project.roleDecisions ?? []
  for (const decision of decisions) {
    if (decision.action === 'reject') continue
    roleRevisions.set(decision.roleHome, (roleRevisions.get(decision.roleHome) ?? 0) + 1)
    if (decision.action === 'assign') bindings.set(decision.roleHome, {
      roleHome: decision.roleHome, principal: decision.principal!,
      byPrincipal: decision.byPrincipal, at: decision.at })
    else bindings.delete(decision.roleHome)
  }
  const suggestions = (project.roleSuggestions ?? []).map(item => {
    const decision = decisions.find(value => value.suggestionId === item.id)
    const status: 'pending' | 'accepted' | 'rejected' | 'superseded' = decision !== undefined
      ? (decision.action === 'reject' ? 'rejected' : 'accepted')
      : project.seats?.some(seat => seat.homeAddress === item.roleHome && seat.status === 'active')
        && (roleRevisions.get(item.roleHome) ?? 0) === item.baseRoleRevision
        ? 'pending' : 'superseded'
    return { ...item, status,
      ...(decision === undefined ? {} : { decidedByPrincipal: decision.byPrincipal, decidedAt: decision.at }) }
  })
  return { revision: decisions.at(-1)?.bindingRevision ?? 0,
    bindings: [...bindings.values()], suggestions }
}

export const BIZAGENT_PROJECT_DOMAIN = defineDomain({
  name: 'bizagent_project',
  version: 0,
  tables: { projects: domainTable<string, z.infer<typeof FormalProjectSchema>>(FormalProjectSchema) },
})

type ProjectDomain = Domain<typeof BIZAGENT_PROJECT_DOMAIN>

export class ProjectLedger {
  private mutationTail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly domain: ProjectDomain) {}

  static async open(facility: DomainFacility): Promise<ProjectLedger> {
    return new ProjectLedger(await facility.open(BIZAGENT_PROJECT_DOMAIN))
  }

  async withWrite<T>(update: () => Promise<T>): Promise<T> {
    const task = this.mutationTail.catch(() => undefined).then(update)
    this.mutationTail = task
    return task
  }

  get(id: string): FormalProject | undefined {
    const record = this.domain.table('projects').get(id)
    return record === undefined ? undefined : FormalProjectSchema.parse(record) as FormalProject
  }

  list(): FormalProject[] {
    return [...this.domain.table('projects').entries()]
      .map(([, record]) => FormalProjectSchema.parse(record) as FormalProject)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }

  async put(project: FormalProject): Promise<void> {
    const parsed = FormalProjectSchema.parse(project) as FormalProject
    await this.domain.table('projects').put(parsed.id, parsed)
  }

  async close(): Promise<void> {
    await this.domain.close()
  }
}
