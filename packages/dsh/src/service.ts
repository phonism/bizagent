import { isAbsolute, relative, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import {
  ASSET_KINDS,
  FITNESS_SIGNALS,
  type AssetKind,
  type AssetStatus,
  type EvidenceRef,
  type FitnessReceipt,
  type FitnessSignal,
  type HomeAddress,
  type LearningCheckpoint,
  type MemoryProposal,
  type SessionBinding,
  nowIso,
  parseHomeAddress,
  stableId,
} from './domain.js'
import type { ResolvedConfig } from './config.js'
import { HomeStore } from './home-store.js'
import { LearningLedger } from './ledger.js'
import { ExplicitCorrectionTrigger, type LearningTrigger } from './learning-trigger.js'

type MutableKind = Exclude<AssetKind, 'identity'>

export class BizAgentService {
  private readonly liveBindings = new Map<string, SessionBinding>()
  private readonly persistenceErrors: string[] = []

  constructor(
    readonly store: HomeStore,
    readonly ledger: LearningLedger,
    readonly config: ResolvedConfig,
    private readonly sessionQuery?: Pick<SessionQueryEngine, 'readSession'>,
    private readonly learningTriggers: readonly LearningTrigger[] = [new ExplicitCorrectionTrigger()],
  ) {}

  async initialize(): Promise<void> {
    if (this.config.defaultHome !== undefined
      && this.config.autoCreateDefaultHome
      && !this.store.hasHome(this.config.defaultHome)) {
      await this.store.createHome({
        address: this.config.defaultHome,
        ...(this.config.defaultIdentity !== undefined ? { identity: this.config.defaultIdentity } : {}),
      })
    }
    for (const mapping of this.config.workspaceHomes) {
      if (!this.store.hasHome(mapping.address)) {
        throw new Error(`workspaceHomes references a missing Agent Home: ${mapping.address}`)
      }
    }
    await this.reconcileProposals()
    await this.reconcileCheckpoints()
  }

  bindSession(sessionId: string, cwd?: string): SessionBinding | undefined {
    const live = this.liveBindings.get(sessionId)
    if (live !== undefined) return live
    const persisted = this.ledger.getBinding(sessionId)
    if (persisted !== undefined) {
      if (!this.store.hasHome(persisted.homeAddress)) {
        throw new Error(`session ${sessionId} is bound to missing Home ${persisted.homeAddress}`)
      }
      this.liveBindings.set(sessionId, persisted)
      return persisted
    }
    const homeAddress = this.resolveHome(cwd)
    if (homeAddress === undefined) return undefined
    const binding: SessionBinding = {
      sessionId,
      homeAddress,
      ...(cwd !== undefined ? { cwd } : {}),
      boundAt: nowIso(),
    }
    this.liveBindings.set(sessionId, binding)
    void this.ledger.putBinding(binding).catch((error: unknown) => {
      this.persistenceErrors.push(`binding ${sessionId}: ${errorMessage(error)}`)
    })
    return binding
  }

  contextForSession(sessionId: string, cwd?: string): string {
    const binding = this.bindSession(sessionId, cwd)
    if (binding === undefined) return ''
    const episodeCount = new Set([
      ...this.ledger.listBindings(binding.homeAddress).map(item => item.sessionId),
      ...[...this.liveBindings.values()]
        .filter(item => item.homeAddress === binding.homeAddress)
        .map(item => item.sessionId),
    ]).size
    return this.store.contextFor(binding.homeAddress, this.config.budget, episodeCount)
  }

  contextSnapshotForSession(sessionId: string, cwd?: string): {
    homeAddress: HomeAddress
    revision: number
    digest: string
    text: string
  } | undefined {
    const binding = this.bindSession(sessionId, cwd)
    if (binding === undefined) return undefined
    const home = this.store.getHome(binding.homeAddress)
    return {
      homeAddress: binding.homeAddress,
      revision: home.revision,
      digest: home.contextDigest,
      text: this.contextForSession(sessionId, cwd),
    }
  }

  async homeStatus(agent: Agent): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    const home = this.store.getHome(binding.homeAddress)
    return {
      binding,
      home,
      activeAssets: this.store.listAssets(binding.homeAddress, 'active').length,
      incomingPending: this.ledger.listProposals({ toAddress: binding.homeAddress, status: 'pending' }).length,
      outgoingPending: this.ledger.listProposals({ fromAddress: binding.homeAddress, status: 'pending' }).length,
      episodes: this.ledger.listBindings(binding.homeAddress).length,
      persistenceErrors: [...this.persistenceErrors],
    }
  }

  async searchMemory(agent: Agent, input: {
    query?: string
    kind?: AssetKind
    status?: AssetStatus
    limit?: number
  }): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    const assets = this.store.searchAssets(binding.homeAddress, input).map(publicAssetIndex)
    return { homeAddress: binding.homeAddress, count: assets.length, assets }
  }

  async readMemory(agent: Agent, callId: string, assetId: string): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    const asset = this.store.readAsset(binding.homeAddress, assetId)
    await this.ledger.putReceipt(this.receipt(agent, callId, asset.id, binding.homeAddress, 'retrieved'))
    return { homeAddress: binding.homeAddress, asset: publicAsset(asset) }
  }

  async remember(agent: Agent, callId: string, input: {
    description: string
    body: string
    tags?: string[]
  }): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    const asset = await this.store.createAsset({
      id: stableId('mem', callId),
      ownerAddress: binding.homeAddress,
      kind: 'memory',
      description: input.description,
      body: input.body,
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      sourceRefs: [currentEvidence(agent)],
      status: 'active',
    })
    return { homeAddress: binding.homeAddress, asset: publicAsset(asset), home: this.store.getHome(binding.homeAddress) }
  }

  async updateMemory(agent: Agent, input: {
    assetId: string
    action: 'revise' | 'retire'
    description?: string
    body?: string
    tags?: string[]
  }): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    const current = this.store.readAsset(binding.homeAddress, input.assetId)
    const sourceRefs = dedupeEvidence([...current.sourceRefs, currentEvidence(agent)])
    const asset = await this.store.updateAsset(binding.homeAddress, input.assetId, {
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      sourceRefs,
      status: input.action === 'retire' ? 'retired' : 'active',
    })
    return { homeAddress: binding.homeAddress, asset: publicAsset(asset), home: this.store.getHome(binding.homeAddress) }
  }

  async proposeMemory(agent: Agent, callId: string, input: {
    toAddress: string
    proposedKind?: MutableKind
    description: string
    body: string
    tags?: string[]
  }): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    const toAddress = parseHomeAddress(input.toAddress)
    if (toAddress === binding.homeAddress) {
      throw new Error('a same-Home observation should be remembered directly, not proposed')
    }
    if (!this.store.hasHome(toAddress)) throw new Error(`target Agent Home not found: ${toAddress}`)
    const id = stableId('proposal', callId)
    const existing = this.ledger.getProposal(id)
    if (existing !== undefined) return { proposal: existing, idempotentReplay: true }
    const proposal: MemoryProposal = {
      id,
      fromAddress: binding.homeAddress,
      toAddress,
      proposedKind: input.proposedKind ?? 'memory',
      description: input.description.trim(),
      body: input.body.trim(),
      tags: input.tags ?? [],
      sourceRefs: [currentEvidence(agent)],
      status: 'pending',
      createdAt: nowIso(),
    }
    await this.ledger.putProposal(proposal)
    return { proposal }
  }

  async proposals(agent: Agent, input: {
    id?: string
    direction?: 'incoming' | 'outgoing' | 'both'
    status?: MemoryProposal['status']
  }): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    if (input.id !== undefined) {
      const proposal = this.ledger.getProposal(input.id)
      if (proposal === undefined) throw new Error(`proposal not found: ${input.id}`)
      if (proposal.fromAddress !== binding.homeAddress && proposal.toAddress !== binding.homeAddress) {
        throw new Error(`proposal ${input.id} is not visible to ${binding.homeAddress}`)
      }
      return { proposal }
    }
    const direction = input.direction ?? 'incoming'
    const proposals = this.ledger.listProposals({
      ...(direction === 'incoming' ? { toAddress: binding.homeAddress } : {}),
      ...(direction === 'outgoing' ? { fromAddress: binding.homeAddress } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    }).filter(proposal => direction !== 'both'
      || proposal.fromAddress === binding.homeAddress
      || proposal.toAddress === binding.homeAddress)
    return { homeAddress: binding.homeAddress, count: proposals.length, proposals }
  }

  async acceptProposal(agent: Agent, input: {
    proposalId: string
    kind?: MutableKind
    description?: string
    body?: string
    tags?: string[]
    decision?: string
  }): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    return this.acceptProposalForHome(binding.homeAddress, input)
  }

  async acceptProposalAsOwner(ownerAddress: string, input: {
    proposalId: string
    kind?: MutableKind
    description?: string
    body?: string
    tags?: string[]
    decision?: string
  }): Promise<Record<string, unknown>> {
    return this.acceptProposalForHome(parseHomeAddress(ownerAddress), input)
  }

  private async acceptProposalForHome(bindingHome: HomeAddress, input: {
    proposalId: string
    kind?: MutableKind
    description?: string
    body?: string
    tags?: string[]
    decision?: string
  }): Promise<Record<string, unknown>> {
    const proposal = this.requireTargetProposal(bindingHome, input.proposalId)
    if (proposal.status === 'accepted') {
      const asset = proposal.targetAssetId === undefined
        ? this.store.findAssetByProposalId(bindingHome, proposal.id)
        : this.store.readAsset(bindingHome, proposal.targetAssetId)
      if (asset === undefined) throw new Error(`accepted proposal ${proposal.id} has no target asset`)
      return { proposal, asset: publicAsset(asset), idempotentReplay: true }
    }
    if (proposal.status !== 'pending') throw new Error(`proposal ${proposal.id} is already ${proposal.status}`)
    const kind = input.kind ?? proposal.proposedKind
    if (kind === 'identity') throw new Error('Identity proposals require human approval and are not supported in v0.1')
    const targetAssetId = stableId(kindPrefix(kind), proposal.id)
    const asset = await this.store.createAsset({
      id: targetAssetId,
      ownerAddress: bindingHome,
      kind,
      description: input.description ?? proposal.description,
      body: input.body ?? proposal.body,
      tags: input.tags ?? proposal.tags,
      sourceRefs: proposal.sourceRefs,
      status: 'active',
      proposalId: proposal.id,
    })
    const accepted: MemoryProposal = {
      ...proposal,
      status: 'accepted',
      targetAssetId: asset.id,
      ...(input.decision?.trim() ? { decision: input.decision.trim() } : {}),
      decidedAt: nowIso(),
    }
    await this.ledger.putProposal(accepted)
    return { proposal: accepted, asset: publicAsset(asset), home: this.store.getHome(bindingHome) }
  }

  async rejectProposal(agent: Agent, proposalId: string, decision: string): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    return this.rejectProposalForHome(binding.homeAddress, proposalId, decision)
  }

  async rejectProposalAsOwner(
    ownerAddress: string,
    proposalId: string,
    decision: string,
  ): Promise<Record<string, unknown>> {
    return this.rejectProposalForHome(parseHomeAddress(ownerAddress), proposalId, decision)
  }

  private async rejectProposalForHome(
    bindingHome: HomeAddress,
    proposalId: string,
    decision: string,
  ): Promise<Record<string, unknown>> {
    const proposal = this.requireTargetProposal(bindingHome, proposalId)
    if (proposal.status === 'rejected') return { proposal, idempotentReplay: true }
    if (proposal.status !== 'pending') throw new Error(`proposal ${proposal.id} is already ${proposal.status}`)
    const rejected: MemoryProposal = {
      ...proposal,
      status: 'rejected',
      decision: decision.trim(),
      decidedAt: nowIso(),
    }
    await this.ledger.putProposal(rejected)
    return { proposal: rejected }
  }

  async prepareLearningCheckpoint(agent: Agent, turn: number): Promise<LearningCheckpoint | undefined> {
    if (this.config.learningCheckpointEnabled === false) return undefined
    const id = checkpointId(String(agent.id), turn)
    if (this.ledger.getCheckpoint(id) !== undefined) return undefined

    let match: ReturnType<LearningTrigger['detect']> = undefined
    for (const trigger of this.learningTriggers) {
      match = trigger.detect(agent.session.events, turn)
      if (match !== undefined) break
    }
    if (match === undefined) return undefined

    const binding = await this.requireDurableBinding(agent)
    const checkpoint: LearningCheckpoint = {
      schemaVersion: 1,
      id,
      sessionId: String(agent.id),
      turn,
      homeAddress: binding.homeAddress,
      reason: match.reason,
      status: 'pending',
      evidenceRef: { ...match.evidenceRef, sessionId: String(agent.id) },
      excerpt: match.excerpt,
      createdAt: nowIso(),
    }
    await this.ledger.putCheckpoint(checkpoint)
    return checkpoint
  }

  async settleLearningCheckpoint(agent: Agent, input: {
    checkpointId: string
    action: 'remember' | 'skip'
    description?: string
    body?: string
    tags?: string[]
    decision?: string
  }): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    const checkpoint = this.ledger.getCheckpoint(input.checkpointId)
    if (checkpoint === undefined) throw new Error(`learning checkpoint not found: ${input.checkpointId}`)
    if (checkpoint.sessionId !== String(agent.id)) {
      throw new Error(`learning checkpoint ${checkpoint.id} belongs to another Session`)
    }
    if (checkpoint.homeAddress !== binding.homeAddress) {
      throw new Error(`learning checkpoint ${checkpoint.id} belongs to ${checkpoint.homeAddress}`)
    }
    if (checkpoint.status === 'remembered') {
      if (checkpoint.assetId === undefined) throw new Error(`remembered checkpoint ${checkpoint.id} has no asset`)
      return {
        checkpoint,
        asset: publicAsset(this.store.readAsset(binding.homeAddress, checkpoint.assetId)),
        idempotentReplay: true,
      }
    }
    if (checkpoint.status === 'skipped') return { checkpoint, idempotentReplay: true }
    if (checkpoint.status !== 'pending') throw new Error(`learning checkpoint ${checkpoint.id} is ${checkpoint.status}`)

    if (input.action === 'skip') {
      const decision = input.decision?.trim()
      if (!decision) throw new Error('a skipped learning checkpoint requires a decision')
      const skipped: LearningCheckpoint = {
        ...checkpoint,
        status: 'skipped',
        decision,
        settledAt: nowIso(),
      }
      await this.ledger.putCheckpoint(skipped)
      return { checkpoint: skipped }
    }

    const description = input.description?.trim()
    const body = input.body?.trim()
    if (!description || !body) {
      throw new Error('remembering a learning checkpoint requires description and body')
    }
    const assetId = stableId('mem', checkpoint.id)
    const asset = await this.store.createAsset({
      id: assetId,
      ownerAddress: binding.homeAddress,
      kind: 'memory',
      description,
      body,
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      sourceRefs: [checkpoint.evidenceRef],
      status: 'active',
    })
    const remembered: LearningCheckpoint = {
      ...checkpoint,
      status: 'remembered',
      assetId: asset.id,
      ...(input.decision?.trim() ? { decision: input.decision.trim() } : {}),
      settledAt: nowIso(),
    }
    await this.ledger.putCheckpoint(remembered)
    return { checkpoint: remembered, asset: publicAsset(asset), home: this.store.getHome(binding.homeAddress) }
  }

  async failPendingCheckpoint(sessionId: string, turn: number, decision: string): Promise<void> {
    const checkpoint = this.ledger.getCheckpoint(checkpointId(sessionId, turn))
    if (checkpoint === undefined || checkpoint.status !== 'pending') return
    await this.ledger.putCheckpoint({
      ...checkpoint,
      status: 'failed',
      decision: decision.trim() || 'The learning checkpoint did not settle before the turn ended.',
      settledAt: nowIso(),
    })
  }

  async readEvidence(agent: Agent, input: {
    assetId: string
    sourceIndex?: number
  }): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    const asset = this.store.readAsset(binding.homeAddress, input.assetId)
    const sourceIndex = input.sourceIndex ?? 0
    if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
      throw new Error('sourceIndex must be a non-negative integer')
    }
    const ref = asset.sourceRefs[sourceIndex]
    if (ref === undefined) throw new Error(`evidence source ${sourceIndex} not found on asset ${asset.id}`)
    if (ref.type !== 'session-events') {
      throw new Error(`evidence type ${ref.type} is not readable in P0 Lite`)
    }
    if (this.sessionQuery === undefined) throw new Error('DSH sessionQuery is unavailable')
    if (ref.fromSeq > ref.toSeq) throw new Error('evidence range is reversed')
    const snapshot = await this.sessionQuery.readSession(ref.sessionId as SessionId)
    const targetEvents = snapshot.events.filter(event => event.seq >= ref.fromSeq && event.seq <= ref.toSeq)
    if (targetEvents.length !== ref.toSeq - ref.fromSeq + 1) {
      throw new Error(`evidence range ${ref.fromSeq}-${ref.toSeq} is incomplete in Session ${ref.sessionId}`)
    }
    const limited = targetEvents.slice(0, 24)
    return {
      assetId: asset.id,
      sourceIndex,
      ref,
      session: {
        id: String(snapshot.session.id),
        cwd: snapshot.session.cwd,
      },
      events: limited.map(publicEvidenceEvent),
      omittedEvents: targetEvents.length - limited.length,
    }
  }

  async feedback(agent: Agent, callId: string, input: {
    assetId: string
    signal: FitnessSignal
    outcome?: string
  }): Promise<Record<string, unknown>> {
    const binding = await this.requireDurableBinding(agent)
    const asset = this.store.readAsset(binding.homeAddress, input.assetId)
    const receipt = this.receipt(
      agent,
      callId,
      asset.id,
      binding.homeAddress,
      input.signal,
      input.outcome,
    )
    await this.ledger.putReceipt(receipt)
    const delta = fitnessDelta(input.signal)
    const updated = delta === 0
      ? asset
      : await this.store.updateAsset(binding.homeAddress, asset.id, {
        fitness: Math.max(-1, Math.min(1, asset.fitness + delta)),
      })
    const harmfulReceipts = this.ledger.listReceipts(asset.id)
      .filter(item => item.signal === 'contradicted' || item.signal === 'failed')
    return {
      receipt,
      asset: publicAsset(updated),
      reviewRequired: harmfulReceipts.length >= 2,
    }
  }

  async close(): Promise<void> {
    await this.ledger.close()
  }

  recordRuntimeError(scope: string, error: unknown): void {
    this.persistenceErrors.push(`${scope}: ${errorMessage(error)}`)
  }

  private async requireDurableBinding(agent: Agent): Promise<SessionBinding> {
    const binding = this.bindSession(String(agent.id), agent.session.header.cwd)
    if (binding === undefined) {
      throw new Error(`no Agent Home resolves for session ${agent.id}; configure defaultHome or workspaceHomes`)
    }
    await this.ledger.putBinding(binding)
    return binding
  }

  private resolveHome(cwd?: string): HomeAddress | undefined {
    if (cwd !== undefined) {
      const target = resolve(cwd)
      for (const mapping of this.config.workspaceHomes) {
        const rel = relative(mapping.root, target)
        if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return mapping.address
      }
    }
    return this.config.defaultHome
  }

  private requireTargetProposal(homeAddress: HomeAddress, id: string): MemoryProposal {
    const proposal = this.ledger.getProposal(id)
    if (proposal === undefined) throw new Error(`proposal not found: ${id}`)
    if (proposal.toAddress !== homeAddress) {
      throw new Error(`Home ${homeAddress} cannot decide a proposal owned by ${proposal.toAddress}`)
    }
    return proposal
  }

  private receipt(
    agent: Agent,
    callId: string,
    assetId: string,
    ownerAddress: HomeAddress,
    signal: FitnessSignal,
    outcome?: string,
  ): FitnessReceipt {
    const eventSeq = agent.session.events.at(-1)?.seq
    return {
      id: stableId('receipt', `${callId}:${signal}:${assetId}`),
      assetId,
      ownerAddress,
      sessionId: String(agent.id),
      ...(eventSeq !== undefined ? { eventSeq } : {}),
      signal,
      ...(outcome?.trim() ? { outcome: outcome.trim() } : {}),
      createdAt: nowIso(),
    }
  }

  private async reconcileProposals(): Promise<void> {
    for (const proposal of this.ledger.listProposals({ status: 'pending' })) {
      const asset = this.store.findAssetByProposalId(proposal.toAddress, proposal.id)
      if (asset === undefined) continue
      await this.ledger.putProposal({
        ...proposal,
        status: 'accepted',
        targetAssetId: asset.id,
        decision: 'Recovered an asset durably written before proposal settlement.',
        decidedAt: nowIso(),
      })
    }
    for (const proposal of this.ledger.listProposals({ status: 'accepted' })) {
      const asset = this.store.findAssetByProposalId(proposal.toAddress, proposal.id)
      if (asset === undefined) {
        this.persistenceErrors.push(`accepted proposal ${proposal.id} is missing its target asset`)
      }
    }
  }

  private async reconcileCheckpoints(): Promise<void> {
    for (const checkpoint of this.ledger.listCheckpoints({ status: 'pending' })) {
      const assetId = stableId('mem', checkpoint.id)
      try {
        const asset = this.store.readAsset(checkpoint.homeAddress, assetId)
        await this.ledger.putCheckpoint({
          ...checkpoint,
          status: 'remembered',
          assetId: asset.id,
          decision: 'Recovered a Memory durably written before checkpoint settlement.',
          settledAt: nowIso(),
        })
      } catch {
        // A pending checkpoint may still belong to a live or recoverable DSH turn.
      }
    }
  }
}

