import assert from 'node:assert/strict'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { SharedKnowledgeStore } from '../lib/shared-knowledge.js'
import { stableId } from '../lib/domain.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

test('shared Knowledge publishes only to governed source paths and rejects unsafe directories', async t => {
  const root = await makeTempDir('bizagent-shared-knowledge-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SharedKnowledgeStore(root)
  const proposalId = stableId('proposal', 'shared-source')
  const input = { scope: 'line', line: 'northstar', id: stableId('knowledge', proposalId),
    description: 'Verify source evidence', body: 'Check the source before publication.',
    proposalId, reviewerId: 'alice', authorityRef: 'line.admin:alice',
    publishedAt: new Date().toISOString() }
  const document = await store.publish(input)
  assert.equal(document.path, join(root, 'lines', 'northstar', 'knowledge', `${input.id}.md`))
  assert.equal((await store.publish(input)).path, document.path)
  assert.equal((await store.search([{ scope: 'line', line: 'northstar' }], 'source')).length, 1)
  await assert.rejects(() => store.publish({ ...input, body: 'Changed body.' }), /conflicts/)
  await writeFile(document.path, (await readFile(document.path, 'utf8')).replace('Check the source', 'Skip the source'))
  await assert.rejects(() => store.read(input, input.id), /integrity mismatch/)

  const otherRoot = await makeTempDir('bizagent-shared-link-')
  t.after(() => rm(otherRoot, { recursive: true, force: true }))
  await symlink(otherRoot, join(root, 'knowledge'))
  await assert.rejects(() => store.publish({ ...input, scope: 'common',
    id: stableId('knowledge', 'common-link') }), /real directory/)
  await assert.rejects(() => store.search([{ scope: 'common' }]), /real directory/)
})

test('line and platform Knowledge require human review, keep separate ownership, and recover publication', async t => {
  const root = await makeTempDir('bizagent-shared-flow-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createOrganization({ id: 'northstar', name: 'Northstar', mission: 'Verify sources.',
    members: [{ id: 'alice', displayName: 'Alice', roleId: 'analyst',
      roleName: 'Analyst', responsibility: 'Verify evidence.' }], capabilities: [] })
  await store.createHome({ address: 'personal:outsider', owner: 'outsider' })
  const runtime = await createDemoRuntime()
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [], budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery)
  await service.initialize()
  const alice = runtime.agent('shared-alice', store.homeWorkspacePath('personal:alice'), 'Share a verified rule.')
  const outsider = runtime.agent('shared-outsider', store.homeWorkspacePath('personal:outsider'), 'Read authorized rules.')
  const line = (await service.proposeSharedKnowledge(alice, 'line-rule', {
    scope: 'line', line: 'northstar', description: 'Line source rule',
    body: 'Northstar checks every source.' })).proposal
  const common = (await service.proposeSharedKnowledge(alice, 'common-rule', {
    scope: 'common', description: 'Platform source rule',
    body: 'All lines check every source.' })).proposal
  await assert.rejects(() => service.proposeSharedKnowledge(outsider, 'outsider-line', {
    scope: 'line', line: 'northstar', description: 'Unauthorized', body: 'No.' }), /not visible/)
  assert.equal((await service.searchSharedKnowledge(alice, 'source')).count, 0)
  const acceptedLine = await service.decideSharedKnowledgeAsHuman({ proposalId: line.id,
    action: 'accept', decision: 'Approved for Northstar.', reviewerId: 'alice',
    authorityRef: 'line.admin:alice' })
  assert.equal(acceptedLine.proposal.status, 'accepted')
  assert.equal(acceptedLine.document.path, join(root, 'lines', 'northstar', 'knowledge',
    `${acceptedLine.document.id}.md`))
  assert.equal((await service.searchSharedKnowledge(outsider, 'source')).count, 0)
  assert.equal((await service.searchSharedKnowledge(alice, 'source')).count, 1)
  const acceptedCommon = await service.decideSharedKnowledgeAsHuman({ proposalId: common.id,
    action: 'accept', decision: 'Approved for platform.', reviewerId: 'platform-admin',
    authorityRef: 'platform.admin:platform-admin' })
  assert.equal(acceptedCommon.document.path, join(root, 'knowledge', 'common',
    `${acceptedCommon.document.id}.md`))
  assert.equal((await service.searchSharedKnowledge(outsider, 'source')).count, 1)
  assert.equal((await service.searchSharedKnowledge(alice, 'source')).count, 2)
  assert.match(service.contextForSession(alice.id, alice.session.header.cwd), /Line source rule/)
  assert.match(service.contextForSession(alice.id, alice.session.header.cwd), /Platform source rule/)
  assert.doesNotMatch(service.contextForSession(outsider.id, outsider.session.header.cwd), /Line source rule/)
  assert.match(service.contextForSession(outsider.id, outsider.session.header.cwd), /Platform source rule/)
  await service.openFrame(alice, { address: 'role:analyst', mode: 'reference' })
  const frame = await service.searchFrame(alice, { address: 'role:analyst', query: 'source rule', kind: 'knowledge' })
  assert.equal(frame.sharedKnowledge.length, 2)
  await assert.rejects(() => service.readSharedKnowledge(outsider, acceptedLine.document.id,
    { scope: 'line', line: 'northstar' }), /not visible/)
  assert.equal((await service.decideSharedKnowledgeAsHuman({ proposalId: common.id,
    action: 'accept', decision: 'Approved for platform.', reviewerId: 'platform-admin',
    authorityRef: 'platform.admin:platform-admin' })).idempotentReplay, true)

  const unreviewed = (await service.proposeSharedKnowledge(alice, 'unreviewed-rule', {
    scope: 'line', line: 'northstar', description: 'Unreviewed rule', body: 'Must stay pending.' })).proposal
  await new SharedKnowledgeStore(root).publish({ ...unreviewed.target,
    id: stableId('knowledge', unreviewed.id), description: unreviewed.description,
    body: unreviewed.body, proposalId: unreviewed.id, reviewerId: 'alice',
    authorityRef: 'line.admin:alice', publishedAt: new Date().toISOString() })
  assert.equal((await service.searchSharedKnowledge(alice, 'Unreviewed rule')).count, 0)
  await assert.rejects(() => service.readSharedKnowledge(alice,
    stableId('knowledge', unreviewed.id), unreviewed.target), /not found/)
  await assert.rejects(() => service.decideSharedKnowledgeAsHuman({ proposalId: unreviewed.id,
    action: 'accept', decision: 'Approved.', reviewerId: 'alice',
    authorityRef: 'line.admin:alice' }), /without human review/)
  await rm(join(root, 'lines', 'northstar', 'knowledge', `${stableId('knowledge', unreviewed.id)}.md`))

  const crash = (await service.proposeSharedKnowledge(alice, 'crash-rule', {
    scope: 'line', line: 'northstar', description: 'Recovered rule', body: 'Recover the published rule.' })).proposal
  const reviewedAt = new Date().toISOString()
  await runtime.ledger.putSharedKnowledgeProposal({ ...crash, humanReview: {
    reviewerId: 'alice', authorityRef: 'line.admin:alice', action: 'accept',
    decision: 'Approved.', reviewedAt,
  } })
  await new SharedKnowledgeStore(root).publish({ ...crash.target, id: stableId('knowledge', crash.id),
    description: crash.description, body: crash.body, proposalId: crash.id,
    reviewerId: 'alice', authorityRef: 'line.admin:alice', publishedAt: reviewedAt })
  const reopenedStore = new HomeStore(root)
  await reopenedStore.initialize()
  const resumed = new BizAgentService(reopenedStore, await runtime.reopenLedger(), config, runtime.sessionQuery)
  await resumed.initialize()
  assert.equal(resumed.ledger.getSharedKnowledgeProposal(crash.id).status, 'accepted')
  assert.equal((await resumed.searchSharedKnowledge(alice, 'Recovered rule')).count, 1)
})

