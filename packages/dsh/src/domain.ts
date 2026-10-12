import { createHash } from 'node:crypto'
import { z } from 'zod'

export const HOME_TYPES = ['personal', 'line', 'business', 'role', 'capability'] as const
export type HomeType = typeof HOME_TYPES[number]

export const ORGANIZATION_RELATIONS = ['member-of', 'fulfills-role', 'serves', 'belongs-to-line'] as const
export type OrganizationRelation = typeof ORGANIZATION_RELATIONS[number]

export const ASSET_KINDS = ['memory', 'insight', 'knowledge', 'method', 'identity'] as const
export type AssetKind = typeof ASSET_KINDS[number]

export const ASSET_STATUSES = ['candidate', 'active', 'superseded', 'retired'] as const
export type AssetStatus = typeof ASSET_STATUSES[number]

export const HomeAddressSchema = z.string().refine((value) => {
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) return false
  return (HOME_TYPES as readonly string[]).includes(value.slice(0, separator))
    && /^[a-z0-9][a-z0-9._/-]*$/i.test(value.slice(separator + 1))
}, 'expected <personal|line|business|role|capability>:<id>')

export type HomeAddress = `${HomeType}:${string}`

export const UserAddressSchema = z.string().regex(/^user:[a-z0-9][a-z0-9._-]{0,127}$/i)
export type UserAddress = `user:${string}`
export const ProjectSeatAddressSchema = z.string().regex(/^seat:[a-z0-9][a-z0-9._-]{0,127}:seat-[a-f0-9]{20}$/)
export type ProjectSeatAddress = `seat:${string}:seat-${string}`
export const InboxAddressSchema = z.union([HomeAddressSchema, UserAddressSchema, ProjectSeatAddressSchema])
export type InboxAddress = HomeAddress | UserAddress | ProjectSeatAddress
export const InboxSenderAddressSchema = z.union([InboxAddressSchema, z.literal('engine:inbox')])
export type InboxSenderAddress = InboxAddress | 'engine:inbox'

export const HumanActionSchema = z.strictObject({
  request: z.string().trim().min(1).max(3000),
  reason: z.string().trim().min(1).max(3000),
  options: z.array(z.strictObject({
    label: z.string().trim().min(1).max(80),
    detail: z.string().trim().max(200).optional(),
  })).min(2).max(6).optional(),
  recommendation: z.string().trim().min(1).max(3000).optional(),
  href: z.string().max(2000).optional(),
  label: z.string().trim().min(1).max(80).optional(),
}).superRefine((action, context) => {
  if (action.options !== undefined
    && new Set(action.options.map(option => option.label)).size !== action.options.length) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'human action option labels must be unique' })
  }
  if (action.href === undefined) return
  try {
    const decoded = decodeURIComponent(action.href)
    if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\s\u0000-\u001f]/u.test(decoded)) {
      throw new Error('unsafe path')
    }
    const url = new URL(action.href, 'https://bizagent.invalid')
    if (url.origin !== 'https://bizagent.invalid' || url.pathname.startsWith('/api/')) {
      throw new Error('unsafe path')
    }
  } catch {
    context.addIssue({ code: 'custom', path: ['href'], message: 'human action href must be an application page path' })
  }
})
export type HumanAction = z.infer<typeof HumanActionSchema>

export const EvidenceRefSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session-events'),
    sessionId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('worklog'),
    sessionId: z.string().min(1),
    revisionId: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    type: z.literal('tool-result'),
    sessionId: z.string().min(1),
    eventSeq: z.number().int().nonnegative(),
    toolCallId: z.string().min(1),
  }),
  z.object({
    type: z.literal('artifact'),
    uri: z.string().min(1),
    digest: z.string().min(1),
  }),
  z.object({
    type: z.literal('document'),
    uri: z.string().min(1),
    digest: z.string().min(1),
    authority: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('asset'),
    ownerAddress: HomeAddressSchema,
    assetId: z.string().min(1),
    revision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('user-confirmation'),
    sessionId: z.string().min(1),
    eventSeq: z.number().int().nonnegative(),
  }),
])

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>

export const AgentHomeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  address: HomeAddressSchema,
  type: z.enum(HOME_TYPES),
  displayName: z.string().min(1),
  owner: z.string().min(1).optional(),
  revision: z.number().int().positive(),
  contextDigest: z.string(),
  status: z.enum(['active', 'archived']),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

export type AgentHome = z.infer<typeof AgentHomeSchema> & { address: HomeAddress }

export const OrganizationLinkSchema = z.object({
  from: HomeAddressSchema,
  to: HomeAddressSchema,
  relation: z.enum(ORGANIZATION_RELATIONS),
})

