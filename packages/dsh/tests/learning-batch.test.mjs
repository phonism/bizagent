import assert from 'node:assert/strict'
import { rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

function config(root) {
  return { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [], budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
}

test('learning batch freezes sources, creates only candidates with original evidence, and survives ledger reopen', async t => {
  const root = await makeTempDir('bizagent-learning-batch-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  const first = runtime.agent('source-1', root, 'Use signup date for this cohort.')
  const second = runtime.agent('source-2', root, 'The deployment needs a manual check.')
  await runtime.ledger.putBinding({ sessionId: first.id, homeAddress: 'personal:alice', boundAt: '2026-01-01T00:00:00Z' })
  await runtime.ledger.putBinding({ sessionId: second.id, homeAddress: 'personal:alice', boundAt: '2026-01-02T00:00:00Z' })
  await store.createAsset({ id: 'existing-rule', ownerAddress: 'personal:alice', kind: 'memory',
    description: 'Existing rule', body: 'Old cohort rule.', status: 'candidate',
    sourceRefs: [{ type: 'session-events', sessionId: first.id, fromSeq: 1, toSeq: 1 }] })
  const reviewer = runtime.agent('reviewer', root, 'Review earlier work.')
  const other = runtime.agent('other', root, 'Concurrent work.')
  const service = new BizAgentService(store, runtime.ledger, config(root), runtime.sessionQuery)
  const started = await service.startLearningBatch(reviewer, 'start-call')
  assert.equal(started.started, true)
  assert.deepEqual(started.materials.map(item => item.sessionId), ['source-2', 'source-1'])
  await assert.rejects(() => service.reviewLearningMaterial(other, {
    materialId: started.materials[0].id, summary: 'Bypass the batch.',
  }), /reserved by open batch/)
  assert.deepEqual((await service.startLearningBatch(reviewer, 'start-call')).run, started.run)
  await assert.rejects(() => service.startLearningBatch(other, 'second-call'), /already has an open/)
  await assert.rejects(() => service.finishLearningBatch(reviewer, {
    runId: started.run.id, action: 'complete', summary: 'Finished.',
  }), /unreviewed materials/)

  const material = started.materials.find(item => item.sessionId === 'source-1')
  const settled = await service.settleLearningBatchMaterial(reviewer, {
    runId: started.run.id, materialId: material.id, summary: 'Keep this as a candidate until checked.',
    candidates: [{ kind: 'knowledge', description: 'Cohort date rule to verify',
      body: 'Use signup date for the cohort.', fromSeq: 1, toSeq: 1 }],
  })
  assert.equal(settled.review.assetIds.length, 1)
  const asset = store.readAsset('personal:alice', settled.review.assetIds[0])
  assert.equal(asset.status, 'candidate')
  assert.equal(asset.sourceRefs[0].sessionId, 'source-1')
  assert.deepEqual([asset.sourceRefs[0].fromSeq, asset.sourceRefs[0].toSeq], [1, 1])
  assert.equal(store.searchAssets('personal:alice').length, 0)
  assert.match((await service.readEvidence(reviewer, { assetId: asset.id })).events[0].text,
    /signup date/)
  assert.equal((await service.settleLearningBatchMaterial(reviewer, {
    runId: started.run.id, materialId: material.id, summary: 'Duplicate response.', candidates: [],
  })).idempotentReplay, true)
  await assert.rejects(() => service.settleLearningBatchMaterial(other, {
    runId: started.run.id, materialId: started.materials[0].id, summary: 'Wrong reviewer.',
  }), /not owned by this Home and Session/)

  const reopened = new BizAgentService(store, await runtime.reopenLedger(), config(root), runtime.sessionQuery)
  assert.deepEqual((await reopened.learningBatchStatus(reviewer, started.run.id)).pendingMaterialIds,
    [started.materials[0].id])
  assert.deepEqual((await reopened.learningBatchStatus(reviewer, started.run.id)).materials.map(item => item.sessionId),
    ['source-2', 'source-1'])
  await reopened.settleLearningBatchMaterial(reviewer, {
    runId: started.run.id, materialId: started.materials[0].id,
    summary: 'No durable rule from this deployment note.', candidates: [],
  })
  await store.updateAsset('personal:alice', 'existing-rule', { expectedRevision: 1,
    body: 'Revised cohort rule.' })
  const completed = await reopened.finishLearningBatch(reviewer, {
    runId: started.run.id, action: 'complete', summary: 'Reviewed both sources.',
  })
  assert.equal(completed.run.status, 'completed')
  assert.equal(completed.pendingMaterialIds.length, 0)
  const updated = completed.run.libraryChanges.find(item => item.path.endsWith('/memory/existing-rule.md'))
  const created = completed.run.libraryChanges.find(item => item.path.endsWith(`/${asset.id}.md`))
  assert.equal(updated.result, 'updated')
  assert.equal(created.result, 'created')
  const before = await reopened.readLearningBatchChange(reviewer, {
    runId: started.run.id, path: updated.path, side: 'before',
  })
  const after = await reopened.readLearningBatchChange(reviewer, {
    runId: started.run.id, path: updated.path, side: 'after',
  })
  assert.match(Buffer.from(before.contentBase64, 'base64').toString(), /Old cohort rule/)
  assert.match(Buffer.from(after.contentBase64, 'base64').toString(), /Revised cohort rule/)
  await assert.rejects(() => reopened.readLearningBatchChange(reviewer, {
    runId: started.run.id, path: created.path, side: 'before',
  }), /not available/)
  const future = runtime.agent('future', root, 'Check new learning material.')
  const scan = await reopened.scanLearningMaterials(future)
  assert.equal(scan.materials.some(item => item.sessionId === 'reviewer'), false)
  assert.deepEqual(scan.materials.map(item => item.sessionId), ['other'])
})

test('changed source cannot settle a frozen batch; abandonment leaves new version discoverable', async t => {
  const root = await makeTempDir('bizagent-learning-batch-changed-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  runtime.agent('source', root, 'Original fact.')
  await runtime.ledger.putBinding({ sessionId: 'source', homeAddress: 'personal:alice', boundAt: '2026-01-01T00:00:00Z' })
  const reviewer = runtime.agent('reviewer', root, 'Review sources.')
  const service = new BizAgentService(store, runtime.ledger, config(root), runtime.sessionQuery)
  const started = await service.startLearningBatch(reviewer, 'first')
  runtime.agent('source', root, 'Corrected fact.')
  await assert.rejects(() => service.settleLearningBatchMaterial(reviewer, {
    runId: started.run.id, materialId: started.materials[0].id, summary: 'Use corrected fact.',
    candidates: [{ kind: 'memory', description: 'Corrected fact', body: 'Corrected fact.', fromSeq: 1, toSeq: 1 }],
  }), /changed since the batch was frozen/)
  assert.equal(store.searchAssets('personal:alice', { status: 'candidate' }).length, 0)
  const replacement = runtime.agent('replacement', root, 'Recovery review.')
  const abandoned = await service.finishLearningBatch(replacement, {
    runId: started.run.id, action: 'abandon', summary: 'Source changed; review a fresh observation.',
  })
  assert.equal(abandoned.run.status, 'abandoned')
  const next = await service.startLearningBatch(replacement, 'second')
  assert.equal(next.materials[0].sessionId, 'source')
  assert.notEqual(next.materials[0].id, started.materials[0].id)
})

test('authored Worklog is independent learning material with exact revision evidence', async t => {
  const root = await makeTempDir('bizagent-learning-worklog-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'personal:bob' })
  const runtime = await createDemoRuntime()
  const author = runtime.agent('worklog-author', root, 'Check cohort attribution.')
  const reviewer = runtime.agent('worklog-reviewer', root, 'Review work.')
  const bob = runtime.agent('worklog-bob', root, 'Private review.')
  await runtime.ledger.putBinding({ sessionId: author.id, homeAddress: 'personal:alice',
    cwd: root, boundAt: '2026-01-01T00:00:00Z' })
  await runtime.ledger.putBinding({ sessionId: bob.id, homeAddress: 'personal:bob',
    cwd: root, boundAt: '2026-01-01T00:00:00Z' })
  let sourceUnavailable = false
  const query = { async readSession(id) {
    if (sourceUnavailable && String(id) === author.id) throw new Error('source Session offline')
    return runtime.sessionQuery.readSession(id)
  } }
  const service = new BizAgentService(store, runtime.ledger, config(root), query,
    undefined, undefined, runtime.workLedger, runtime.projectLedger, runtime.worklogLedger)
  const first = (await service.recordWorklog(author, {
    description: 'Cohort attribution checked',
    body: 'The signup-date rule needs confirmation from the data owner.',
    status: 'completed', idempotencyKey: 'cohort-v1',
  })).worklog
  sourceUnavailable = true
  const started = await service.startLearningBatch(reviewer, 'worklog-batch')
  assert.equal(started.materials.length, 1)
  const material = started.materials[0]
  assert.equal(material.sourceKind, 'worklog')
  assert.equal(material.worklogRevisionId, first.id)
  assert.equal(material.worklogRevision, first.revision)
  await assert.rejects(() => service.settleLearningBatchMaterial(reviewer, {
    runId: started.run.id, materialId: material.id, summary: 'Wrong source shape.',
    candidates: [{ kind: 'memory', description: 'Candidate', body: 'Body', fromSeq: 1, toSeq: 1 }],
  }), /without event sequence fields/)
  const settled = await service.settleLearningBatchMaterial(reviewer, {
    runId: started.run.id, materialId: material.id,
    summary: 'Retain as a candidate pending data-owner confirmation.',
    candidates: [{ kind: 'knowledge', description: 'Cohort attribution rule to verify',
      body: 'Confirm signup-date attribution with the data owner.' }],
  })
  const asset = store.readAsset('personal:alice', settled.review.assetIds[0])
  assert.equal(asset.status, 'candidate')
  assert.equal(asset.sourceRefs[0].type, 'worklog')
  assert.equal(asset.sourceRefs[0].revisionId, first.id)
  const offline = await service.readEvidence(reviewer, { assetId: asset.id })
  assert.equal(offline.source.status, 'unavailable')
  assert.equal(offline.worklog.body, first.body)
  await assert.rejects(() => service.readEvidence(bob, { assetId: asset.id }), /not found/)
  sourceUnavailable = false
  assert.equal((await service.readEvidence(reviewer, { assetId: asset.id })).source.status, 'verified')
  await service.finishLearningBatch(reviewer, { runId: started.run.id,
    action: 'complete', summary: 'Reviewed the authored Worklog.' })
  const second = (await service.recordWorklog(author, {
    description: 'Cohort attribution confirmed', body: 'The data owner confirmed signup-date attribution.',
    status: 'completed', idempotencyKey: 'cohort-v2',
  })).worklog
  const reopened = new BizAgentService(store, await runtime.reopenLedger(), config(root), query,
    undefined, undefined, runtime.workLedger, runtime.projectLedger, await runtime.reopenWorklogLedger())
  const scan = await reopened.scanLearningMaterials(reviewer)
  assert.ok(scan.materials.some(item => item.sourceKind === 'worklog'
    && item.worklogRevisionId === second.id && item.id !== material.id))
  await reopened.worklogLedger.close()
  await service.close()
})

test('learning batch completion reports an unavailable file snapshot without trapping the batch open', async t => {
  const root = await makeTempDir('bizagent-learning-large-file-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  const source = runtime.agent('large-source', root, 'Review this result.')
  const reviewer = runtime.agent('large-reviewer', root, 'Review the source.')
  await runtime.ledger.putBinding({ sessionId: source.id, homeAddress: 'personal:alice',
    boundAt: '2026-01-01T00:00:00Z' })
  const service = new BizAgentService(store, runtime.ledger, config(root), runtime.sessionQuery)
  const started = await service.startLearningBatch(reviewer, 'large-batch')
  await store.createAsset({ id: 'large-note', ownerAddress: 'personal:alice', kind: 'memory',
    description: 'Oversized file', body: 'x'.repeat(8 * 1024 * 1024 + 1), status: 'candidate',
    sourceRefs: [{ type: 'session-events', sessionId: source.id, fromSeq: 1, toSeq: 1 }] })
  for (const material of started.materials) {
    await service.settleLearningBatchMaterial(reviewer, { runId: started.run.id,
      materialId: material.id, summary: 'No new candidate.', candidates: [] })
  }
  const finished = await service.finishLearningBatch(reviewer, { runId: started.run.id,
    action: 'complete', summary: 'Review completed; file snapshot unavailable.' })
  assert.equal(finished.run.status, 'completed')
  assert.match(finished.run.libraryChangeError, /under 8 MiB/)
  assert.equal(finished.run.libraryChanges, undefined)
})

test('a source Session that only grew after freezing still settles against its frozen prefix', async t => {
  const root = await makeTempDir('bizagent-learning-batch-grew-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  const source = runtime.agent('source', root, 'Original fact.')
  await runtime.ledger.putBinding({ sessionId: 'source', homeAddress: 'personal:alice', boundAt: '2026-01-01T00:00:00Z' })
  const reviewer = runtime.agent('reviewer', root, 'Review sources.')
  const service = new BizAgentService(store, runtime.ledger, config(root), runtime.sessionQuery)
  const started = await service.startLearningBatch(reviewer, 'first')
  const frozenCount = started.materials[0].eventCount
  // The user keeps talking in the source Session after the batch froze it.
  const events = source.session.events
  events.push({ seq: events.length, time: Date.now(), type: 'user/message',
    data: { content: [{ type: 'text', text: 'A later message.' }] } })
  await assert.rejects(() => service.settleLearningBatchMaterial(reviewer, {
    runId: started.run.id, materialId: started.materials[0].id, summary: 'Cite the later message.',
    candidates: [{ kind: 'memory', description: 'Later', body: 'Later message.', fromSeq: frozenCount, toSeq: frozenCount }],
  }), /source event range is incomplete/)
  const settled = await service.settleLearningBatchMaterial(reviewer, {
    runId: started.run.id, materialId: started.materials[0].id, summary: 'Keep the original fact.',
    candidates: [{ kind: 'memory', description: 'Original fact', body: 'Original fact.', fromSeq: 1, toSeq: 1 }],
  })
  assert.equal(settled.review.assetIds.length, 1)
  const finished = await service.finishLearningBatch(reviewer, { runId: started.run.id, action: 'complete', summary: 'Done.' })
  assert.equal(finished.run.status, 'completed')
})

test('a Home whose learning files cannot be snapshotted can still start and finish a batch', async t => {
  const root = await makeTempDir('bizagent-learning-batch-snapshot-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  runtime.agent('source', root, 'Original fact.')
  await runtime.ledger.putBinding({ sessionId: 'source', homeAddress: 'personal:alice', boundAt: '2026-01-01T00:00:00Z' })
  const retired = await store.createAsset({ id: 'retired-rule', ownerAddress: 'personal:alice', kind: 'memory',
    description: 'Old rule', body: 'No longer used.', status: 'retired',
    sourceRefs: [{ type: 'session-events', sessionId: 'source', fromSeq: 1, toSeq: 1 }] })
  const reviewer = runtime.agent('reviewer', root, 'Review sources.')
  const service = new BizAgentService(store, runtime.ledger, config(root), runtime.sessionQuery)
  const first = await service.startLearningBatch(reviewer, 'first')
  // Retired assets are not part of the learning library snapshot.
  assert.ok(first.run.libraryBefore.every(file => !file.path.endsWith(`${retired.id}.md`)))
  await service.finishLearningBatch(reviewer, { runId: first.run.id, action: 'abandon', summary: 'Restart.' })

  // Make the snapshot impossible: identity.md now escapes the Home root through a symlink.
  const identity = join(root, 'homes', store.getHome('personal:alice').id, 'identity.md')
  await writeFile(join(root, 'outside-identity.md'), 'Outside.\n')
  await rm(identity)
  await symlink(join(root, 'outside-identity.md'), identity)
  const second = await service.startLearningBatch(reviewer, 'second')
  assert.equal(second.started, true)
  assert.equal(second.run.libraryBefore, undefined)
  assert.ok(service.listRuntimeIssues().some(issue => issue.message.startsWith('learning library snapshot for personal:alice')))
})