test('a hand-edited shared Knowledge document is skipped by search but still refused on read', async t => {
  const root = await makeTempDir('bizagent-shared-skip-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SharedKnowledgeStore(root)
  const publish = async (key, body) => {
    const proposalId = stableId('proposal', key)
    return store.publish({ scope: 'common', id: stableId('knowledge', proposalId), description: key, body,
      proposalId, reviewerId: 'alice', authorityRef: 'platform.admin:alice', publishedAt: new Date().toISOString() })
  }
  const kept = await publish('kept-rule', 'Verify the source first.')
  const edited = await publish('edited-rule', 'Original reviewed text.')
  await writeFile(edited.path, (await readFile(edited.path, 'utf8')).replace('Original', 'Unreviewed'))
  const skipped = []
  const results = await store.search([{ scope: 'common' }], '', path => skipped.push(path))
  assert.deepEqual(results.map(document => document.id), [kept.id])
  assert.deepEqual(skipped, [edited.path])
  await assert.rejects(() => store.read({ scope: 'common' }, edited.id), /integrity mismatch/)
})

test('a pending proposal whose target Home became unavailable does not block startup', async t => {
  const root = await makeTempDir('bizagent-proposal-target-gone-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root, address: 'personal:alice' }], budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:target', owner: 'alice' })
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery)
  await service.initialize()
  const alice = runtime.agent('session-alice', root, 'Propose a rule.')
  const proposed = await service.proposeMemory(alice, 'call-1', {
    toAddress: 'role:target', description: 'Rule', body: 'Exclude refunds from GMV.' })
  assert.equal(proposed.proposal.status, 'pending')
  // The target Home is removed while the proposal is still pending.
  await rm(join(root, 'homes', store.getHome('role:target').id), { recursive: true, force: true })
  const restartedStore = new HomeStore(root)
  await restartedStore.initialize()
  const restarted = new BizAgentService(restartedStore, runtime.ledger, config, runtime.sessionQuery)
  await restarted.initialize()
  assert.equal(restartedStore.hasHome('personal:alice'), true)
})