export const OrganizationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  name: z.string().min(1),
  mission: z.string().min(1),
  lineHome: HomeAddressSchema.optional(),
  businessHome: HomeAddressSchema,
  members: z.array(z.object({
    personalHome: HomeAddressSchema,
    roleHome: HomeAddressSchema,
  })).min(1),
  capabilityHomes: z.array(HomeAddressSchema),
  links: z.array(OrganizationLinkSchema),
  revision: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).superRefine((organization, context) => {
  if (!organization.businessHome.startsWith('business:')) {
    context.addIssue({ code: 'custom', path: ['businessHome'], message: 'businessHome must be a Business Home' })
  }
  if (organization.lineHome !== undefined && !organization.lineHome.startsWith('line:')) {
    context.addIssue({ code: 'custom', path: ['lineHome'], message: 'lineHome must be a Line Home' })
  }
  const declared = new Set<string>([organization.businessHome,
    ...(organization.lineHome === undefined ? [] : [organization.lineHome])])
  const seenMembers = new Set<string>()
  organization.members.forEach((member, index) => {
    if (!member.personalHome.startsWith('personal:')) {
      context.addIssue({ code: 'custom', path: ['members', index, 'personalHome'], message: 'member must use a Personal Home' })
    }
    if (!member.roleHome.startsWith('role:')) {
      context.addIssue({ code: 'custom', path: ['members', index, 'roleHome'], message: 'member role must use a Role Home' })
    }
    if (seenMembers.has(member.personalHome)) {
      context.addIssue({ code: 'custom', path: ['members', index, 'personalHome'], message: 'duplicate organization member' })
    }
    seenMembers.add(member.personalHome)
    declared.add(member.personalHome)
    declared.add(member.roleHome)
  })
  organization.capabilityHomes.forEach((address, index) => {
    if (!address.startsWith('capability:')) {
      context.addIssue({ code: 'custom', path: ['capabilityHomes', index], message: 'capability must use a Capability Home' })
    }
    declared.add(address)
  })
  organization.links.forEach((link, index) => {
    if (!declared.has(link.from) || !declared.has(link.to)) {
      context.addIssue({ code: 'custom', path: ['links', index], message: 'link endpoints must belong to this organization' })
    }
    const validShape = link.relation === 'member-of'
      ? link.from.startsWith('personal:') && link.to === organization.businessHome
      : link.relation === 'fulfills-role'
        ? link.from.startsWith('personal:') && link.to.startsWith('role:')
      : link.relation === 'belongs-to-line'
        ? organization.lineHome !== undefined && link.to === organization.lineHome
          && (link.from.startsWith('business:') || link.from.startsWith('role:')
            || link.from.startsWith('capability:'))
        : (link.from.startsWith('role:') || link.from.startsWith('capability:'))
          && link.to === organization.businessHome
    if (!validShape) context.addIssue({ code: 'custom', path: ['links', index], message: 'relation has invalid Home types' })
  })
})

export type Organization = Omit<z.infer<typeof OrganizationSchema>, 'lineHome' | 'businessHome' | 'members' | 'capabilityHomes' | 'links'> & {
  lineHome?: HomeAddress
  businessHome: HomeAddress
  members: Array<{ personalHome: HomeAddress; roleHome: HomeAddress }>
  capabilityHomes: HomeAddress[]
  links: Array<{ from: HomeAddress; to: HomeAddress; relation: OrganizationRelation }>
}

export const AssetMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  ownerAddress: HomeAddressSchema,
  kind: z.enum(ASSET_KINDS),
  title: z.string().min(1).optional(),
  description: z.string().min(1).max(1000),
  tags: z.array(z.string().min(1).max(80)).default([]),
  sourceRefs: z.array(EvidenceRefSchema).min(1),
  confidence: z.number().min(0).max(1),
  fitness: z.number().min(-1).max(1),
  status: z.enum(ASSET_STATUSES),
  revision: z.number().int().positive(),
  proposalId: z.string().min(1).optional(),
  proposalApplications: z.array(z.object({
    proposalId: z.string().min(1), revision: z.number().int().positive(),
    bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).max(500).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).superRefine((asset, context) => {
  const applications = asset.proposalApplications ?? []
  if (new Set(applications.map(item => item.proposalId)).size !== applications.length
    || applications.some(item => item.revision > asset.revision)) {
    context.addIssue({ code: 'custom', message: 'asset proposal applications conflict with revision history' })
  }
})

export type AssetMetadata = z.infer<typeof AssetMetadataSchema> & { ownerAddress: HomeAddress }

export interface StoredAsset extends AssetMetadata {
  body: string
  bodyPath: string
}

export const SessionBindingSchema = z.object({
  sessionId: z.string().min(1),
  homeAddress: HomeAddressSchema,
  cwd: z.string().optional(),
  boundAt: z.string().min(1),
})

export type SessionBinding = z.infer<typeof SessionBindingSchema> & { homeAddress: HomeAddress }

export const ProjectTurnParticipationSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1).max(128),
  sessionId: z.string().min(1),
  homeAddress: HomeAddressSchema,
  turn: z.number().int().nonnegative(),
  recordedAt: z.string().datetime(),
})

