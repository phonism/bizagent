import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

test('formal Work keeps one responsibility and one result across retries and ledger reopen', async (t) => {
  const root = await makeTempDir('bizagent-work-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:reviewer' })
  await store.createHome({ address: 'business:unrelated' })
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [
      { root: `${root}/reviewer`, address: 'role:reviewer' },
      { root: `${root}/unrelated`, address: 'business:unrelated' },
    ],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger)
  await service.initialize()
  const alice = runtime.agent('alice-work', root, 'Delegate a review.')
  const reviewer = runtime.agent('reviewer-work', `${root}/reviewer`, 'Review the cohort.')
  const otherReviewerSession = runtime.agent('reviewer-other-work', `${root}/reviewer`, 'A second worker attempt.')
  const unrelated = runtime.agent('other-work', `${root}/unrelated`, 'Do unrelated work.')
  const request = {
    toAddress: 'role:reviewer', goal: 'Review cohort definitions',
    acceptanceCriteria: 'Report source fields and any mismatches.', idempotencyKey: 'cohort-review',
  }

  const originalSend = service.sendInboxMessage.bind(service)
  let failRequestOnce = true
  service.sendInboxMessage = async (...args) => {
    if (failRequestOnce && args[2].kind === 'work-request') {
      failRequestOnce = false
      throw new Error('simulated request transport failure')
    }
    return originalSend(...args)
  }
  await assert.rejects(() => service.dispatchWork(alice, request), /simulated request transport failure/)
  const reserved = runtime.workLedger.list()[0]
  assert.equal(reserved.status, 'open')
  assert.equal(runtime.ledger.getInboxMessage(reserved.requestMessageId), undefined)

  const reopenedWorkLedger = await runtime.reopenWorkLedger()
  const resumed = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, reopenedWorkLedger)
  await resumed.initialize()
  const requestRecovery = await resumed.reconcileWorkNotifications()
  assert.deepEqual(requestRecovery.repaired, [{ workId: reserved.id, phase: 'request' }])
  assert.deepEqual(requestRecovery.failed, [])
  const dispatched = await resumed.dispatchWork(alice, request)
  assert.equal(dispatched.work.id, reserved.id)
  assert.equal(dispatched.notification.message.id, reserved.requestMessageId)
  assert.equal(dispatched.notification.message.kind, 'work-request')
  assert.equal(dispatched.notification.message.returnToSessionId, alice.id)
  assert.equal((await resumed.listWork(reviewer)).works.length, 1)
  assert.equal((await resumed.listWork(alice, { direction: 'requested' })).works.length, 1)
  assert.equal((await resumed.readWork(reviewer, reserved.id)).requestDelivery.status, 'delivered')
  await assert.rejects(() => resumed.readWork(unrelated, reserved.id), /not visible/)
  await assert.rejects(() => resumed.completeWork(reviewer, {
    workId: reserved.id, subject: 'Too early', body: 'Work not claimed.',
  }), /must be accepted/)
  const accepted = await resumed.acceptWork(reviewer, reserved.id)
  assert.equal(accepted.work.status, 'accepted')
  assert.equal(accepted.work.workerSessionId, reviewer.id)
  assert.equal((await resumed.acceptWork(reviewer, reserved.id)).idempotentReplay, true)
  await assert.rejects(() => resumed.acceptWork(otherReviewerSession, reserved.id), /cannot be accepted/)
  await assert.rejects(() => resumed.completeWork(otherReviewerSession, {
    workId: reserved.id, subject: 'Competing worker', body: 'Wrong Session.',
  }), /another worker Session/)
  await assert.rejects(() => resumed.completeWork(alice, {
    workId: reserved.id, subject: 'Fake', body: 'Not the assignee',
  }), /only the Work assignee/)
  await assert.rejects(() => resumed.dispatchWork(alice, { ...request, goal: 'Changed goal' }), /conflicts/)

  const firstResult = {
    workId: reserved.id, subject: 'Cohort review complete', body: 'Fields match the source specification.',
    artifactRefs: ['artifacts/fields.md'],
  }
  await mkdir(join(root, 'reviewer', 'artifacts'), { recursive: true })
  const resultFile = join(root, 'reviewer', 'artifacts', 'fields.md')
  await writeFile(resultFile, 'Original field list\n')
  const resumedSend = resumed.sendInboxMessage.bind(resumed)
  let failResultOnce = true
  resumed.sendInboxMessage = async (...args) => {
    if (failResultOnce && args[2].kind === 'work-result') {
      failResultOnce = false
      throw new Error('simulated result transport failure')
    }
    return resumedSend(...args)
  }
  await assert.rejects(() => resumed.completeWork(reviewer, firstResult), /simulated result transport failure/)
  assert.equal(reopenedWorkLedger.get(reserved.id).status, 'completing')
  assert.equal(reopenedWorkLedger.get(reserved.id).resultBody,
    `Completed Work ${reserved.id}\n\n${firstResult.body}`)
  assert.equal(reopenedWorkLedger.get(reserved.id).resultArtifacts[0].path, 'artifacts/fields.md')
  await writeFile(resultFile, 'Changed TODO after reservation\n')

  const finalLedger = await runtime.reopenWorkLedger()
  const recovered = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, finalLedger)
  await recovered.initialize()
  const resultRecovery = await recovered.reconcileWorkNotifications()
  assert.deepEqual(resultRecovery.repaired, [{ workId: reserved.id, phase: 'result' }])
  assert.deepEqual(resultRecovery.failed, [])
  await assert.rejects(() => recovered.completeWork(otherReviewerSession, {
    workId: reserved.id, subject: 'Competing result', body: 'Should lose.',
  }), /another worker Session/)
  const finished = await recovered.completeWork(reviewer, {
    workId: reserved.id, subject: 'Competing result', body: 'Should lose.',
  })
  assert.equal(finished.work.status, 'completed')
  assert.equal(finished.alreadyCompleted, true)
  assert.equal(finished.work.resultSubject, firstResult.subject)
  assert.equal(Buffer.from((await recovered.readWorkArtifact(alice, {
    workId: reserved.id, path: 'artifacts/fields.md',
  })).contentBase64, 'base64').toString(), 'Original field list\n')
  const outputEvaluation = await recovered.evaluateWorkOutput(alice, reserved.id)
  assert.equal(outputEvaluation.resultMessageId, finished.work.resultMessageId)
  assert.equal(outputEvaluation.sources[0].sha256, finished.work.resultArtifacts[0].sha256)
  assert.deepEqual(outputEvaluation.sources[0].verdicts.map(verdict => verdict.result), ['pass', 'pass'])
  await assert.rejects(() => recovered.evaluateWorkOutput(unrelated, reserved.id), /not visible/)
  await assert.rejects(() => recovered.readWorkArtifact(unrelated, {
    workId: reserved.id, path: 'artifacts/fields.md',
  }), /not visible/)
  const resultMessage = runtime.ledger.getInboxMessage(finished.work.resultMessageId)
  assert.equal(resultMessage.id, finished.work.resultMessageId)
  assert.match(resultMessage.body, /Fields match the source specification/)
  assert.doesNotMatch(resultMessage.body, /Should lose/)
  assert.equal(resultMessage.kind, 'work-result')
  assert.equal((await recovered.readWork(alice, reserved.id)).resultDelivery.status, 'delivered')
  assert.equal((await recovered.completeWork(reviewer, {
    workId: reserved.id, subject: 'Another result', body: 'No second result.',
  })).alreadyCompleted, true)
  assert.equal(runtime.ledger.listInboxMessages().filter(message => message.kind === 'work-result').length, 1)
  assert.equal((await recovered.listInbox(alice)).messages[0].kind, 'work-result')
  assert.equal(runtime.ledger.listProposals().length, 0)

  const cancellable = await recovered.dispatchWork(alice, {
    ...request, goal: 'Review obsolete cohort', idempotencyKey: 'obsolete-review',
  })
  const simultaneousClaims = await Promise.allSettled([
    recovered.acceptWork(reviewer, cancellable.work.id),
    recovered.acceptWork(otherReviewerSession, cancellable.work.id),
  ])
  assert.deepEqual(simultaneousClaims.map(result => result.status), ['fulfilled', 'rejected'])
  assert.equal(finalLedger.get(cancellable.work.id).workerSessionId, reviewer.id)
  await assert.rejects(() => recovered.cancelWork(reviewer, {
    workId: cancellable.work.id, reason: 'Requester should decide.',
  }), /only the Work requester/)
  const finalSend = recovered.sendInboxMessage.bind(recovered)
  let failCancelOnce = true
  recovered.sendInboxMessage = async (...args) => {
    if (failCancelOnce && args[2].kind === 'work-notice') {
      failCancelOnce = false
      throw new Error('simulated cancellation transport failure')
    }
    return finalSend(...args)
  }
  await assert.rejects(() => recovered.cancelWork(alice, {
    workId: cancellable.work.id, reason: 'This cohort is no longer in scope.',
  }), /simulated cancellation transport failure/)
  const cancelRecovery = await recovered.reconcileWorkNotifications()
  assert.deepEqual(cancelRecovery.repaired, [{ workId: cancellable.work.id, phase: 'cancel' }])
  assert.deepEqual(cancelRecovery.failed, [])
  const cancelled = { work: finalLedger.get(cancellable.work.id),
    notification: { message: runtime.ledger.getInboxMessage(finalLedger.get(cancellable.work.id).cancelMessageId) } }
  assert.equal(cancelled.work.status, 'cancelled')
  assert.equal(cancelled.work.workerSessionId, reviewer.id)
  assert.equal(cancelled.notification.message.kind, 'work-notice')
  assert.equal((await recovered.cancelWork(alice, {
    workId: cancellable.work.id, reason: 'Different later reason.',
  })).work.cancelReason, 'This cohort is no longer in scope.')
  await assert.rejects(() => recovered.completeWork(reviewer, {
    workId: cancellable.work.id, subject: 'Too late', body: 'Cancelled.',
  }), /cancelled Work/)
  assert.equal((await recovered.dispatchWork(alice, {
    ...request, goal: 'Review obsolete cohort', idempotencyKey: 'obsolete-review',
  })).notification, undefined)
  assert.deepEqual((await recovered.reconcileWorkNotifications()).repaired, [])
  assert.equal(runtime.ledger.listInboxMessages().filter(message => message.kind === 'work-result').length, 1)
  assert.equal(runtime.ledger.listInboxMessages().filter(message => message.kind === 'work-notice').length, 1)
  await assert.rejects(() => recovered.cancelWork(alice, {
    workId: reserved.id, reason: 'Too late.',
  }), /only be cancelled before result reservation/)
  const bodyOnly = await recovered.dispatchWork(alice, { ...request,
    idempotencyKey: 'metric-body' })
  await recovered.acceptWork(reviewer, bodyOnly.work.id)
  await recovered.completeWork(reviewer, { workId: bodyOnly.work.id,
    subject: 'Metric review', body: 'Everything improved.' })
  await recovered.evaluateWorkOutput(alice, bodyOnly.work.id)
  await writeFile(join(root, 'work-snapshots', 'sha256', finished.work.resultArtifacts[0].sha256), 'Tampered field list\n')
  await assert.rejects(() => recovered.evaluateWorkOutput(alice, reserved.id), /snapshot checksum mismatch/)
})
