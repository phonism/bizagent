import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { SharedKnowledgeProposalSchema, type SharedKnowledgeProposal } from './shared-knowledge.js'
import {
  AgentFrameStateSchema,
  InboxDeliverySchema,
  InboxHumanNotificationSchema,
  HumanNotificationPreferenceSchema,
  InboxMessageSchema,
  InboxWakeOriginSchema,
  InboxWakePlanSchema,
  InboxReturnRouteSchema,
  FitnessReceiptSchema,
  LearningCheckpointSchema,
  LearningMaterialObservationSchema,
  LearningMaterialReviewSchema,
  LearningBatchRunSchema,
  LearningLaunchSchema,
  LearningScheduleCursorSchema,
  LearningSchedulePolicySchema,
  MemoryProposalSchema,
  ProjectTurnParticipationSchema,
  SessionBindingSchema,
  type AgentFrameState,
  type InboxDelivery,
  type InboxHumanNotification,
  type HumanNotificationPreference,
  type UserAddress,
  type InboxMessage,
  type InboxWakeOrigin,
  type InboxWakePlan,
  type InboxReturnRoute,
  type FitnessReceipt,
  type LearningCheckpoint,
  type LearningMaterialObservation,
  type LearningMaterialReview,
  type LearningBatchRun,
  type LearningLaunch,
  type LearningScheduleCursor,
  type LearningSchedulePolicy,
  type MemoryProposal,
  type ProjectTurnParticipation,
  type SessionBinding,
  isUserAddress,
  UserAddressSchema,
  nowIso,
  stableId,
} from './domain.js'

export const BIZAGENT_DOMAIN = defineDomain({
  name: 'bizagent_learning',
  version: 0,
  tables: {
    bindings: domainTable<string, z.infer<typeof SessionBindingSchema>>(SessionBindingSchema),
    proposals: domainTable<string, z.infer<typeof MemoryProposalSchema>>(MemoryProposalSchema),
    receipts: domainTable<string, z.infer<typeof FitnessReceiptSchema>>(FitnessReceiptSchema),
    metadata: domainTable<string, { key: string; value: string; updatedAt: string }>(z.object({
      key: z.string().min(1),
      value: z.string(),
      updatedAt: z.string().min(1),
    })),
  },
})

type BizAgentDomain = Domain<typeof BIZAGENT_DOMAIN>
const CHECKPOINT_PREFIX = 'learning-checkpoint:'
const MATERIAL_OBSERVATION_PREFIX = 'learning-material-observation:'
const MATERIAL_REVIEW_PREFIX = 'learning-material-review:'
const LEARNING_BATCH_PREFIX = 'learning-batch:'
const LEARNING_LAUNCH_PREFIX = 'learning-launch:'
const LEARNING_SCHEDULE_PREFIX = 'learning-schedule:'
const LEARNING_POLICY_PREFIX = 'learning-policy:'
const FRAME_STATE_PREFIX = 'agent-frame-state:'
const INBOX_MESSAGE_PREFIX = 'inbox-message:'
const INBOX_DELIVERY_PREFIX = 'inbox-delivery:'
const INBOX_WAKE_ORIGIN_PREFIX = 'inbox-wake-origin:'
const INBOX_WAKE_PLAN_PREFIX = 'inbox-wake-plan:'
const INBOX_RETURN_ROUTE_PREFIX = 'inbox-return-route:'
const INBOX_HUMAN_NOTIFICATION_PREFIX = 'inbox-human-notification:'
const HUMAN_NOTIFICATION_PREFERENCE_PREFIX = 'human-notification-preference:'
const PROJECT_TURN_PREFIX = 'project-turn:'
const SHARED_KNOWLEDGE_PROPOSAL_PREFIX = 'shared-knowledge-proposal:'