export type ProjectTurnParticipation = z.infer<typeof ProjectTurnParticipationSchema> & {
  homeAddress: HomeAddress
}

export const LearningMaterialObservationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  homeAddress: HomeAddressSchema,
  sessionId: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  eventCount: z.number().int().positive(),
  lastSeq: z.number().int().nonnegative(),
  sourceKind: z.literal('worklog').optional(),
  worklogRevisionId: z.string().min(1).optional(),
  worklogRevision: z.number().int().positive().optional(),
  observedAt: z.string().min(1),
}).superRefine((observation, context) => {
  if (observation.sourceKind === 'worklog'
    ? observation.worklogRevisionId === undefined || observation.worklogRevision === undefined
    : observation.worklogRevisionId !== undefined || observation.worklogRevision !== undefined) {
    context.addIssue({ code: 'custom', path: ['worklogRevisionId'],
      message: 'Worklog material requires an exact revision ID and number' })
  }
})

export type LearningMaterialObservation = z.infer<typeof LearningMaterialObservationSchema> & {
  homeAddress: HomeAddress
}

export const LearningMaterialReviewSchema = z.object({
  schemaVersion: z.literal(1),
  materialId: z.string().min(1),
  homeAddress: HomeAddressSchema,
  reviewerSessionId: z.string().min(1),
  summary: z.string().min(1).max(2000),
  batchRunId: z.string().min(1).optional(),
  assetIds: z.array(z.string().min(1)).max(3).optional(),
  reviewedAt: z.string().min(1),
})

export type LearningMaterialReview = z.infer<typeof LearningMaterialReviewSchema> & { homeAddress: HomeAddress }

export const LearningLibraryFileSchema = z.object({
  path: z.string().min(1).max(500),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
})

export type LearningLibraryFile = z.infer<typeof LearningLibraryFileSchema>

export const LearningLibraryChangeSchema = z.object({
  path: z.string().min(1).max(500),
  result: z.enum(['created', 'updated', 'deleted']),
  before: LearningLibraryFileSchema.optional(),
  after: LearningLibraryFileSchema.optional(),
}).superRefine((change, context) => {
  if (change.before?.path !== undefined && change.before.path !== change.path
    || change.after?.path !== undefined && change.after.path !== change.path
    || change.result === 'created' && (change.before !== undefined || change.after === undefined)
    || change.result === 'deleted' && (change.before === undefined || change.after !== undefined)
    || change.result === 'updated' && (change.before === undefined || change.after === undefined
      || change.before.sha256 === change.after.sha256)) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'invalid learning library change' })
  }
})

export type LearningLibraryChange = z.infer<typeof LearningLibraryChangeSchema>

export const LearningBatchRunSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  homeAddress: HomeAddressSchema,
  reviewerSessionId: z.string().min(1),
  materialIds: z.array(z.string().min(1)).min(1).max(8),
  status: z.enum(['open', 'completed', 'abandoned']),
  summary: z.string().min(1).max(2000).optional(),
  libraryBefore: z.array(LearningLibraryFileSchema).max(1000).optional(),
  libraryChanges: z.array(LearningLibraryChangeSchema).max(1000).optional(),
  libraryChangeError: z.string().min(1).max(500).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).superRefine((run, context) => {
  if (new Set(run.materialIds).size !== run.materialIds.length) {
    context.addIssue({ code: 'custom', path: ['materialIds'], message: 'duplicate learning material' })
  }
  if (run.status !== 'open' && run.summary === undefined) {
    context.addIssue({ code: 'custom', path: ['summary'], message: 'settled learning batch requires a summary' })
  }
  if (new Set((run.libraryBefore ?? []).map(file => file.path)).size !== (run.libraryBefore?.length ?? 0)
    || new Set((run.libraryChanges ?? []).map(change => change.path)).size !== (run.libraryChanges?.length ?? 0)
    || (run.status === 'open' && run.libraryChanges !== undefined)
    || (run.status === 'open' && run.libraryChangeError !== undefined)
    || (run.libraryChangeError !== undefined && run.libraryBefore === undefined)
    || (run.libraryChanges !== undefined && (run.libraryBefore === undefined
      || run.libraryChangeError !== undefined))) {
    context.addIssue({ code: 'custom', path: ['libraryChanges'], message: 'invalid learning library snapshot chain' })
  }
})