function currentEvidence(agent: Agent): EvidenceRef {
  const events = agent.session.events
  if (events.length === 0) throw new Error('cannot create long-term learning without a durable session event')
  let turnStart = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') {
      turnStart = index
      break
    }
  }
  const firstUser = events.slice(turnStart).find(event => event.type === 'user/message')
  const fromSeq = firstUser?.seq ?? events[turnStart]?.seq ?? events[0]?.seq ?? 0
  const toSeq = events.at(-1)?.seq ?? fromSeq
  return { type: 'session-events', sessionId: String(agent.id), fromSeq, toSeq }
}

function dedupeEvidence(refs: EvidenceRef[]): EvidenceRef[] {
  const unique = new Map<string, EvidenceRef>()
  for (const ref of refs) unique.set(JSON.stringify(ref), ref)
  return [...unique.values()]
}

function publicAssetIndex(asset: ReturnType<HomeStore['readAsset']>): Record<string, unknown> {
  return {
    id: asset.id,
    kind: asset.kind,
    description: asset.description,
    tags: asset.tags,
    status: asset.status,
    revision: asset.revision,
    confidence: asset.confidence,
    fitness: asset.fitness,
    updatedAt: asset.updatedAt,
  }
}

function publicAsset(asset: ReturnType<HomeStore['readAsset']>): Record<string, unknown> {
  return { ...publicAssetIndex(asset), body: asset.body, sourceRefs: asset.sourceRefs }
}