export class LearningLedger {
  private receiptTail: Promise<unknown> = Promise.resolve()
  private learningBatchTail: Promise<unknown> = Promise.resolve()
  private readonly materialReviewWrites = new Map<string, Promise<LearningMaterialReview>>()
  private readonly frameMutationTail = new Map<string, Promise<AgentFrameState>>()
  private inboxMutationTail: Promise<unknown> = Promise.resolve()
  private projectTurnTail: Promise<unknown> = Promise.resolve()
  private proposalTail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly domain: BizAgentDomain) {}

  static async open(facility: DomainFacility): Promise<LearningLedger> {
    return new LearningLedger(await facility.open(BIZAGENT_DOMAIN))
  }

  getBinding(sessionId: string): SessionBinding | undefined {
    return this.domain.table('bindings').get(sessionId) as SessionBinding | undefined
  }

  async putBinding(binding: SessionBinding): Promise<void> {
    const existing = this.getBinding(binding.sessionId)
    if (existing !== undefined && existing.homeAddress !== binding.homeAddress) {
      throw new Error(
        `session ${binding.sessionId} is already bound to ${existing.homeAddress}; cannot rebind to ${binding.homeAddress}`,
      )
    }
    await this.domain.table('bindings').put(binding.sessionId, SessionBindingSchema.parse(binding))
  }

  /** Roll back a pre-creation reservation only after the host has verified that no Session materialized. */
  async removeUnmaterializedBinding(binding: SessionBinding): Promise<boolean> {
    const current = this.getBinding(binding.sessionId)
    if (current?.homeAddress !== binding.homeAddress || current.cwd !== binding.cwd
      || current.boundAt !== binding.boundAt) return false
    return this.domain.table('bindings').delete(binding.sessionId)
  }

  listBindings(homeAddress?: string): SessionBinding[] {
    return [...this.domain.table('bindings').entries()]
      .map(([, binding]) => binding as SessionBinding)
      .filter(binding => homeAddress === undefined || binding.homeAddress === homeAddress)
      .sort((a, b) => a.boundAt.localeCompare(b.boundAt))
  }

  listProjectTurns(projectId?: string): ProjectTurnParticipation[] {
    return [...this.domain.table('metadata').entries()]
      .filter(([key]) => key.startsWith(PROJECT_TURN_PREFIX))
      .map(([, record]) => ProjectTurnParticipationSchema.parse(JSON.parse(record.value)) as ProjectTurnParticipation)
      .filter(item => projectId === undefined || item.projectId === projectId)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)
        || a.sessionId.localeCompare(b.sessionId) || a.turn - b.turn)
  }

  async putProjectTurn(input: Omit<ProjectTurnParticipation, 'schemaVersion' | 'recordedAt'>):
    Promise<ProjectTurnParticipation> {
    const task = this.projectTurnTail.catch(() => undefined).then(async () => {
      const key = `${PROJECT_TURN_PREFIX}${stableId('project-turn', JSON.stringify([
        input.projectId, input.sessionId, input.turn,
      ]))}`
      const previous = this.domain.table('metadata').get(key)
      if (previous !== undefined) {
        const existing = ProjectTurnParticipationSchema.parse(JSON.parse(previous.value)) as ProjectTurnParticipation
        if (existing.projectId !== input.projectId || existing.sessionId !== input.sessionId
          || existing.turn !== input.turn || existing.homeAddress !== input.homeAddress) {
          throw new Error('Project turn participation conflicts with its prior binding')
        }
        return existing
      }
      const binding = this.getBinding(input.sessionId)
      if (binding?.homeAddress !== input.homeAddress) {
        throw new Error('Project turn requires a durable matching Home Session binding')
      }
      const participation = ProjectTurnParticipationSchema.parse({
        schemaVersion: 1, ...input, recordedAt: nowIso(),
      }) as ProjectTurnParticipation
      await this.domain.table('metadata').put(key, {
        key, value: JSON.stringify(participation), updatedAt: participation.recordedAt,
      })
      return participation
    })
    this.projectTurnTail = task
    return task
  }

  getFrameState(sessionId: string): AgentFrameState | undefined {
    const record = this.domain.table('metadata').get(`${FRAME_STATE_PREFIX}${sessionId}`)
    return record === undefined
      ? undefined
      : AgentFrameStateSchema.parse(JSON.parse(record.value)) as AgentFrameState
  }

  async updateFrameState(
    sessionId: string,
    update: (current: AgentFrameState | undefined) => AgentFrameState,
  ): Promise<AgentFrameState> {
    const previous = this.frameMutationTail.get(sessionId)
    const task = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
      const state = AgentFrameStateSchema.parse(update(this.getFrameState(sessionId))) as AgentFrameState
      if (state.sessionId !== sessionId) throw new Error('Frame state Session mismatch')
      const key = `${FRAME_STATE_PREFIX}${sessionId}`
      await this.domain.table('metadata').put(key, {
        key,
        value: JSON.stringify(state),
        updatedAt: state.updatedAt,
      })
      return state
    })
    this.frameMutationTail.set(sessionId, task)
    try {
      return await task
    } finally {
      if (this.frameMutationTail.get(sessionId) === task) this.frameMutationTail.delete(sessionId)
    }
  }

  async withInboxWrite<T>(update: () => Promise<T>): Promise<T> {
    const task = this.inboxMutationTail.catch(() => undefined).then(update)
    this.inboxMutationTail = task
    return task
  }

  getInboxMessage(id: string): InboxMessage | undefined {
    const record = this.domain.table('metadata').get(`${INBOX_MESSAGE_PREFIX}${id}`)
    return record === undefined ? undefined
      : InboxMessageSchema.parse(JSON.parse(record.value)) as InboxMessage
  }

  listInboxMessages(): InboxMessage[] {
    return [...this.domain.table('metadata').entries()]
      .filter(([key]) => key.startsWith(INBOX_MESSAGE_PREFIX))
      .map(([, record]) => InboxMessageSchema.parse(JSON.parse(record.value)) as InboxMessage)
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt) || b.id.localeCompare(a.id))
  }

  async putInboxMessage(message: InboxMessage): Promise<void> {
    const parsed = InboxMessageSchema.parse(message) as InboxMessage
    const key = `${INBOX_MESSAGE_PREFIX}${parsed.id}`
    if (this.getInboxMessage(parsed.id) !== undefined) throw new Error(`Inbox message already exists: ${parsed.id}`)
    await this.domain.table('metadata').put(key, {
      key, value: JSON.stringify(parsed), updatedAt: parsed.sentAt,
    })
  }

  getInboxDelivery(messageId: string, recipient: string): InboxDelivery | undefined {
    const record = this.domain.table('metadata').get(`${INBOX_DELIVERY_PREFIX}${messageId}:${recipient}`)
    return record === undefined ? undefined
      : InboxDeliverySchema.parse(JSON.parse(record.value)) as InboxDelivery
  }

  async putInboxDelivery(delivery: InboxDelivery): Promise<void> {
    const parsed = InboxDeliverySchema.parse(delivery) as InboxDelivery
    const key = `${INBOX_DELIVERY_PREFIX}${parsed.messageId}:${parsed.recipient}`
    await this.domain.table('metadata').put(key, {
      key, value: JSON.stringify(parsed), updatedAt: parsed.updatedAt,
    })
  }

  getInboxHumanNotification(messageId: string, recipient: string): InboxHumanNotification | undefined {
    const record = this.domain.table('metadata').get(`${INBOX_HUMAN_NOTIFICATION_PREFIX}${messageId}:${recipient}`)
    return record === undefined ? undefined
      : InboxHumanNotificationSchema.parse(JSON.parse(record.value)) as InboxHumanNotification
  }

  getHumanNotificationPreference(recipient: string): HumanNotificationPreference | undefined {
    const record = this.domain.table('metadata').get(`${HUMAN_NOTIFICATION_PREFERENCE_PREFIX}${recipient}`)
    return record === undefined ? undefined
      : HumanNotificationPreferenceSchema.parse(JSON.parse(record.value)) as HumanNotificationPreference
  }

  async setHumanNotificationPreference(recipient: string, enabled: boolean,
    expectedRevision: number): Promise<HumanNotificationPreference> {
    const address = UserAddressSchema.parse(recipient) as HumanNotificationPreference['recipient']
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('human notification preference revision is invalid')
    }
    return this.withInboxWrite(async () => {
      const prior = this.getHumanNotificationPreference(address)
      if ((prior?.revision ?? 0) !== expectedRevision) {
        throw new Error('human notification preference changed before update')
      }
      const updatedAt = nowIso()
      const preference = HumanNotificationPreferenceSchema.parse({ schemaVersion: 1,
        recipient: address, enabled, revision: expectedRevision + 1, updatedAt }) as HumanNotificationPreference
      const key = `${HUMAN_NOTIFICATION_PREFERENCE_PREFIX}${address}`
      await this.domain.table('metadata').put(key, {
        key, value: JSON.stringify(preference), updatedAt,
      })
      return preference
    })
  }

  /** The external provider was never called; this terminal record survives later opt-in. */
  async suppressInboxHumanNotification(messageId: string, recipient: string,
    reason: string): Promise<InboxHumanNotification> {
    const address = UserAddressSchema.parse(recipient) as HumanNotificationPreference['recipient']
    if (!reason.trim() || reason.length > 500) throw new Error('human notification suppression needs a reason')
    return this.withInboxWrite(async () => {
      const prior = this.getInboxHumanNotification(messageId, address)
      if (prior) {
        if (prior.status !== 'suppressed' || prior.reason !== reason) {
          throw new Error('human notification already has a channel outcome')
        }
        return prior
      }
      const message = this.getInboxMessage(messageId)
      const delivery = this.getInboxDelivery(messageId, address)
      if (!message || ![...message.to, ...message.cc].includes(address)
        || delivery?.status !== 'delivered' || delivery.handledAt !== undefined) {
        throw new Error('human notification source is not pending in the recipient inbox')
      }
      return this.putSuppressedHumanNotification(messageId, address, reason)
    })
  }

  private async putSuppressedHumanNotification(messageId: string, recipient: UserAddress,
    reason: string): Promise<InboxHumanNotification> {
    const suppressedAt = nowIso()
    const notification = InboxHumanNotificationSchema.parse({ schemaVersion: 1,
      id: stableId('inbox-human-suppressed', `${messageId}:${recipient}`),
      messageId, recipient, attempt: 0, status: 'suppressed',
      suppressedAt, resolvedAt: suppressedAt, reason,
    }) as InboxHumanNotification
    const key = `${INBOX_HUMAN_NOTIFICATION_PREFIX}${messageId}:${recipient}`
    await this.domain.table('metadata').put(key, {
      key, value: JSON.stringify(notification), updatedAt: suppressedAt,
    })
    return notification
  }

  /** Persist an opt-out while holding the same lock as preference updates and channel reservations. */
  async suppressInboxHumanNotificationIfOptedOut(messageId: string,
    recipient: UserAddress): Promise<InboxHumanNotification | undefined> {
    return this.withInboxWrite(async () => {
      if (this.getHumanNotificationPreference(recipient)?.enabled !== false) return undefined
      const existing = this.getInboxHumanNotification(messageId, recipient)
      if (existing) return existing.status === 'suppressed' ? existing : undefined
      const message = this.getInboxMessage(messageId)
      const delivery = this.getInboxDelivery(messageId, recipient)
      if (!message || ![...message.to, ...message.cc].includes(recipient)
        || delivery?.status !== 'delivered' || delivery.handledAt !== undefined) {
        throw new Error('human notification source is not pending in the recipient inbox')
      }
      return this.putSuppressedHumanNotification(messageId, recipient, 'recipient-opted-out')
    })
  }

  /** Reserve before calling the channel; a crash leaves unknown and never causes an automatic resend. */
  async reserveInboxHumanNotification(messageId: string, recipient: string): Promise<{
    notification: InboxHumanNotification; reserved: boolean
  }> {
    if (!isUserAddress(recipient)) throw new Error('human notification requires a user recipient')
    return this.withInboxWrite(async () => {
      const existing = this.getInboxHumanNotification(messageId, recipient)
      if (existing !== undefined) return { notification: existing, reserved: false }
      const message = this.getInboxMessage(messageId)
      const delivery = this.getInboxDelivery(messageId, recipient)
      if (message === undefined || ![...message.to, ...message.cc].includes(recipient)
        || delivery?.status !== 'delivered' || delivery.handledAt !== undefined) {
        throw new Error('human notification source is not pending in the recipient inbox')
      }
      if (this.getHumanNotificationPreference(recipient)?.enabled === false) {
        return { notification: await this.putSuppressedHumanNotification(messageId,
          recipient as UserAddress, 'recipient-opted-out'), reserved: false }
      }
      const attemptedAt = nowIso()
      const notification = InboxHumanNotificationSchema.parse({
        schemaVersion: 1, id: stableId('inbox-human-notice', `${messageId}:${recipient}`),
        messageId, recipient, status: 'unknown', attemptedAt,
      }) as InboxHumanNotification
      const key = `${INBOX_HUMAN_NOTIFICATION_PREFIX}${messageId}:${recipient}`
      await this.domain.table('metadata').put(key, {
        key, value: JSON.stringify(notification), updatedAt: attemptedAt,
      })
      return { notification, reserved: true }
    })
  }

  async settleInboxHumanNotification(messageId: string, recipient: string,
    outcome: { status: 'sent'; providerReceipt: string } | { status: 'rejected'; reason: string }): Promise<InboxHumanNotification> {
    return this.withInboxWrite(async () => {
      const prior = this.getInboxHumanNotification(messageId, recipient)
      if (prior === undefined) throw new Error('human notification was not reserved')
      if (prior.status !== 'unknown') {
        if (prior.status !== outcome.status
          || (outcome.status === 'sent' && prior.providerReceipt !== outcome.providerReceipt)
          || (outcome.status === 'rejected' && prior.reason !== outcome.reason)) {
          throw new Error('human notification is already settled differently')
        }
        return prior
      }
      const resolvedAt = nowIso()
      const notification = InboxHumanNotificationSchema.parse({
        ...prior, ...outcome, resolvedAt,
      }) as InboxHumanNotification
      const key = `${INBOX_HUMAN_NOTIFICATION_PREFIX}${messageId}:${recipient}`
      await this.domain.table('metadata').put(key, {
        key, value: JSON.stringify(notification), updatedAt: resolvedAt,
      })
      return notification
    })
  }

  /** A definite rejection permits one explicit new attempt; unknown and sent never do. */
  async retryRejectedInboxHumanNotification(messageId: string, recipient: string): Promise<InboxHumanNotification> {
    return this.withInboxWrite(async () => {
      const prior = this.getInboxHumanNotification(messageId, recipient)
      const delivery = this.getInboxDelivery(messageId, recipient)
      if (prior?.status !== 'rejected' || prior.resolvedAt === undefined || prior.reason === undefined
        || delivery?.status !== 'delivered' || delivery.handledAt !== undefined) {
        throw new Error('human notification is not a pending, definitely rejected recipient')
      }
      if (this.getHumanNotificationPreference(recipient)?.enabled === false) {
        throw new Error('human notification recipient has opted out')
      }
      const attemptedAt = nowIso()
      const notification = InboxHumanNotificationSchema.parse({
        schemaVersion: 1, id: stableId('inbox-human-notice', `${messageId}:${recipient}:${prior.attempt + 1}`),
        messageId, recipient, attempt: prior.attempt + 1,
        priorRejections: [...prior.priorRejections, {
          id: prior.id, attemptedAt: prior.attemptedAt!,
          resolvedAt: prior.resolvedAt, reason: prior.reason,
        }],
        status: 'unknown', attemptedAt,
      }) as InboxHumanNotification
      const key = `${INBOX_HUMAN_NOTIFICATION_PREFIX}${messageId}:${recipient}`
      await this.domain.table('metadata').put(key, {
        key, value: JSON.stringify(notification), updatedAt: attemptedAt,
      })
      return notification
    })
  }

  getInboxWakeOrigin(sessionId: string): InboxWakeOrigin | undefined {
    const record = this.domain.table('metadata').get(`${INBOX_WAKE_ORIGIN_PREFIX}${sessionId}`)
    return record === undefined ? undefined
      : InboxWakeOriginSchema.parse(JSON.parse(record.value)) as InboxWakeOrigin
  }

  async putInboxWakeOrigin(origin: InboxWakeOrigin): Promise<InboxWakeOrigin> {
    const parsed = InboxWakeOriginSchema.parse(origin) as InboxWakeOrigin
    return this.withInboxWrite(async () => {
      const existing = this.getInboxWakeOrigin(parsed.sessionId)
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
          throw new Error('Inbox wake Session already has another origin')
        }
        return existing
      }
      const key = `${INBOX_WAKE_ORIGIN_PREFIX}${parsed.sessionId}`
      await this.domain.table('metadata').put(key, {
        key, value: JSON.stringify(parsed), updatedAt: parsed.createdAt,
      })
      return parsed
    })
  }

  getInboxWakePlan(id: string): InboxWakePlan | undefined {
    const record = this.domain.table('metadata').get(`${INBOX_WAKE_PLAN_PREFIX}${id}`)
    return record === undefined ? undefined
      : InboxWakePlanSchema.parse(JSON.parse(record.value)) as InboxWakePlan
  }

  listInboxWakePlans(): InboxWakePlan[] {
    return [...this.domain.table('metadata').entries()]
      .filter(([key]) => key.startsWith(INBOX_WAKE_PLAN_PREFIX))
      .map(([, record]) => InboxWakePlanSchema.parse(JSON.parse(record.value)) as InboxWakePlan)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  /** Caller holds withInboxWrite so plan selection and reservation share one local writer. */
  async putInboxWakePlan(plan: InboxWakePlan): Promise<InboxWakePlan> {
    const parsed = InboxWakePlanSchema.parse(plan) as InboxWakePlan
    const existing = this.getInboxWakePlan(parsed.id)
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(parsed)) throw new Error('Inbox wake plan ID conflicts')
      return existing
    }
    const key = `${INBOX_WAKE_PLAN_PREFIX}${parsed.id}`
    await this.domain.table('metadata').put(key, {
      key, value: JSON.stringify(parsed), updatedAt: parsed.createdAt,
    })
    return parsed
  }

  async markInboxWakeDispatched(id: string, dispatchedAt: string): Promise<InboxWakePlan> {
    return this.withInboxWrite(async () => {
      const plan = this.getInboxWakePlan(id)
      if (plan === undefined) throw new Error(`Inbox wake plan not found: ${id}`)
      if (plan.dispatchedAt !== undefined) return plan
      const updated = InboxWakePlanSchema.parse({ ...plan, dispatchedAt }) as InboxWakePlan
      const key = `${INBOX_WAKE_PLAN_PREFIX}${id}`
      await this.domain.table('metadata').put(key, {
        key, value: JSON.stringify(updated), updatedAt: dispatchedAt,
      })
      return updated
    })
  }

  getInboxReturnRoute(messageId: string, recipient: string): InboxReturnRoute | undefined {
    const record = this.domain.table('metadata').get(`${INBOX_RETURN_ROUTE_PREFIX}${messageId}:${recipient}`)
    return record === undefined ? undefined
      : InboxReturnRouteSchema.parse(JSON.parse(record.value)) as InboxReturnRoute
  }

  async putInboxReturnRoute(route: InboxReturnRoute): Promise<InboxReturnRoute> {
    const parsed = InboxReturnRouteSchema.parse(route) as InboxReturnRoute
    return this.withInboxWrite(async () => {
      const existing = this.getInboxReturnRoute(parsed.messageId, parsed.recipient)
      if (existing !== undefined) {
        if (existing.sessionId !== parsed.sessionId) throw new Error('Inbox return route Session changed')
        if (existing.status === 'fallback' || existing.status === parsed.status) return existing
      }
      const key = `${INBOX_RETURN_ROUTE_PREFIX}${parsed.messageId}:${parsed.recipient}`
      await this.domain.table('metadata').put(key, {
        key, value: JSON.stringify(parsed), updatedAt: parsed.updatedAt,
      })
      return parsed
    })
  }

  getMaterialObservation(id: string): LearningMaterialObservation | undefined {
    const record = this.domain.table('metadata').get(`${MATERIAL_OBSERVATION_PREFIX}${id}`)
    return record === undefined
      ? undefined
      : LearningMaterialObservationSchema.parse(JSON.parse(record.value)) as LearningMaterialObservation
  }

  async putMaterialObservation(observation: LearningMaterialObservation): Promise<LearningMaterialObservation> {
    const parsed = LearningMaterialObservationSchema.parse(observation) as LearningMaterialObservation
    const existing = this.getMaterialObservation(parsed.id)
    if (existing !== undefined) {
      if (existing.homeAddress !== parsed.homeAddress || existing.sessionId !== parsed.sessionId
        || existing.fingerprint !== parsed.fingerprint || existing.sourceKind !== parsed.sourceKind
        || existing.worklogRevisionId !== parsed.worklogRevisionId
        || existing.worklogRevision !== parsed.worklogRevision) {
        throw new Error(`learning material observation ${parsed.id} conflicts with an existing source`)
      }
      return existing
    }
    const key = `${MATERIAL_OBSERVATION_PREFIX}${parsed.id}`
    await this.domain.table('metadata').put(key, {
      key,
      value: JSON.stringify(parsed),
      updatedAt: parsed.observedAt,
    })
    return parsed
  }

  getMaterialReview(materialId: string): LearningMaterialReview | undefined {
    const record = this.domain.table('metadata').get(`${MATERIAL_REVIEW_PREFIX}${materialId}`)
    return record === undefined
      ? undefined
      : LearningMaterialReviewSchema.parse(JSON.parse(record.value)) as LearningMaterialReview
  }

  async putMaterialReview(review: LearningMaterialReview): Promise<LearningMaterialReview> {
    const parsed = LearningMaterialReviewSchema.parse(review) as LearningMaterialReview
    const pending = this.materialReviewWrites.get(parsed.materialId)
    if (pending !== undefined) return pending
    const write = (async () => {
      const existing = this.getMaterialReview(parsed.materialId)
      if (existing !== undefined) return existing
      const key = `${MATERIAL_REVIEW_PREFIX}${parsed.materialId}`
      await this.domain.table('metadata').put(key, {
        key,
        value: JSON.stringify(parsed),
        updatedAt: parsed.reviewedAt,
      })
      return parsed
    })()
    this.materialReviewWrites.set(parsed.materialId, write)
    try {
      return await write
    } finally {
      this.materialReviewWrites.delete(parsed.materialId)
    }
  }

  async withLearningBatchWrite<T>(update: () => Promise<T>): Promise<T> {
    const task = this.learningBatchTail.catch(() => undefined).then(update)
    this.learningBatchTail = task.then(() => undefined, () => undefined)
    return task
  }

  getLearningBatch(id: string): LearningBatchRun | undefined {
    const record = this.domain.table('metadata').get(`${LEARNING_BATCH_PREFIX}${id}`)
    return record === undefined ? undefined
      : LearningBatchRunSchema.parse(JSON.parse(record.value)) as LearningBatchRun
  }

  listLearningBatches(homeAddress: string): LearningBatchRun[] {
    return [...this.domain.table('metadata').entries()]
      .filter(([key]) => key.startsWith(LEARNING_BATCH_PREFIX))
      .map(([, record]) => LearningBatchRunSchema.parse(JSON.parse(record.value)) as LearningBatchRun)
      .filter(run => run.homeAddress === homeAddress)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }

  async putLearningBatch(run: LearningBatchRun): Promise<LearningBatchRun> {
    const parsed = LearningBatchRunSchema.parse(run) as LearningBatchRun
    const previous = this.getLearningBatch(parsed.id)
    if (previous !== undefined) {
      if (previous.homeAddress !== parsed.homeAddress || previous.reviewerSessionId !== parsed.reviewerSessionId
        || JSON.stringify(previous.materialIds) !== JSON.stringify(parsed.materialIds)
        || previous.status !== 'open' || parsed.status === 'open') {
        throw new Error(`learning batch ${parsed.id} cannot be replaced`)
      }
    }
    const key = `${LEARNING_BATCH_PREFIX}${parsed.id}`
    await this.domain.table('metadata').put(key, {
      key, value: JSON.stringify(parsed), updatedAt: parsed.updatedAt,
    })
    return parsed
  }

  getLearningLaunch(id: string): LearningLaunch | undefined {
    const record = this.domain.table('metadata').get(`${LEARNING_LAUNCH_PREFIX}${id}`)
    return record === undefined ? undefined
      : LearningLaunchSchema.parse(JSON.parse(record.value)) as LearningLaunch
  }

  listLearningLaunches(homeAddress?: string): LearningLaunch[] {
    return [...this.domain.table('metadata').entries()]
      .filter(([key]) => key.startsWith(LEARNING_LAUNCH_PREFIX))
      .map(([, record]) => LearningLaunchSchema.parse(JSON.parse(record.value)) as LearningLaunch)
      .filter(item => homeAddress === undefined || item.homeAddress === homeAddress)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }

  async putLearningLaunch(launch: LearningLaunch): Promise<LearningLaunch> {
    const parsed = LearningLaunchSchema.parse(launch) as LearningLaunch
    const prior = this.getLearningLaunch(parsed.id)
    if (prior !== undefined && (prior.homeAddress !== parsed.homeAddress
      || prior.requestedBySessionId !== parsed.requestedBySessionId
      || prior.workerSessionId !== parsed.workerSessionId
      || prior.workspace !== parsed.workspace
      || prior.promptMessageId !== parsed.promptMessageId
      || prior.provider !== parsed.provider || prior.model !== parsed.model
      || prior.maxTokens !== parsed.maxTokens || prior.trigger !== parsed.trigger
      || prior.scheduledFor !== parsed.scheduledFor)) {
      throw new Error(`learning launch ${parsed.id} immutable fields changed`)
    }
    if (prior !== undefined && !({
      reserved: ['reserved', 'active', 'needs_review', 'completed'],
      active: ['active', 'completed', 'needs_review'],
      completed: ['completed'],
      needs_review: ['needs_review', 'abandoned', 'completed'],
      abandoned: ['abandoned'],
    } as Record<LearningLaunch['status'], LearningLaunch['status'][]>)[prior.status].includes(parsed.status)) {
      throw new Error(`learning launch ${parsed.id} cannot move from ${prior.status} to ${parsed.status}`)
    }
    const key = `${LEARNING_LAUNCH_PREFIX}${parsed.id}`
    await this.domain.table('metadata').put(key, {
      key, value: JSON.stringify(parsed), updatedAt: parsed.updatedAt,
    })
    return parsed
  }

  getLearningScheduleCursor(homeAddress: string): LearningScheduleCursor | undefined {
    const record = this.domain.table('metadata').get(`${LEARNING_SCHEDULE_PREFIX}${homeAddress}`)
    return record === undefined ? undefined
      : LearningScheduleCursorSchema.parse(JSON.parse(record.value)) as LearningScheduleCursor
  }

  async putLearningScheduleCursor(cursor: LearningScheduleCursor): Promise<LearningScheduleCursor> {
    const parsed = LearningScheduleCursorSchema.parse(cursor) as LearningScheduleCursor
    const key = `${LEARNING_SCHEDULE_PREFIX}${parsed.homeAddress}`
    const previous = this.getLearningScheduleCursor(parsed.homeAddress)
    if (previous?.scheduleFingerprint === parsed.scheduleFingerprint
      && (parsed.nextDueAt < previous.nextDueAt
        || (parsed.lastDueAt !== undefined && previous.lastDueAt !== undefined
          && parsed.lastDueAt < previous.lastDueAt))) {
      throw new Error('learning schedule cursor cannot move backward')
    }
    await this.domain.table('metadata').put(key, {
      key, value: JSON.stringify(parsed), updatedAt: parsed.updatedAt,
    })
    return parsed
  }

  getLearningSchedulePolicy(homeAddress: string): LearningSchedulePolicy | undefined {
    const record = this.domain.table('metadata').get(`${LEARNING_POLICY_PREFIX}${homeAddress}`)
    return record === undefined ? undefined
      : LearningSchedulePolicySchema.parse(JSON.parse(record.value)) as LearningSchedulePolicy
  }

  /** Caller holds the learning batch write lock and checks the prior revision. */
  async putLearningSchedulePolicy(policy: LearningSchedulePolicy): Promise<LearningSchedulePolicy> {
    const parsed = LearningSchedulePolicySchema.parse(policy) as LearningSchedulePolicy
    const prior = this.getLearningSchedulePolicy(parsed.homeAddress)
    if (parsed.revision !== (prior?.revision ?? 0) + 1) {
      throw new Error('learning schedule policy revision conflict')
    }
    const key = `${LEARNING_POLICY_PREFIX}${parsed.homeAddress}`
    await this.domain.table('metadata').put(key, {
      key, value: JSON.stringify(parsed), updatedAt: parsed.updatedAt,
    })
    return parsed
  }

  getProposal(id: string): MemoryProposal | undefined {
    const value = this.domain.table('proposals').get(id)
    return value === undefined ? undefined : MemoryProposalSchema.parse(value) as MemoryProposal
  }

  async putProposal(proposal: MemoryProposal): Promise<void> {
    const parsed = MemoryProposalSchema.parse(proposal) as MemoryProposal
    const task = this.proposalTail.catch(() => undefined).then(async () => {
      const prior = this.getProposal(parsed.id)
      if (prior) {
        const identity = (item: MemoryProposal) => ({ id: item.id, fromAddress: item.fromAddress,
          toAddress: item.toAddress, proposedKind: item.proposedKind, description: item.description,
          body: item.body, tags: item.tags, sourceRefs: item.sourceRefs,
          baseAsset: item.baseAsset, createdAt: item.createdAt })
        if (!isDeepStrictEqual(identity(prior), identity(parsed))) {
          throw new Error(`memory proposal identity changed: ${parsed.id}`)
        }
        if (prior.status !== 'pending' && !isDeepStrictEqual(prior, parsed)) {
          throw new Error(`memory proposal decision is immutable: ${parsed.id}`)
        }
        if (prior.humanReview && !isDeepStrictEqual(prior.humanReview, parsed.humanReview)) {
          throw new Error(`memory proposal human review is immutable: ${parsed.id}`)
        }
        if (prior.status === 'pending' && parsed.status === 'pending'
          && !isDeepStrictEqual(prior, parsed)) {
          const { humanReview: _before, ...before } = prior
          const { humanReview: _after, ...after } = parsed
          if (prior.humanReview || !parsed.humanReview || !isDeepStrictEqual(before, after)) {
            throw new Error(`pending memory proposal changed: ${parsed.id}`)
          }
        }
        if (isDeepStrictEqual(prior, parsed)) return
      }
      await this.domain.table('proposals').put(parsed.id, parsed)
    })
    this.proposalTail = task
    await task
  }

  listProposals(options: {
    fromAddress?: string
    toAddress?: string
    status?: MemoryProposal['status']
  } = {}): MemoryProposal[] {
    return [...this.domain.table('proposals').entries()]
      .map(([, proposal]) => MemoryProposalSchema.parse(proposal) as MemoryProposal)
      .filter(proposal => options.fromAddress === undefined || proposal.fromAddress === options.fromAddress)
      .filter(proposal => options.toAddress === undefined || proposal.toAddress === options.toAddress)
      .filter(proposal => options.status === undefined || proposal.status === options.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getSharedKnowledgeProposal(id: string): SharedKnowledgeProposal | undefined {
    const value = this.domain.table('metadata').get(`${SHARED_KNOWLEDGE_PROPOSAL_PREFIX}${id}`)
    return value === undefined ? undefined : SharedKnowledgeProposalSchema.parse(JSON.parse(value.value))
  }

  listSharedKnowledgeProposals(status?: SharedKnowledgeProposal['status']): SharedKnowledgeProposal[] {
    return [...this.domain.table('metadata').entries()]
      .filter(([key]) => key.startsWith(SHARED_KNOWLEDGE_PROPOSAL_PREFIX))
      .map(([, entry]) => SharedKnowledgeProposalSchema.parse(JSON.parse(entry.value)))
      .filter(proposal => status === undefined || proposal.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async putSharedKnowledgeProposal(input: SharedKnowledgeProposal): Promise<SharedKnowledgeProposal> {
    const proposal = SharedKnowledgeProposalSchema.parse(input)
    const task = this.proposalTail.catch(() => undefined).then(async () => {
      const prior = this.getSharedKnowledgeProposal(proposal.id)
      if (prior) {
        const identity = (item: SharedKnowledgeProposal) => ({ id: item.id, fromAddress: item.fromAddress,
          target: item.target, description: item.description, body: item.body,
          sourceRefs: item.sourceRefs, createdAt: item.createdAt })
        if (!isDeepStrictEqual(identity(prior), identity(proposal))) {
          throw new Error(`shared Knowledge proposal identity changed: ${proposal.id}`)
        }
        if (prior.status !== 'pending' && !isDeepStrictEqual(prior, proposal)) {
          throw new Error(`shared Knowledge decision is immutable: ${proposal.id}`)
        }
        if (prior.humanReview && !isDeepStrictEqual(prior.humanReview, proposal.humanReview)) {
          throw new Error(`shared Knowledge human review is immutable: ${proposal.id}`)
        }
        if (prior.status === 'pending' && proposal.status === 'pending'
          && (!proposal.humanReview || prior.humanReview)) {
          if (!isDeepStrictEqual(prior, proposal)) {
            throw new Error(`pending shared Knowledge proposal changed: ${proposal.id}`)
          }
        }
        if (isDeepStrictEqual(prior, proposal)) return proposal
      }
      const key = `${SHARED_KNOWLEDGE_PROPOSAL_PREFIX}${proposal.id}`
      await this.domain.table('metadata').put(key, {
        key, value: JSON.stringify(proposal), updatedAt: nowIso(),
      })
      return proposal
    })
    this.proposalTail = task
    return await task
  }

  async putReceipt(receipt: FitnessReceipt): Promise<boolean> {
    const parsed = FitnessReceiptSchema.parse(receipt) as FitnessReceipt
    const task = this.receiptTail.catch(() => undefined).then(async () => {
      const existing = this.domain.table('receipts').get(parsed.id) as FitnessReceipt | undefined
      if (existing !== undefined) {
        const { createdAt: _previousTime, ...previous } = existing
        const { createdAt: _nextTime, ...next } = parsed
        if (JSON.stringify(previous) !== JSON.stringify(next)) {
          throw new Error(`fitness receipt conflicts with its prior value: ${parsed.id}`)
        }
        return false
      }
      await this.domain.table('receipts').put(parsed.id, parsed)
      return true
    })
    this.receiptTail = task
    return task
  }

  listReceipts(assetId?: string): FitnessReceipt[] {
    return [...this.domain.table('receipts').entries()]
      .map(([, receipt]) => receipt as FitnessReceipt)
      .filter(receipt => assetId === undefined || receipt.assetId === assetId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  getCheckpoint(id: string): LearningCheckpoint | undefined {
    const record = this.domain.table('metadata').get(checkpointKey(id))
    if (record === undefined) return undefined
    return LearningCheckpointSchema.parse(JSON.parse(record.value)) as LearningCheckpoint
  }

  async putCheckpoint(checkpoint: LearningCheckpoint): Promise<void> {
    const parsed = LearningCheckpointSchema.parse(checkpoint) as LearningCheckpoint
    const key = checkpointKey(parsed.id)
    await this.domain.table('metadata').put(key, {
      key,
      value: JSON.stringify(parsed),
      updatedAt: parsed.settledAt ?? parsed.createdAt,
    })
  }

  listCheckpoints(options: {
    sessionId?: string
    homeAddress?: string
    status?: LearningCheckpoint['status']
  } = {}): LearningCheckpoint[] {
    return [...this.domain.table('metadata').entries()]
      .filter(([key]) => key.startsWith(CHECKPOINT_PREFIX))
      .map(([, record]) => LearningCheckpointSchema.parse(JSON.parse(record.value)) as LearningCheckpoint)
      .filter(item => options.sessionId === undefined || item.sessionId === options.sessionId)
      .filter(item => options.homeAddress === undefined || item.homeAddress === options.homeAddress)
      .filter(item => options.status === undefined || item.status === options.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async close(): Promise<void> {
    await this.domain.close()
  }
}

function checkpointKey(id: string): string {
  return `${CHECKPOINT_PREFIX}${id}`
}