export type LearningBatchRun = z.infer<typeof LearningBatchRunSchema> & { homeAddress: HomeAddress }

export const LearningLaunchSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  homeAddress: HomeAddressSchema,
  requestedBySessionId: z.string().min(1),
  workerSessionId: z.string().min(1),
  workspace: z.string().min(1),
  promptMessageId: z.string().min(1),
  provider: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  maxTokens: z.number().int().positive().optional(),
  trigger: z.enum(['explicit', 'schedule']).optional(),
  scheduledFor: z.number().int().nonnegative().optional(),
  status: z.enum(['reserved', 'active', 'completed', 'needs_review', 'abandoned']),
  reason: z.string().min(1).max(2000).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).superRefine((launch, context) => {
  if (launch.trigger === 'schedule' && launch.scheduledFor === undefined) {
    context.addIssue({ code: 'custom', path: ['scheduledFor'], message: 'scheduled learning launch needs its due time' })
  }
  if (launch.status === 'needs_review' && !launch.reason) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'uncertain learning launch needs a reason' })
  }
})

export type LearningLaunch = z.infer<typeof LearningLaunchSchema> & { homeAddress: HomeAddress }

export const LearningScheduleCursorSchema = z.object({
  schemaVersion: z.literal(1),
  homeAddress: HomeAddressSchema,
  scheduleFingerprint: z.string().min(1),
  nextDueAt: z.number().int().nonnegative(),
  lastDueAt: z.number().int().nonnegative().optional(),
  lastOutcome: z.enum(['launched', 'empty', 'limit', 'deferred', 'expired']).optional(),
  lastLaunchId: z.string().min(1).optional(),
  lastReason: z.string().min(1).max(2000).optional(),
  updatedAt: z.string().min(1),
})

export type LearningScheduleCursor = z.infer<typeof LearningScheduleCursorSchema> & { homeAddress: HomeAddress }

export const LearningSchedulePolicySchema = z.object({
  schemaVersion: z.literal(1),
  homeAddress: HomeAddressSchema,
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  cron: z.string().min(1).max(100),
  dailyRuns: z.number().int().min(1).max(4),
  updatedBy: z.literal('local-ui'),
  updatedAt: z.string().min(1),
})

export type LearningSchedulePolicy = z.infer<typeof LearningSchedulePolicySchema> & { homeAddress: HomeAddress }

export const FRAME_MODES = ['lead', 'contribute', 'reference'] as const
export type FrameMode = typeof FRAME_MODES[number]

export const AgentFrameSchema = z.object({
  address: HomeAddressSchema,
  mode: z.enum(FRAME_MODES),
  revision: z.number().int().positive(),
  digest: z.string(),
  contextEpoch: z.number().int().positive().optional(),
  openedAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

export type AgentFrame = Omit<z.infer<typeof AgentFrameSchema>, 'address'> & { address: HomeAddress }

export const AgentFrameStateSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  primaryHome: HomeAddressSchema,
  contextEpoch: z.number().int().positive().optional(),
  lastCompactionSeq: z.number().int().nonnegative().optional(),
  frames: z.array(AgentFrameSchema).max(8),
  focusAddress: HomeAddressSchema.optional(),
  updatedAt: z.string().min(1),
}).superRefine((state, context) => {
  const addresses = new Set<string>()
  let leads = 0
  state.frames.forEach((frame, index) => {
    if (frame.address === state.primaryHome || addresses.has(frame.address)) {
      context.addIssue({ code: 'custom', path: ['frames', index, 'address'], message: 'frame address must be unique and different from the primary Home' })
    }
    addresses.add(frame.address)
    if (frame.mode === 'lead') leads += 1
  })
  if (leads > 1) context.addIssue({ code: 'custom', path: ['frames'], message: 'only one lead Frame is allowed' })
  if (state.focusAddress !== undefined && !addresses.has(state.focusAddress)) {
    context.addIssue({ code: 'custom', path: ['focusAddress'], message: 'focus must name an active Frame' })
  }
})

export type AgentFrameState = Omit<z.infer<typeof AgentFrameStateSchema>, 'primaryHome' | 'frames' | 'focusAddress'> & {
  primaryHome: HomeAddress
  frames: AgentFrame[]
  focusAddress?: HomeAddress
}

