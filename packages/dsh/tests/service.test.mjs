import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'

class MemoryLedger {
  bindings = new Map()
  proposalsMap = new Map()
  receipts = new Map()
  checkpoints = new Map()

  getBinding(id) { return this.bindings.get(id) }
  async putBinding(binding) {
    const current = this.bindings.get(binding.sessionId)
    if (current && current.homeAddress !== binding.homeAddress) throw new Error('rebind denied')
    this.bindings.set(binding.sessionId, structuredClone(binding))
  }
  listBindings(homeAddress) {
    return [...this.bindings.values()].filter(binding => !homeAddress || binding.homeAddress === homeAddress)
  }
  getProposal(id) { return this.proposalsMap.get(id) }
  async putProposal(proposal) { this.proposalsMap.set(proposal.id, structuredClone(proposal)) }
  listProposals(options = {}) {
    return [...this.proposalsMap.values()]
      .filter(item => !options.fromAddress || item.fromAddress === options.fromAddress)
      .filter(item => !options.toAddress || item.toAddress === options.toAddress)
      .filter(item => !options.status || item.status === options.status)
  }
  async putReceipt(receipt) { this.receipts.set(receipt.id, structuredClone(receipt)) }
  listReceipts(assetId) {
    return [...this.receipts.values()].filter(item => !assetId || item.assetId === assetId)
  }
  getCheckpoint(id) { return this.checkpoints.get(id) }
  async putCheckpoint(checkpoint) { this.checkpoints.set(checkpoint.id, structuredClone(checkpoint)) }
  listCheckpoints(options = {}) {
    return [...this.checkpoints.values()]
      .filter(item => !options.sessionId || item.sessionId === options.sessionId)
      .filter(item => !options.homeAddress || item.homeAddress === options.homeAddress)
      .filter(item => !options.status || item.status === options.status)
  }
  async close() {}
}

function agent(id, cwd) {
  return {
    id,
    session: {
      header: { id, cwd },
      events: [
        { seq: 0, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Analyze the campaign.' }] } },
        { seq: 2, type: 'tool/call', data: { callId: `${id}-call` } },
      ],
    },
  }
}

test('single-agent learning and governed cross-Home learning form one closed loop', async (t) => {
  const root = await mkdtemp('/private/tmp/bizagent-service-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const personalCwd = `${root}/work/personal`
  const roleCwd = `${root}/work/role`
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', identity: 'Learn Alice preferences.' })
  await store.createHome({ address: 'role:growth-strategy', identity: 'Own reusable growth strategy methods.' })
  const ledger = new MemoryLedger()
  const service = new BizAgentService(store, ledger, {
    homeRoot: root,
    defaultHome: 'personal:alice',
    autoCreateDefaultHome: false,
    workspaceHomes: [{ root: roleCwd, address: 'role:growth-strategy' }],
    budget: { identityMaxBytes: 2048, indexMaxBytes: 4096 },
  })
  await service.initialize()

  const alice = agent('session-alice', personalCwd)
  const remembered = await service.remember(alice, 'call-remember', {
    description: 'Exclude D0 when reporting next-day retention.',
    body: 'Next-day retention is D1 active users divided by D0 new users; registration-day activity is not retained usage.',
    tags: ['retention'],
  })
  assert.equal(remembered.homeAddress, 'personal:alice')
  const personalContext = service.contextForSession(alice.id, personalCwd)
  assert.match(personalContext, /Exclude D0/)
  assert.doesNotMatch(personalContext, /registration-day activity/)

  const proposed = await service.proposeMemory(alice, 'call-propose', {
    toAddress: 'role:growth-strategy',
    proposedKind: 'method',
    description: 'Standardize retention comparisons by acquisition cohort.',
    body: 'Always compare like-for-like acquisition cohorts before attributing a retention change to product behavior.',
    tags: ['retention', 'analysis'],
  })
  assert.equal(proposed.proposal.status, 'pending')

  await assert.rejects(
    () => service.acceptProposal(alice, { proposalId: proposed.proposal.id }),
    /cannot decide a proposal/,
  )

  const role = agent('session-role', roleCwd)
  const accepted = await service.acceptProposal(role, {
    proposalId: proposed.proposal.id,
    decision: 'Evidence is specific and reusable.',
  })
  assert.equal(accepted.proposal.status, 'accepted')
  assert.equal(accepted.asset.kind, 'method')
  const roleContext = service.contextForSession(role.id, roleCwd)
  assert.match(roleContext, /Standardize retention comparisons/)
  assert.doesNotMatch(roleContext, /Always compare like-for-like/)

  const replay = await service.acceptProposal(role, { proposalId: proposed.proposal.id })
  assert.equal(replay.idempotentReplay, true)
  assert.equal(store.listAssets('role:growth-strategy').length, 1)

  const feedback = await service.feedback(role, 'call-feedback', {
    assetId: accepted.asset.id,
    signal: 'confirmed',
    outcome: 'Prevented a false week-over-week conclusion.',
  })
  assert.equal(feedback.receipt.signal, 'confirmed')
  assert.equal(feedback.asset.fitness, 0.2)

  const applied = await service.feedback(role, 'call-applied', {
    assetId: accepted.asset.id,
    signal: 'applied',
  })
  assert.equal(applied.asset.fitness, 0.2)

  const contradicted = await service.feedback(role, 'call-contradicted', {
    assetId: accepted.asset.id,
    signal: 'contradicted',
    outcome: 'The method did not hold for a mixed acquisition cohort.',
  })
  assert.equal(contradicted.reviewRequired, false)
  const failed = await service.feedback(role, 'call-failed', {
    assetId: accepted.asset.id,
    signal: 'failed',
    outcome: 'A second application produced a misleading comparison.',
  })
  assert.equal(failed.reviewRequired, true)
})

test('a Session binding cannot drift after it is established', async (t) => {
  const root = await mkdtemp('/private/tmp/bizagent-binding-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:growth-strategy' })
  const ledger = new MemoryLedger()
  const service = new BizAgentService(store, ledger, {
    homeRoot: root,
    defaultHome: 'personal:alice',
    autoCreateDefaultHome: false,
    workspaceHomes: [{ root: `${root}/role`, address: 'role:growth-strategy' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  })
  await service.initialize()
  assert.equal(service.bindSession('same-session', `${root}/personal`).homeAddress, 'personal:alice')
  assert.equal(service.bindSession('same-session', `${root}/role`).homeAddress, 'personal:alice')
})
