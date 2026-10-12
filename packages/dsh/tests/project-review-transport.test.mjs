import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createProjectReviewHttpHandler } from '../lib/project-review-transport.js'
import { ProjectSnapshotStore, WorkSnapshotStore } from '../lib/worklog-snapshot.js'

test('human Project review route uses Host identity, CSRF and current Project grants', async () => {
  let project = { id: 'project-1', lead: 'business:search', status: 'awaiting_acceptance',
    revision: 4, currentClaimId: 'claim-1' }
  let reworkDelivered = false
  const calls = []
  const service = { projectLedger: { get: id => id === project.id ? project : undefined },
    ledger: { getInboxMessage: () => reworkDelivered ? { id: 'notice' } : undefined,
      getInboxDelivery: () => reworkDelivered ? { status: 'delivered' } : undefined },
    async listPendingProjectOutcomeReviewsAsHuman(actor, authorize, offset) {
      return { items: offset === 0 && project.status === 'awaiting_acceptance'
        && await authorize(actor, project) ? [{ projectId: project.id,
          claimId: project.currentClaimId, revision: project.revision }] : [] }
    },
    async reviewProjectAsHuman(actor, input, authorize) {
      calls.push({ actor, input })
      if (!await authorize(actor, project)) throw new Error('Project reviewer is not authorized for the current Project')
      if (project.revision !== input.expectedRevision) throw new Error('Project review revision conflict')
      project = { ...project, revision: project.revision + 1, status: 'accepted' }
      return { project, review: { reviewedByPrincipal: actor, decision: input.decision } }
    } }
  const handler = createProjectReviewHttpHandler(service, {
    authenticateUser: req => req.headers.authorization === 'Bearer alice'
      ? { userId: 'alice' } : null,
    authorizeMutation: req => req.headers['x-csrf'] === 'ok',
    authorizeReview: (principal, current) => principal.userId === 'alice'
      && current.lead === 'business:search',
  })
  const send = async (method, url, body, headers = {}) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    req.method = method
    req.url = url
    req.headers = headers
    const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value },
      end(value) { this.body = JSON.parse(value) } }
    await handler(req, res)
    return res
  }
  const url = '/api/bizagent/project-review'
  const alice = { authorization: 'Bearer alice' }
  const write = { ...alice, 'x-csrf': 'ok', 'content-type': 'application/json' }
  const input = { projectId: 'project-1', claimId: 'claim-1', expectedRevision: 4,
    decision: 'accept', reason: 'The retained result meets the criterion.' }
  assert.equal((await send('GET', `${url}?projectId=project-1`)).statusCode, 401)
  assert.equal((await send('GET', `${url}?inbox=1`)).statusCode, 401)
  assert.equal((await send('POST', url, input, alice)).statusCode, 403)
  assert.equal((await send('POST', url, { ...input, actor: 'admin' }, write)).statusCode, 400)
  assert.deepEqual(calls, [])
  const access = await send('GET', `${url}?projectId=project-1`, undefined, alice)
  assert.equal((await send('GET', `${url}?inbox=1`, undefined, alice)).body.items[0].claimId,
    'claim-1')
  assert.deepEqual((await send('GET', `${url}?inbox=1&offset=1`,
    undefined, alice)).body.items, [])
  assert.equal((await send('GET', `${url}?inbox=1&offset=-1`,
    undefined, alice)).statusCode, 400)
  assert.equal(access.body.canReview, true)
  assert.equal(access.body.revision, 4)
  assert.equal(access.headers['Cache-Control'], 'no-store')
  assert.equal((await send('POST', url, { ...input, expectedRevision: 3 }, write)).body.error.code,
    'revision-conflict')
  const accepted = await send('POST', url, input, write)
  assert.equal(accepted.body.project.status, 'accepted')
  assert.equal(accepted.body.review.reviewedByPrincipal, 'alice')
  assert.equal((await send('GET', `${url}?projectId=project-1`, undefined, alice)).body.canReview, false)
  assert.deepEqual((await send('GET', `${url}?inbox=1`, undefined, alice)).body.items, [])
  project = { ...project, status: 'open', reviews: [{ claimId: 'claim-1', decision: 'rework' }] }
  assert.equal((await send('GET', `${url}?projectId=project-1`, undefined, alice)).body
    .outcomeReworkNotification.state, 'pending')
  reworkDelivered = true
  assert.equal((await send('GET', `${url}?projectId=project-1`, undefined, alice)).body
    .outcomeReworkNotification.state, 'delivered')
  project = { ...project, lead: 'business:other' }
  assert.deepEqual((await send('GET', `${url}?inbox=1`, undefined, alice)).body.items, [])
  assert.equal((await send('GET', `${url}?projectId=project-1`, undefined, alice)).statusCode, 403)
  assert.equal((await send('POST', url, { ...input, expectedRevision: 5 }, write)).statusCode, 403)
})

