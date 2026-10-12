import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { createDemoRuntime } from './demo-runtime.mjs'
import { scenarios } from './scenarios.mjs'

const requested = process.argv[2] ?? 'all'
const selected = scenarios.filter(scenario => requested === 'all' || scenario.id === requested)
if (selected.length === 0 || process.argv.length > 3) {
  process.stderr.write('Usage: node examples/learning-lab.mjs [all|growth|engineering|support]\n')
  process.exitCode = 1
} else {
  for (const scenario of selected) await runScenario(scenario)
  process.stdout.write(`Learning lab passed: ${selected.length} scenarios. Temporary data removed.\n`)
}

async function runScenario(scenario) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'bizagent-learning-lab-'))
  const runtime = await createDemoRuntime()
  try {
    const store = new HomeStore(root)
    await store.initialize()
    await store.createHome({ address: scenario.author })
    await store.createHome({ address: scenario.owner })
    const ownerCwd = join(root, 'owner-work')
    const service = new BizAgentService(store, runtime.ledger, {
      homeRoot: root,
      defaultHome: scenario.author,
      autoCreateDefaultHome: false,
      workspaceHomes: [{ root: ownerCwd, address: scenario.owner }],
      budget: { identityMaxBytes: 1024, indexMaxBytes: 4096 },
      learningCheckpointEnabled: false,
    }, runtime.sessionQuery, undefined, undefined, runtime.workLedger, runtime.projectLedger, runtime.worklogLedger)
    await service.initialize()
    const author = runtime.agent(`${scenario.id}-author`, root, scenario.observation)
    const initialRevision = store.getHome(scenario.author).revision

    process.stdout.write(`\n[${scenario.id}] ${scenario.name}\n`)
    const draft = await service.remember(author, `${scenario.id}-draft`, {
      kind: scenario.kind, status: 'candidate',
      description: scenario.description, body: scenario.draft, tags: [scenario.id],
    })
    assert.equal((await service.searchMemory(author, {})).count, 0)
    assert.equal((await service.searchMemory(author, { status: 'candidate' })).count, 1)
    assert.equal(store.getHome(scenario.author).revision, initialRevision)
    const evidence = await service.readEvidence(author, { assetId: draft.asset.id })
    assert.equal(evidence.events[0].text, scenario.observation)
    process.stdout.write('  1. Candidate saved; default search excludes it; source evidence is readable.\n')

    const reviewed = await service.updateMemory(author, {
      assetId: draft.asset.id, action: 'revise', expectedRevision: draft.asset.revision,
      body: scenario.reviewed,
    })
    assert.equal(reviewed.asset.status, 'candidate')
    await assert.rejects(() => service.updateMemory(author, {
      assetId: draft.asset.id, action: 'publish', expectedRevision: draft.asset.revision,
    }), /revision conflict/)
    const read = await service.readMemory(author, `${scenario.id}-read`, draft.asset.id)
    const published = await service.updateMemory(author, {
      assetId: read.asset.id, action: 'publish', expectedRevision: read.asset.revision,
    })
    assert.equal(published.asset.status, 'active')
    assert.equal(published.home.revision, initialRevision + 1)
    process.stdout.write('  2. Stale publication rejected; the reviewed revision is now active.\n')

    const proposed = await service.proposeMemory(author, `${scenario.id}-proposal`, {
      toAddress: scenario.owner, proposedKind: scenario.kind,
      description: scenario.description, body: scenario.reviewed, tags: [scenario.id],
    })
    assert.equal(store.listAssets(scenario.owner).length, 0)
    await assert.rejects(() => service.acceptProposal(author, {
      proposalId: proposed.proposal.id,
    }), /host-authenticated human review/)
    const owner = runtime.agent(`${scenario.id}-owner`, ownerCwd, 'Review the scope and evidence of the demo proposal.')
    await assert.rejects(() => service.acceptProposal(owner, {
      proposalId: proposed.proposal.id,
    }), /host-authenticated human review/)
    const humanDecision = { ownerAddress: scenario.owner, proposalId: proposed.proposal.id,
      action: 'accept', reviewerId: 'demo-reviewer', authorityRef: 'demo-host:scenario-owner',
      decision: 'Reviewed against the fictional scenario and its stated scope.' }
    const accepted = await service.decideProposalAsHuman(humanDecision)
    const replay = await service.decideProposalAsHuman(humanDecision)
    assert.equal(replay.idempotentReplay, true)
    assert.equal(store.listAssets(scenario.owner).length, 1)
    process.stdout.write('  3. Agents cannot approve; a host-authenticated human accepts; replay creates no duplicate.\n')

    const frame = await service.openFrame(author, { address: scenario.owner, mode: 'contribute' })
    assert.equal(frame.state.primaryHome, scenario.author)
    assert.ok(frame.context.includes(scenario.description))
    const frameHits = await service.searchFrame(author, { query: scenario.description })
    assert.deepEqual(frameHits.assets.map(item => item.id), [accepted.asset.id])
    assert.equal((await service.readFrame(author, `${scenario.id}-frame-read`, {
      assetId: accepted.asset.id,
    })).asset.id, accepted.asset.id)
    const reopenedFrameLedger = await runtime.reopenLedger()
    assert.equal(reopenedFrameLedger.getFrameState(author.id).focusAddress, scenario.owner)
    await reopenedFrameLedger.close()
    await service.closeFrame(author)
    assert.equal((await service.frameStatus(author)).state.frames.length, 0)
    process.stdout.write('  4. A read-only Agent Frame reuses the target index without changing the author Home.\n')

    const future = runtime.agent(`${scenario.id}-future`, ownerCwd, 'Use the reviewed demo asset in a subsequent task.')
    const snapshot = service.contextForSession(future.id, ownerCwd)
    assert.ok(snapshot.includes(scenario.description))
    assert.ok(!snapshot.includes(scenario.reviewed))
    await service.readMemory(future, `${scenario.id}-future-read`, accepted.asset.id)
    const applied = await service.feedback(future, `${scenario.id}-applied`, {
      assetId: accepted.asset.id, signal: 'applied',
    })
    assert.equal(applied.asset.fitness, 0)
    const confirmed = await service.feedback(future, `${scenario.id}-confirmed`, {
      assetId: accepted.asset.id, signal: 'confirmed', outcome: scenario.confirmation,
    })
    assert.equal(confirmed.asset.fitness, 0.2)
    await service.feedback(future, `${scenario.id}-contradicted`, {
      assetId: accepted.asset.id, signal: 'contradicted', outcome: scenario.contradiction,
    })
    const failed = await service.feedback(future, `${scenario.id}-failed`, {
      assetId: accepted.asset.id, signal: 'failed', outcome: scenario.failure,
    })
    assert.equal(failed.reviewRequired, true)
    assert.equal(failed.asset.status, 'active')
    await service.updateMemory(future, {
      assetId: accepted.asset.id, action: 'retire', expectedRevision: failed.asset.revision,
    })
    assert.equal((await service.searchMemory(future, {})).count, 0)
    process.stdout.write('  5. Future context contains only the index; feedback requests review; owner retires the asset.\n')

    // Reload actual Markdown files; the demo ledger itself is intentionally ephemeral.
    const reloaded = new HomeStore(root)
    await reloaded.initialize()
    assert.equal(reloaded.readAsset(scenario.owner, accepted.asset.id).status, 'retired')
    assert.equal(reloaded.readAsset(scenario.author, published.asset.id).status, 'active')
    assert.deepEqual((await reloaded.doctor()).issues, [])
    process.stdout.write('  6. Home files reload correctly; retirement does not alter the author\'s copy.\n')

    const learningAgent = runtime.agent(`${scenario.id}-learning`, root, 'Review earlier work for useful experience.')
    const materials = await service.scanLearningMaterials(learningAgent)
    assert.deepEqual(materials.materials.map(item => item.sessionId), [author.id])
    const reviewedMaterial = materials.materials[0]
    await service.readEpisode(learningAgent, { sessionId: author.id })
    await service.reviewLearningMaterial(learningAgent, {
      materialId: reviewedMaterial.id,
      summary: 'The earlier observation was checked; its reviewed asset already captures the reusable part.',
    })
    const resumedLedger = await runtime.reopenLedger()
    assert.equal(resumedLedger.getMaterialReview(reviewedMaterial.id).materialId, reviewedMaterial.id)
    await resumedLedger.close()
    assert.equal((await service.scanLearningMaterials(learningAgent)).materials.length, 0)
    author.session.events.push({
      seq: 2, time: 3, type: 'user/message',
      data: { content: [{ type: 'text', text: 'A later result changes the interpretation of the earlier work.' }] },
    })
    const changed = await service.scanLearningMaterials(learningAgent)
    assert.equal(changed.materials.length, 1)
    assert.notEqual(changed.materials[0].fingerprint, reviewedMaterial.fingerprint)
    process.stdout.write('  7. Review progress is explicit; later Session changes remain pending after a ledger reopen.\n')

    const message = await service.sendInboxMessage(author, `${scenario.id}-inbox-send`, {
      to: [scenario.owner], subject: 'Review the later result',
      body: 'A later observation may change how we use the earlier asset.',
      idempotencyKey: `${scenario.id}-later-result`,
    })
    assert.equal(message.deliveries[0].status, 'delivered')
    const inboxLedger = await runtime.reopenLedger()
    assert.equal(inboxLedger.getInboxMessage(message.message.id).returnToSessionId, author.id)
    assert.equal(inboxLedger.getInboxDelivery(message.message.id, scenario.owner).status, 'delivered')
    await inboxLedger.close()
    assert.equal((await service.listInbox(future, { pendingOnly: true })).messages.length, 1)
    assert.equal((await service.readInboxMessage(future, message.message.id)).message.body,
      'A later observation may change how we use the earlier asset.')
    await service.handleInboxMessage(future, message.message.id)
    const reply = await service.sendInboxMessage(future, `${scenario.id}-inbox-reply`, {
      to: [scenario.author], subject: 'Re: Review the later result',
      body: 'I will review the new evidence before changing the method.', replyTo: message.message.id,
    })
    assert.equal(reply.message.rootId, message.message.id)
    assert.equal((await service.listInbox(future, { pendingOnly: true })).messages.length, 0)
    assert.equal((await service.listInbox(author)).messages[0].id, reply.message.id)
    process.stdout.write('  8. Inbox delivery, reply, and handling survive a ledger reopen without changing Work or Memory.\n')

    const project = await service.createProject(author, {
      title: `${scenario.name} evidence review`,
      goal: 'Decide how the later observation affects the earlier result.',
      doneWhen: 'The formal review is returned and the final conclusion is recorded.',
      idempotencyKey: `${scenario.id}-review-project`,
    })
    const assignment = await service.dispatchWork(author, {
      toAddress: scenario.owner,
      goal: `Review the later ${scenario.id} result`,
      acceptanceCriteria: 'Return a concrete conclusion tied to the later observation.',
      idempotencyKey: `${scenario.id}-formal-review`,
      projectId: project.project.id,
    })
    assert.equal(assignment.work.status, 'open')
    assert.equal(assignment.notification.message.kind, 'work-request')
    const workReopened = await runtime.reopenWorkLedger()
    assert.equal(workReopened.get(assignment.work.id).requestMessageId, assignment.notification.message.id)
    await workReopened.close()
    const acceptedWork = await service.acceptWork(future, assignment.work.id)
    assert.equal(acceptedWork.work.workerSessionId, future.id)
    const result = await service.completeWork(future, {
      workId: assignment.work.id,
      subject: `Reviewed ${scenario.id} result`,
      body: 'The later observation needs a fresh evidence check before reuse.',
    })
    assert.equal(result.work.status, 'completed')
    assert.equal(result.notification.message.kind, 'work-result')
    assert.equal((await service.readWork(author, assignment.work.id)).resultDelivery.status, 'delivered')
    assert.equal((await service.completeWork(future, {
      workId: assignment.work.id, subject: 'Another result', body: 'Should not replace the first.',
    })).alreadyCompleted, true)
    process.stdout.write('  9. Formal Work binds one worker Session and one returned result beyond ordinary Inbox replies.\n')

    const submittedProject = await service.submitProject(author, {
      projectId: project.project.id,
      summary: 'Evidence review complete',
      body: 'The later observation calls for a fresh evidence check before reuse.',
      doneWhenAssessment: 'The formal review was delivered and the conclusion is recorded.',
    })
    const reviewedProject = await service.reviewProject(author, {
      projectId: project.project.id, claimId: submittedProject.claim.id,
      decision: 'accept', reason: 'The stated completion standard is met in this fictional scenario.',
    })
    assert.equal(reviewedProject.project.status, 'accepted')
    const projectReopened = await runtime.reopenProjectLedger()
    assert.equal(projectReopened.get(project.project.id).acceptedClaimId, submittedProject.claim.id)
    await projectReopened.close()
    process.stdout.write('  10. Project submission records linked Work and an exact owner review across ledger reopen.\n')

    await mkdir(ownerCwd, { recursive: true })
    await writeFile(join(ownerCwd, 'review.txt'), 'The later observation needs a fresh evidence check before reuse.\n')
    const worklog = (await service.recordWorklog(future, {
      description: 'Evidence review completed',
      body: 'The formal review found that the later observation needs a fresh evidence check.',
      status: 'completed', idempotencyKey: `${scenario.id}-worklog-v1`,
      files: ['review.txt'], workId: assignment.work.id, projectId: project.project.id,
    })).worklog
    assert.equal((await service.searchWorklogs(future, { query: 'review.txt' })).worklogs[0].id, worklog.id)
    const worklogRead = await service.readWorklog(future, { sessionId: future.id })
    assert.equal(worklogRead.source.status, 'verified')
    assert.equal(worklogRead.files[0].status, 'current')
    const worklogReopened = await runtime.reopenWorklogLedger()
    assert.equal(worklogReopened.listVersions(future.id)[0].workId, assignment.work.id)
    await worklogReopened.close()
    process.stdout.write('  11. Session Worklog links formal Work, verifies source events, and tracks a Workspace file.\n')
  } finally {
    await runtime.ledger.close()
    await runtime.workLedger.close()
    await runtime.projectLedger.close()
    await runtime.worklogLedger.close()
    await rm(root, { recursive: true, force: true })
  }
}
