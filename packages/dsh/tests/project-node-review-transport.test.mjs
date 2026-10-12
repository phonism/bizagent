import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createProjectNodeReviewHttpHandler } from '../lib/project-node-review-transport.js'
import { WorkSnapshotStore } from '../lib/worklog-snapshot.js'

function request(handler, method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = method
  req.url = url
  req.headers = headers
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value },
    end(value) { this.body = Buffer.isBuffer(value) ? value : JSON.parse(value) } }
  return handler(req, res).then(() => res)
}

test('human Workflow node route checks Host identity, mutation policy and current reviewer grant', async () => {
  let project = { id: 'project-1', revision: 4, workflow: { steps: [
    { id: 'verify', reviewer: 'capability:checker' }] } }
  let grant = true
  const calls = []
  const service = {
    async listPendingProjectNodeReviewsAsHuman(actor, authorize, offset) {
      if (actor !== 'alice') throw new Error('Workflow reviewer is not authorized')
      const allowed = await authorize(actor, project, 'capability:checker', 'verify')
      return { items: allowed && offset === 0 ? [{ projectId: project.id,
        nodeId: 'verify', workId: 'work-1', revision: project.revision }] : [],
      }
    },
    async readProjectNodeReviewAsHuman(actor, projectId, nodeId, authorize) {
      if (projectId !== project.id || nodeId !== 'verify'
        || !await authorize(actor, project, project.workflow.steps[0].reviewer, nodeId)) {
        throw new Error('Workflow reviewer is not authorized for the current node')
      }
      return { canReview: true, revision: project.revision, workId: 'work-1' }
    },
    async reviewProjectNodeAsHuman(actor, input, authorize) {
      calls.push({ actor, input })
      if (!await authorize(actor, project, project.workflow.steps[0].reviewer, input.nodeId)) {
        throw new Error('Workflow reviewer is not authorized for the current node')
      }
      if (project.revision !== input.expectedRevision) throw new Error('Workflow node review revision conflict')
      project = { ...project, revision: project.revision + 1 }
      return { project, review: { reviewedByPrincipal: actor, decision: input.decision } }
    },
  }
  const handler = createProjectNodeReviewHttpHandler(service, {
    authenticateUser: req => req.headers.authorization === 'Bearer alice' ? { userId: 'alice' } : null,
    authorizeMutation: req => req.headers['x-csrf'] === 'ok',
    authorizeReview: (principal, current, reviewerHome, nodeId) => grant
      && principal.userId === 'alice' && current.id === 'project-1'
      && reviewerHome === 'capability:checker' && nodeId === 'verify',
  })
  const url = '/api/bizagent/project-node-review'
  const alice = { authorization: 'Bearer alice' }
  const write = { ...alice, 'x-csrf': 'ok', 'content-type': 'application/json' }
  const input = { projectId: 'project-1', nodeId: 'verify', workId: 'work-1',
    expectedRevision: 4, decision: 'approve', reason: 'Criteria met.' }
  assert.equal((await request(handler, 'GET', `${url}?projectId=project-1&nodeId=verify`)).statusCode, 401)
  assert.equal((await request(handler, 'GET', `${url}?inbox=1`)).statusCode, 401)
  assert.equal((await request(handler, 'POST', url, input, alice)).statusCode, 403)
  assert.equal((await request(handler, 'POST', url, { ...input, actor: 'admin' }, write)).statusCode, 400)
  assert.deepEqual(calls, [])
  const access = await request(handler, 'GET', `${url}?projectId=project-1&nodeId=verify`, undefined, alice)
  assert.equal((await request(handler, 'GET', `${url}?inbox=1`, undefined, alice)).body.items[0].workId,
    'work-1')
  assert.deepEqual((await request(handler, 'GET', `${url}?inbox=1&offset=1`,
    undefined, alice)).body.items, [])
  assert.equal((await request(handler, 'GET', `${url}?inbox=1&offset=-1`,
    undefined, alice)).statusCode, 400)
  assert.equal(access.body.canReview, true)
  assert.equal(access.body.workId, 'work-1')
  assert.equal(access.headers['Cache-Control'], 'no-store')
  assert.equal((await request(handler, 'POST', url, { ...input, expectedRevision: 3 }, write)).body.error.code,
    'revision-conflict')
  grant = false
  assert.deepEqual((await request(handler, 'GET', `${url}?inbox=1`,
    undefined, alice)).body.items, [])
  assert.equal((await request(handler, 'POST', url, input, write)).statusCode, 403)
  grant = true
  const approved = await request(handler, 'POST', url, input, write)
  assert.equal(approved.body.review.reviewedByPrincipal, 'alice')
  project = { ...project, workflow: { steps: [{ id: 'verify', reviewer: 'capability:other' }] } }
  assert.equal((await request(handler, 'GET', `${url}?projectId=project-1&nodeId=verify`,
    undefined, alice)).statusCode, 403)
})

test('Workflow node route serves only current authorized Work artifact snapshots', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bizagent-node-review-')))
  try {
    const bytes = Buffer.from('Frozen node result\n')
    const saved = await new WorkSnapshotStore(root).retain(bytes)
    let grant = true
    let current = true
    const project = { id: 'project-1', revision: 2 }
    const handler = createProjectNodeReviewHttpHandler({ store: { root },
      async readProjectNodeReviewAsHuman(actor, projectId, nodeId, authorize) {
        if (!await authorize(actor, project, 'capability:checker', nodeId)) {
          throw new Error('Workflow reviewer is not authorized for the current node')
        }
        return { canReview: current, revision: project.revision,
          workId: current ? 'work-1' : null, work: { resultArtifacts: [
            { path: 'artifacts/result.md', ...saved }] } }
      },
    }, {
      authenticateUser: req => req.headers.authorization === 'Bearer alice' ? { userId: 'alice' } : null,
      authorizeMutation: () => false,
      authorizeReview: (_principal, _project, reviewerHome) => grant
        && reviewerHome === 'capability:checker',
    })
    const url = '/api/bizagent/project-node-review?projectId=project-1&nodeId=verify&workId=work-1&artifactPath=artifacts%2Fresult.md'
    assert.equal((await request(handler, 'GET', url)).statusCode, 401)
    const alice = { authorization: 'Bearer alice' }
    const allowed = await request(handler, 'GET', url, undefined, alice)
    assert.equal(allowed.statusCode, 200)
    assert.deepEqual(allowed.body, bytes)
    assert.equal((await request(handler, 'GET', url.replace('work-1', 'work-2'),
      undefined, alice)).statusCode, 404)
    current = false
    assert.equal((await request(handler, 'GET', url, undefined, alice)).statusCode, 404)
    grant = false
    assert.equal((await request(handler, 'GET', url, undefined, alice)).statusCode, 403)
  } finally { await rm(root, { recursive: true, force: true }) }
})