test('Project review downloads only an authorized, referenced and verified snapshot', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bizagent-review-artifact-')))
  try {
    const bytes = Buffer.from('Submitted result\n')
    const saved = await new ProjectSnapshotStore(root).retain(bytes)
    const workBytes = Buffer.from('Frozen Work result\n')
    const workSaved = await new WorkSnapshotStore(root).retain(workBytes)
    const work = { id: 'work-1', projectId: 'project-1', status: 'completed',
      resultMessageId: 'message-1', resultArtifacts: [{ path: 'artifacts/work.md', ...workSaved }] }
    const project = { id: 'project-1', lead: 'business:search', status: 'awaiting_acceptance',
      revision: 3, currentClaimId: 'claim-1', claims: [{ id: 'claim-1',
        work: [{ id: 'work-1', status: 'completed', resultMessageId: 'message-1' }],
        artifacts: [{ path: 'artifacts/result.md', ...saved }] }] }
    const handler = createProjectReviewHttpHandler({ store: { root },
      projectLedger: { get: () => project }, workLedger: { get: id => id === work.id ? work : undefined } }, {
      authenticateUser: req => req.headers.authorization === 'Bearer alice'
        ? { userId: 'alice' } : null,
      authorizeMutation: () => false,
      authorizeReview: (_principal, current) => current.lead === 'business:search',
    })
    const send = async (path, headers = {}) => {
      const req = Readable.from([])
      req.method = 'GET'
      req.url = path
      req.headers = headers
      const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value },
        end(value) { this.body = value } }
      await handler(req, res)
      return res
    }
    const url = '/api/bizagent/project-review?projectId=project-1&claimId=claim-1&artifactPath=artifacts%2Fresult.md'
    assert.equal((await send(url)).statusCode, 401)
    const allowed = await send(url, { authorization: 'Bearer alice' })
    assert.equal(allowed.statusCode, 200)
    assert.equal(allowed.headers['Content-Type'], 'application/octet-stream')
    assert.equal(allowed.headers['Content-Disposition'], 'attachment; filename="project-artifact"')
    assert.deepEqual(allowed.body, bytes)
    const workUrl = '/api/bizagent/project-review?projectId=project-1&claimId=claim-1&workId=work-1&artifactPath=artifacts%2Fwork.md'
    const workAllowed = await send(workUrl, { authorization: 'Bearer alice' })
    assert.equal(workAllowed.statusCode, 200)
    assert.deepEqual(workAllowed.body, workBytes)
    assert.equal((await send(workUrl.replace('workId=work-1', 'workId=work-2'),
      { authorization: 'Bearer alice' })).statusCode, 404)
    assert.equal((await send(workUrl.replace('work.md', 'other.md'),
      { authorization: 'Bearer alice' })).statusCode, 404)
    assert.equal((await send(url.replace('result.md', 'other.md'),
      { authorization: 'Bearer alice' })).statusCode, 404)
    project.status = 'accepted'
    assert.equal((await send(workUrl, { authorization: 'Bearer alice' })).statusCode, 404)
    project.lead = 'business:other'
    assert.equal((await send(url, { authorization: 'Bearer alice' })).statusCode, 403)
  } finally { await rm(root, { recursive: true, force: true }) }
})