export const HumanTurnProvenanceSchema = z.strictObject({
  sessionId: z.string().min(1),
  turn: z.number().int().nonnegative(),
  fromSeq: z.number().int().nonnegative(),
  userMessageSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  recipient: UserAddressSchema,
  authorityRef: z.string().min(1).max(500),
  summary: z.string().trim().min(1).max(160).regex(/^[^\r\n\u0000-\u001f]+$/u).optional(),
}).refine(value => value.fromSeq < value.userMessageSeq && value.userMessageSeq < value.toSeq,
  'human turn source sequence is invalid')
export type HumanTurnProvenance = z.infer<typeof HumanTurnProvenanceSchema> & { recipient: UserAddress }

export const InboxMessageSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  idempotencyKey: z.string().min(1).max(128),
  fromAddress: InboxSenderAddressSchema,
  returnToSessionId: z.string().min(1).optional(),
  /** Frozen from the sender so an automatic wake can run after host recovery. */
  wakeOptions: z.object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    maxTokens: z.number().int().positive().optional(),
  }).optional(),
  returnAddress: z.union([HomeAddressSchema, ProjectSeatAddressSchema]).optional(),
  projectId: z.string().min(1).max(128).optional(),
  to: z.array(InboxAddressSchema).min(1).max(8),
  cc: z.array(InboxAddressSchema).max(8),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(16000),
  kind: z.enum(['ordinary', 'project-progression', 'project-node-decision', 'project-outcome-rework', 'project-delivery-feedback', 'conclusion', 'escalation', 'work-request', 'work-result', 'work-notice',
    'turn-complete']),
  priority: z.enum(['normal', 'urgent']),
  due: z.string().min(1).optional(),
  contextRefs: z.array(z.string().min(1).max(500)).max(16),
  humanAction: HumanActionSchema.optional(),
  humanTurn: HumanTurnProvenanceSchema.optional(),
  projectProgression: z.strictObject({
    projectId: z.string().min(1), revision: z.number().int().positive(),
    lead: HomeAddressSchema,
  }).optional(),
  projectNodeDecision: z.strictObject({
    projectId: z.string().min(1), workId: z.string().min(1), lead: HomeAddressSchema,
  }).optional(),
  projectOutcomeRework: z.strictObject({
    projectId: z.string().min(1), claimId: z.string().min(1), lead: HomeAddressSchema,
  }).optional(),
  projectDeliveryFeedback: z.strictObject({
    projectId: z.string().min(1), feedbackId: z.string().min(1), lead: HomeAddressSchema,
  }).optional(),
  automaticEscalation: z.object({
    sourceMessageId: z.string().min(1),
    authorityRef: z.string().min(1).max(500),
  }).optional(),
  conclusionArtifact: z.string().min(1).max(500).optional(),
  replyTo: z.string().min(1).optional(),
  rootId: z.string().min(1),
  chain: z.number().int().min(0).max(7),
  topicId: z.string().min(1).optional(),
  hop: z.number().int().min(0).max(7).optional(),
  sentAt: z.string().min(1),
}).superRefine((message, context) => {
  const seats = [message.fromAddress, ...message.to, ...message.cc, message.returnAddress]
    .filter((address): address is string => address !== undefined && isProjectSeatAddress(address))
  if (seats.some(address => message.projectId === undefined
    || !address.startsWith(`seat:${message.projectId}:`))) {
    context.addIssue({ code: 'custom', path: ['projectId'], message: 'Inbox Seat addresses must belong to the recorded Project' })
  }
  if (message.humanTurn && (message.kind !== 'turn-complete'
    || message.to.length !== 1 || message.to[0] !== message.humanTurn.recipient
    || message.cc.length !== 0 || !message.humanAction?.href
    || message.priority !== 'normal' || message.contextRefs.length !== 0
    || message.due !== undefined || message.replyTo !== undefined
    || message.returnToSessionId !== message.humanTurn.sessionId
    || message.returnAddress !== message.fromAddress)) {
    context.addIssue({ code: 'custom', path: ['humanTurn'],
      message: 'human turn completion needs one recipient and its source Session' })
  }
  if (message.kind === 'turn-complete' && !message.humanTurn) {
    context.addIssue({ code: 'custom', path: ['humanTurn'],
      message: 'turn completion needs durable Session provenance' })
  }
  if (message.projectProgression && (message.kind !== 'project-progression'
    || message.fromAddress !== 'engine:inbox'
    || message.projectId !== message.projectProgression.projectId
    || message.id !== stableId('project-progression',
      `${message.projectProgression.projectId}:${message.projectProgression.revision}`)
    || message.to.length !== 1 || message.to[0] !== message.projectProgression.lead
    || message.cc.length !== 0 || message.priority !== 'urgent')) {
    context.addIssue({ code: 'custom', path: ['projectProgression'],
      message: 'Project progression notice must target its lead Home with stable provenance' })
  }
  if (message.kind === 'project-progression' && !message.projectProgression) {
    context.addIssue({ code: 'custom', path: ['projectProgression'],
      message: 'Project progression notice needs durable Project provenance' })
  }
  if (message.projectNodeDecision && (message.kind !== 'project-node-decision'
    || message.fromAddress !== 'engine:inbox'
    || message.projectId !== message.projectNodeDecision.projectId
    || message.id !== stableId('project-node-decision',
      `${message.projectNodeDecision.projectId}:${message.projectNodeDecision.workId}`)
    || message.to.length !== 1 || message.to[0] !== message.projectNodeDecision.lead
    || message.cc.length !== 0 || message.priority !== 'urgent')) {
    context.addIssue({ code: 'custom', path: ['projectNodeDecision'],
      message: 'Project node decision notice must target its lead Home with stable provenance' })
  }
  if (message.kind === 'project-node-decision' && !message.projectNodeDecision) {
    context.addIssue({ code: 'custom', path: ['projectNodeDecision'],
      message: 'Project node decision notice needs durable Project provenance' })
  }
  if (message.projectOutcomeRework && (message.kind !== 'project-outcome-rework'
    || message.fromAddress !== 'engine:inbox'
    || message.projectId !== message.projectOutcomeRework.projectId
    || message.id !== stableId('project-outcome-rework',
      `${message.projectOutcomeRework.projectId}:${message.projectOutcomeRework.claimId}`)
    || message.to.length !== 1 || message.to[0] !== message.projectOutcomeRework.lead
    || message.cc.length !== 0 || message.priority !== 'urgent')) {
    context.addIssue({ code: 'custom', path: ['projectOutcomeRework'],
      message: 'Project outcome rework notice must target its lead Home with stable provenance' })
  }
  if (message.kind === 'project-outcome-rework' && !message.projectOutcomeRework) {
    context.addIssue({ code: 'custom', path: ['projectOutcomeRework'],
      message: 'Project outcome rework notice needs durable Project provenance' })
  }
  if (message.projectDeliveryFeedback && (message.kind !== 'project-delivery-feedback'
    || message.fromAddress !== 'engine:inbox'
    || message.projectId !== message.projectDeliveryFeedback.projectId
    || message.id !== stableId('project-delivery-feedback',
      `${message.projectDeliveryFeedback.projectId}:${message.projectDeliveryFeedback.feedbackId}`)
    || message.to.length !== 1 || message.to[0] !== message.projectDeliveryFeedback.lead
    || message.cc.length !== 0 || message.priority !== 'urgent')) {
    context.addIssue({ code: 'custom', path: ['projectDeliveryFeedback'],
      message: 'Project delivery feedback notice must target its lead Home with stable provenance' })
  }
  if (message.kind === 'project-delivery-feedback' && !message.projectDeliveryFeedback) {
    context.addIssue({ code: 'custom', path: ['projectDeliveryFeedback'],
      message: 'Project delivery feedback notice needs durable Project provenance' })
  }
})