function kindPrefix(kind: MutableKind): string {
  return ({ memory: 'mem', insight: 'insight', knowledge: 'knowledge', method: 'method' } as const)[kind]
}

function fitnessDelta(signal: FitnessSignal): number {
  return ({ retrieved: 0, applied: 0, confirmed: 0.2, contradicted: -0.3, failed: -0.3 } as const)[signal]
}

function checkpointId(sessionId: string, turn: number): string {
  return stableId('checkpoint', `${sessionId}:${turn}`)
}

function publicEvidenceEvent(event: SessionEvent): Record<string, unknown> {
  const base = { seq: event.seq, time: event.time, type: event.type }
  switch (event.type) {
    case 'user/message':
      return { ...base, text: boundedContentText(event.data.content) }
    case 'assistant/message':
      return { ...base, text: boundedContentText(event.data.message.content) }
    case 'tool/call':
      return { ...base, callId: String(event.data.callId), name: event.data.name }
    case 'tool/result':
      return {
        ...base,
        callId: String(event.data.message.source.callId),
        text: boundedContentText(event.data.message.content),
        ...(event.data.error !== undefined ? { error: event.data.error } : {}),
      }
    default:
      return base
  }
}

function boundedContentText(content: readonly unknown[]): string {
  const text = content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const candidate = block as { type?: unknown; text?: unknown }
    return candidate.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : []
  }).join('\n')
  return text.length <= 4000 ? text : `${text.slice(0, 3999)}…`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value)
}

export function isFitnessSignal(value: string): value is FitnessSignal {
  return (FITNESS_SIGNALS as readonly string[]).includes(value)
}
