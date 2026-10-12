import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

test('core flow keeps one Home through Frame, Inbox, Work, Project, human receipt and later memory use', async t => {
  const root = await makeTempDir('bizagent-core-loop-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const analystCwd = join(root, 'analyst')
  await mkdir(analystCwd)
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:analyst', owner: 'alice' })
  const runtime = await createDemoRuntime()
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: analystCwd, address: 'role:analyst' },
      { root, address: 'personal:alice' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('core-lead', root, 'Coordinate the result.')
  const analyst = runtime.agent('core-analyst', analystCwd, 'Check the result.')
  const frame = await service.openFrame(lead, { address: 'role:analyst', mode: 'contribute' })
  assert.equal(frame.state.primaryHome, 'personal:alice')
  assert.equal(frame.state.frames[0].address, 'role:analyst')

  const project = (await service.createProject(lead, { title: 'Core flow',
    goal: 'Check a reusable finding.', doneWhen: 'The owner reviews the finding.',
    idempotencyKey: 'core-flow' })).project
  const seat = (await service.inviteProjectSeat(lead, { projectId: project.id,
    homeAddress: 'role:analyst', responsibility: 'Check evidence.' })).seat
  const letter = await service.sendInboxMessage(lead, 'core-letter', {
    projectId: project.id, to: ['role:analyst'], subject: 'Check evidence',
    body: 'Check the source and report the finding.', idempotencyKey: 'core-letter',
  })
  assert.deepEqual(letter.message.to, [seat.address])
  assert.equal((await service.readInboxMessage(analyst, letter.message.id)).message.projectId, project.id)
  const dispatched = await service.dispatchWork(lead, { toAddress: 'role:analyst',
    goal: 'Check source evidence', acceptanceCriteria: 'Return a clear finding.',
    idempotencyKey: 'core-work', projectId: project.id })
  await service.acceptWork(analyst, dispatched.work.id)
  await service.completeWork(analyst, { workId: dispatched.work.id,
    subject: 'Evidence checked', body: 'The source supports the finding.' })
  const submitted = await service.submitProject(lead, { projectId: project.id,
    summary: 'Finding ready', body: 'The Analyst returned the evidence.',
    doneWhenAssessment: 'The formal Work result meets the completion criterion.' })
  assert.equal(submitted.project.status, 'awaiting_acceptance')
  await assert.rejects(() => service.reviewProject(lead, { projectId: project.id,
    claimId: submitted.claim.id, decision: 'accept', reason: 'Approved.' }),
  /host-authenticated human review/)
  const reviewed = await service.reviewProjectAsHuman('alice', { projectId: project.id,
    claimId: submitted.claim.id, expectedRevision: submitted.project.revision,
    decision: 'accept', reason: 'The result meets the criterion.' },
  (principal, current) => principal === 'alice' && current.lead === 'personal:alice')
  assert.equal(reviewed.project.status, 'accepted')
  assert.equal(reviewed.review.reviewedByPrincipal, 'alice')

  const learned = await service.remember(lead, 'core-learning', {
    kind: 'knowledge', description: 'Check evidence before a project claim',
    body: 'Ask the Analyst for source evidence, then submit the formal result for human acceptance.',
  })
  assert.equal(learned.homeAddress, 'personal:alice')
  const reopenedStore = new HomeStore(root)
  await reopenedStore.initialize()
  const resumed = new BizAgentService(reopenedStore, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await resumed.initialize()
  const later = runtime.agent('core-later', root, 'Start from retained knowledge.')
  const found = await resumed.searchMemory(later, { query: 'source evidence' })
  assert.ok(found.assets.some(item => item.id === learned.asset.id))
  assert.equal((await resumed.readProject(later, project.id)).project.status, 'accepted')
})

test('a product line PMO leads its own Project and accepts Knowledge for its Agent Home', async t => {
  const root = await makeTempDir('bizagent-line-loop-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  const organization = await store.createOrganization({
    id: 'northstar', name: 'Northstar', mission: 'deliver verified customer value.',
    members: [{ id: 'alice', displayName: 'Alice', roleId: 'analyst',
      roleName: 'Analyst', responsibility: 'Check source evidence.' }],
    capabilities: [],
  })
  const runtime = await createDemoRuntime()
  const service = new BizAgentService(store, runtime.ledger, {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [], budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }, runtime.sessionQuery, undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lineAddress = organization.lineHome
  const line = runtime.agent('northstar-pmo', store.homeWorkspacePath(lineAddress), 'Coordinate the line.')
  const personal = runtime.agent('northstar-alice', store.homeWorkspacePath('personal:alice'),
    'Share a verified method.')
  const project = (await service.createProject(line, { title: 'Line delivery',
    goal: 'Deliver an evidence based finding.', doneWhen: 'The owner confirms the finding.',
    idempotencyKey: 'northstar-delivery' })).project
  assert.equal(project.lead, lineAddress)
  assert.equal(project.driver, `project:${project.id}`)
  await service.openFrame(personal, { address: lineAddress, mode: 'contribute' })
  const proposed = await service.proposeMemory(personal, 'line-method', {
    toAddress: lineAddress, proposedKind: 'knowledge',
    description: 'Verify source evidence before a line delivery.',
    body: 'Ask the assigned analyst to check source evidence before the PMO submits an outcome claim.',
  })
  assert.equal(proposed.proposal.status, 'pending')
  const accepted = await service.decideProposalAsHuman({ ownerAddress: lineAddress,
    proposalId: proposed.proposal.id, action: 'accept', reviewerId: 'alice',
    authorityRef: 'line-owner:alice', decision: 'The method is reusable across this line.' })
  assert.equal(store.readAsset(lineAddress, accepted.asset.id).ownerAddress, lineAddress)
  assert.ok((await service.searchMemory(line, { query: 'source evidence' })).assets
    .some(item => item.id === accepted.asset.id))
})