export type InboxMessage = Omit<z.infer<typeof InboxMessageSchema>, 'fromAddress' | 'to' | 'cc' | 'returnAddress'> & {
  fromAddress: InboxSenderAddress
  to: InboxAddress[]
  cc: InboxAddress[]
  returnAddress?: HomeAddress | ProjectSeatAddress
}

export function inboxShouldConverge(hop: number, topicCount: number): boolean {
  return hop >= 4 || topicCount >= 9
}

export const InboxWakeOriginSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  homeAddress: HomeAddressSchema,
  topicId: z.string().min(1),
  hop: z.number().int().min(0).max(6),
  wakePlanId: z.string().min(1),
  createdAt: z.string().min(1),
})

export type InboxWakeOrigin = Omit<z.infer<typeof InboxWakeOriginSchema>, 'homeAddress'> & {
  homeAddress: HomeAddress
}

export const InboxWakePlanSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  recipient: z.union([HomeAddressSchema, ProjectSeatAddressSchema]),
  messageIds: z.array(z.string().min(1)).min(1).max(20),
  sessionId: z.string().min(1),
  topicId: z.string().min(1),
  scope: z.enum(['topic', 'owner']).optional(),
  reason: z.enum(['initial', 'nudge-due', 'nudge-stale']).optional(),
  hop: z.number().int().min(0).max(6),
  workspace: z.string().min(1),
  dueAt: z.string().min(1),
  createdAt: z.string().min(1),
  dispatchedAt: z.string().min(1).optional(),
})

export type InboxWakePlan = Omit<z.infer<typeof InboxWakePlanSchema>, 'recipient'> & {
  recipient: HomeAddress | ProjectSeatAddress
}

export const InboxReturnRouteSchema = z.object({
  schemaVersion: z.literal(1),
  messageId: z.string().min(1),
  recipient: z.union([HomeAddressSchema, ProjectSeatAddressSchema]),
  sessionId: z.string().min(1),
  status: z.enum(['queued', 'fallback']),
  updatedAt: z.string().min(1),
  reason: z.string().min(1).optional(),
})

export type InboxReturnRoute = Omit<z.infer<typeof InboxReturnRouteSchema>, 'recipient'> & {
  recipient: HomeAddress | ProjectSeatAddress
}

export const InboxDeliverySchema = z.object({
  schemaVersion: z.literal(1),
  messageId: z.string().min(1),
  recipient: InboxAddressSchema,
  status: z.enum(['delivered', 'bounced']),
  reason: z.string().min(1).optional(),
  wakePolicy: z.enum(['immediate', 'batch', 'scheduled', 'carried']).optional(),
  wakeAt: z.string().min(1).optional(),
  nudgedAt: z.string().min(1).optional(),
  nudgeReason: z.enum(['due', 'stale']).optional(),
  handledAt: z.string().min(1).optional(),
  handledBySessionId: z.string().min(1).optional(),
  handledByUserId: z.string().min(1).optional(),
  updatedAt: z.string().min(1),
})

export type InboxDelivery = Omit<z.infer<typeof InboxDeliverySchema>, 'recipient'> & { recipient: InboxAddress }

export const HumanNotificationPreferenceSchema = z.strictObject({
  schemaVersion: z.literal(1), recipient: UserAddressSchema,
  enabled: z.boolean(), revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
})
export type HumanNotificationPreference = Omit<z.infer<typeof HumanNotificationPreferenceSchema>, 'recipient'> & {
  recipient: UserAddress
}

/** A push attempt is unknown before calling an external channel, so crashes cannot cause blind resend. */
export const InboxHumanNotificationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  messageId: z.string().min(1),
  recipient: UserAddressSchema,
  attempt: z.number().int().nonnegative().default(1),
  priorRejections: z.array(z.object({
    id: z.string().min(1),
    attemptedAt: z.string().min(1),
    resolvedAt: z.string().min(1),
    reason: z.string().min(1),
  })).default([]),
  status: z.enum(['unknown', 'sent', 'rejected', 'suppressed']),
  attemptedAt: z.string().min(1).optional(),
  suppressedAt: z.string().datetime().optional(),
  resolvedAt: z.string().min(1).optional(),
  providerReceipt: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
}).superRefine((notice, context) => {
  if (notice.status === 'suppressed') {
    if (notice.attempt !== 0 || notice.attemptedAt || !notice.suppressedAt
      || notice.resolvedAt !== notice.suppressedAt || !notice.reason?.trim()
      || notice.providerReceipt || notice.priorRejections.length > 0) {
      context.addIssue({ code: 'custom', message: 'suppressed notice cannot have an external attempt' })
    }
    return
  }
  if (notice.attempt < 1 || !notice.attemptedAt || notice.suppressedAt) {
    context.addIssue({ code: 'custom', message: 'channel notice needs an actual attempt' })
  }
  if (notice.status === 'sent' && !notice.providerReceipt) {
    context.addIssue({ code: 'custom', path: ['providerReceipt'], message: 'sent requires a provider receipt' })
  }
  if (notice.status === 'rejected' && !notice.reason) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'rejected requires a reason' })
  }
})
export type InboxHumanNotification = Omit<z.infer<typeof InboxHumanNotificationSchema>, 'recipient'> & {
  recipient: UserAddress
}

export const MemoryProposalSchema = z.object({
  id: z.string().min(1),
  fromAddress: HomeAddressSchema,
  toAddress: HomeAddressSchema,
  proposedKind: z.enum(ASSET_KINDS),
  description: z.string().min(1).max(1000),
  body: z.string().min(1),
  tags: z.array(z.string().min(1).max(80)).default([]),
  sourceRefs: z.array(EvidenceRefSchema).min(1),
  status: z.enum(['pending', 'accepted', 'rejected', 'withdrawn']),
  baseAsset: z.object({ id: z.string().min(1), revision: z.number().int().positive(),
    bodySha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  targetAssetId: z.string().min(1).optional(),
  appliedAssetRevision: z.number().int().positive().optional(),
  appliedBodySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  humanReview: z.object({
    reviewerId: z.string().trim().min(1),
    authorityRef: z.string().trim().min(1),
    action: z.enum(['accept', 'reject']),
    decision: z.string().trim().min(1),
    reviewedAt: z.string().min(1),
  }).optional(),
  decision: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  decidedAt: z.string().min(1).optional(),
}).superRefine((proposal, context) => {
  if ((proposal.appliedAssetRevision === undefined) !== (proposal.appliedBodySha256 === undefined)) {
    context.addIssue({ code: 'custom', message: 'proposal application revision and digest must appear together' })
  }
  if (proposal.baseAsset && proposal.status === 'accepted'
    && (proposal.targetAssetId !== proposal.baseAsset.id || proposal.appliedAssetRevision === undefined)) {
    context.addIssue({ code: 'custom', message: 'accepted replacement proposal needs a matching applied asset' })
  }
  if (proposal.humanReview && proposal.status === 'pending' && proposal.humanReview.action !== 'accept') {
    context.addIssue({ code: 'custom', message: 'pending proposal can only reserve human acceptance' })
  }
  if (proposal.humanReview && proposal.status !== 'pending'
    && ((proposal.status === 'accepted' ? 'accept' : 'reject') !== proposal.humanReview.action
      || proposal.decision !== proposal.humanReview.decision
      || proposal.decidedAt !== proposal.humanReview.reviewedAt)) {
    context.addIssue({ code: 'custom', message: 'proposal decision must match its human review' })
  }
})

export type MemoryProposal = z.infer<typeof MemoryProposalSchema> & {
  fromAddress: HomeAddress
  toAddress: HomeAddress
}

export const FITNESS_SIGNALS = ['retrieved', 'applied', 'confirmed', 'contradicted', 'failed'] as const
export type FitnessSignal = typeof FITNESS_SIGNALS[number]

export const FitnessReceiptSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  ownerAddress: HomeAddressSchema,
  sessionId: z.string().min(1),
  eventSeq: z.number().int().nonnegative().optional(),
  assetRevision: z.number().int().positive().optional(),
  assetBodySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  signal: z.enum(FITNESS_SIGNALS),
  outcome: z.string().min(1).optional(),
  createdAt: z.string().min(1),
}).superRefine((receipt, context) => {
  if ((receipt.assetRevision === undefined) !== (receipt.assetBodySha256 === undefined)) {
    context.addIssue({ code: 'custom', path: ['assetBodySha256'],
      message: 'fitness receipt asset version and body digest must appear together' })
  }
})

export type FitnessReceipt = z.infer<typeof FitnessReceiptSchema> & { ownerAddress: HomeAddress }

export const LEARNING_CHECKPOINT_STATUSES = ['pending', 'remembered', 'skipped', 'failed'] as const
export type LearningCheckpointStatus = typeof LEARNING_CHECKPOINT_STATUSES[number]

export const LearningCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  turn: z.number().int().nonnegative(),
  homeAddress: HomeAddressSchema,
  reason: z.literal('explicit-correction'),
  status: z.enum(LEARNING_CHECKPOINT_STATUSES),
  evidenceRef: EvidenceRefSchema,
  excerpt: z.string().min(1).max(4000),
  assetId: z.string().min(1).optional(),
  decision: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  settledAt: z.string().min(1).optional(),
})

export type LearningCheckpoint = z.infer<typeof LearningCheckpointSchema> & { homeAddress: HomeAddress }

export interface ContextBudget {
  identityMaxBytes: number
  indexMaxBytes: number
}

export function parseHomeAddress(value: string): HomeAddress {
  return HomeAddressSchema.parse(value) as HomeAddress
}

export function parseInboxAddress(value: string): InboxAddress {
  return InboxAddressSchema.parse(value) as InboxAddress
}

export function isUserAddress(value: string): value is UserAddress {
  return UserAddressSchema.safeParse(value).success
}

export function isHomeAddress(value: string): value is HomeAddress {
  return HomeAddressSchema.safeParse(value).success
}

export function isProjectSeatAddress(value: string): value is ProjectSeatAddress {
  return ProjectSeatAddressSchema.safeParse(value).success
}

export function parseUserAddress(value: string): UserAddress {
  return UserAddressSchema.parse(value) as UserAddress
}

export function homeTypeOf(address: HomeAddress): HomeType {
  return address.slice(0, address.indexOf(':')) as HomeType
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`
}

export function safeHomeId(address: HomeAddress): string {
  const readable = address
    .toLowerCase()
    .replace(':', '--')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return `${readable}-${createHash('sha256').update(address).digest('hex').slice(0, 8)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}
