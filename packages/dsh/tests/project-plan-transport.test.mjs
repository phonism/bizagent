import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createProjectPlanHttpHandler } from '../lib/project-plan-transport.js'

function request(handler, method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = method
  req.url = url
  req.headers = headers
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value },
    end(value) { this.body = JSON.parse(value) } }
  return handler(req, res).then(() => res)
}

test('human Project plan route binds current grant, revisions, and quiet runtime inspection', async () => {
  let project = { id: 'project-1', lead: 'business:search', status: 'open', revision: 3,
    workflow: { revision: 1 }, intervention: undefined }
  let grant = true
  let quiet = false
  const calls = []
  const service = {
    projectLedger: { get: id => id === project.id ? project : undefined },
    async amendProjectWorkflowAsHuman(actor, input, authorize) {
      calls.push({ action: 'amend', actor, input })
      if (!await authorize(actor, project)) throw new Error('Workflow amendment is not authorized for the current Project')
      if (input.expectedProjectRevision !== project.revision) throw new Error('Project or Workflow revision changed')
      project = { ...project, revision: project.revision + 1, workflow: { revision: 2 } }
      return { project, amendment: { byPrincipal: actor } }
    },
    async rebuildProjectWorkflowAsHuman(actor, input, authorize, inspect) {
      calls.push({ action: 'rebuild', actor, input })
      if (!await authorize(actor, project)) throw new Error('Workflow rebuild is not authorized for the current Project')
      if (input.expectedProjectRevision !== project.revision) throw new Error('Project or Workflow revision changed')
      if ((await inspect()).status !== 'quiet') throw new Error('Project execution is unknown')
      project = { ...project, revision: project.revision + 1, workflow: { revision: 3 } }
      return { project, amendment: { byPrincipal: actor, mode: 'rebuild' } }
    },
    async reopenProjectNodeAsHuman(actor, input, authorize) {
      calls.push({ action: 'reopen', actor, input })
      if (!await authorize(actor, project)) throw new Error('Workflow reopen is not authorized for the current Project')
      if (input.expectedRevision !== project.revision) throw new Error('Workflow reopen revision conflict')
      project = { ...project, revision: project.revision + 1 }
      return { project, reopens: [{ reopenedByPrincipal: actor }] }
    },
  }
  const handler = createProjectPlanHttpHandler(service, {
    authenticateUser: req => req.headers.authorization === 'Bearer alice' ? { userId: 'alice' } : null,
    authorizeMutation: req => req.headers['x-csrf'] === 'ok',
    authorizePlan: (principal, current) => grant && principal.userId === 'alice'
      && current.lead === 'business:search',
    inspectRuntime: async () => ({ status: quiet ? 'quiet' : 'unknown', sessionIds: quiet ? [] : ['worker'] }),
  })
  const url = '/api/bizagent/project-plan'
  const alice = { authorization: 'Bearer alice' }
  const write = { ...alice, 'x-csrf': 'ok', 'content-type': 'application/json' }
  const workflow = { summary: 'Collect and review.', steps: [{ id: 'collect', title: 'Collect',
    intent: 'Collect evidence.', executor: 'business:search',
    acceptanceCriteria: 'Return evidence.', after: [] }] }
  const amend = { action: 'amend', projectId: 'project-1', expectedRevision: 3,
    expectedWorkflowRevision: 1, reason: 'Clarify plan.', idempotencyKey: 'amend-1',
    proposalKey: 'proposal-1', workflow }
  assert.equal((await request(handler, 'GET', `${url}?projectId=project-1`)).statusCode, 401)
  assert.equal((await request(handler, 'POST', url, amend, alice)).statusCode, 403)
  assert.equal((await request(handler, 'POST', url, { ...amend, actor: 'admin' }, write)).statusCode, 400)
  assert.deepEqual(calls, [])
  const access = await request(handler, 'GET', `${url}?projectId=project-1`, undefined, alice)
  assert.equal(access.body.canAmend, true)
  assert.equal(access.body.canSetProgression, false)
  assert.equal(access.body.canRebuild, false)
  assert.equal(access.headers['Cache-Control'], 'no-store')
  assert.equal((await request(handler, 'POST', url, { ...amend, expectedRevision: 2 }, write)).body.error.code,
    'revision-conflict')
  grant = false
  assert.equal((await request(handler, 'POST', url, amend, write)).statusCode, 403)
  grant = true
  assert.equal((await request(handler, 'POST', url, amend, write)).body.amendment.byPrincipal, 'alice')
  assert.equal(calls.at(-1).input.proposalKey, 'proposal-1')
  project = { ...project, intervention: { paused: true } }
  const rebuild = { ...amend, action: 'rebuild', expectedRevision: 4,
    expectedWorkflowRevision: 2, idempotencyKey: 'rebuild-1', restartNodeIds: [] }
  assert.equal((await request(handler, 'GET', `${url}?projectId=project-1`, undefined, alice)).body.canRebuild,
    true)
  assert.equal((await request(handler, 'POST', url, rebuild, write)).statusCode, 409)
  quiet = true
  assert.equal((await request(handler, 'POST', url, rebuild, write)).body.amendment.mode, 'rebuild')
  project = { ...project, intervention: { paused: false } }
  const reopen = { action: 'reopen', projectId: 'project-1', expectedRevision: 5,
    nodeId: 'collect', reason: 'Evidence changed.' }
  assert.equal((await request(handler, 'POST', url, reopen, write)).body.reopens[0].reopenedByPrincipal,
    'alice')
  project = { ...project, lead: 'business:other' }
  assert.equal((await request(handler, 'GET', `${url}?projectId=project-1`, undefined, alice)).statusCode, 403)
})

test('human progression route requires current manager grant and rejects stale or forged changes', async () => {
  let project = { id: 'project-progress', lead: 'business:search', status: 'open', revision: 2,
    workflow: { revision: 1, steps: [{ id: 'check', reviewer: 'capability:checker' }] } }
  let grant = true
  const calls = []
  const service = {
    projectLedger: { get: id => id === project.id ? project : undefined },
    async setProjectProgressionAsHuman(actor, input, authorize, authorizeReviewerHome) {
      calls.push({ actor, input })
      if (!await authorize(actor, project)) throw new Error('Project progression is not authorized')
      if (input.expectedRevision !== project.revision) throw new Error('Project progression revision conflict')
      if (!await authorizeReviewerHome(actor, project, input.reviewers[0].reviewerHome,
        input.reviewers[0].nodeId)) throw new Error('Reviewer Home is not authorized')
      project = { ...project, revision: project.revision + 1 }
      return { project, progression: { byPrincipal: actor, mode: input.mode } }
    },
  }
  const handler = createProjectPlanHttpHandler(service, {
    authenticateUser: req => req.headers.authorization === 'Bearer alice' ? { userId: 'alice' } : null,
    authorizeMutation: req => req.headers['x-csrf'] === 'ok',
    authorizePlan: (principal, current) => grant && principal.userId === 'alice'
      && current.lead === 'business:search',
    authorizeReviewerHome: (principal, _current, reviewerHome, nodeId) =>
      principal.userId === 'alice' && reviewerHome === 'capability:checker' && nodeId === 'check',
    inspectRuntime: async () => ({ status: 'quiet', sessionIds: [] }),
  })
  const url = '/api/bizagent/project-plan'
  const auth = { authorization: 'Bearer alice' }
  const write = { ...auth, 'x-csrf': 'ok', 'content-type': 'application/json' }
  const input = { action: 'progression', projectId: project.id, expectedRevision: 2,
    mode: 'reviewed', reviewers: [{ nodeId: 'check', reviewerHome: 'capability:checker' }],
    reason: 'Require review before release.' }
  assert.equal((await request(handler, 'GET', `${url}?projectId=${project.id}`, undefined, auth))
    .body.canSetProgression, true)
  assert.equal((await request(handler, 'POST', url, input, auth)).statusCode, 403)
  assert.equal((await request(handler, 'POST', url, { ...input, actor: 'admin' }, write)).statusCode, 400)
  assert.equal((await request(handler, 'POST', url, { ...input, expectedRevision: 1 }, write))
    .body.error.code, 'revision-conflict')
  grant = false
  assert.equal((await request(handler, 'POST', url, input, write)).statusCode, 403)
  grant = true
  const saved = await request(handler, 'POST', url, input, write)
  assert.equal(saved.body.progression.byPrincipal, 'alice')
  assert.equal(calls.at(-1).input.reviewers[0].reviewerHome, 'capability:checker')
})

test('reviewer reassignment route lists candidates and rechecks actor, target, and revision', async () => {
  let project = { id: 'project-2', lead: 'business:search', status: 'open', revision: 4,
    workflow: { revision: 1, steps: [{ id: 'check', reviewer: 'capability:checker' }] } }
  let managerGrant = true
  let targetGrant = true
  const calls = []
  const service = {
    projectLedger: { get: id => id === project.id ? project : undefined },
    async reassignProjectNodeReviewerAsHuman(actor, input, authorize, authorizeTarget) {
      calls.push({ actor, input })
      if (!await authorize(actor, project)) throw new Error('Workflow reviewer reassignment is not authorized')
      if (input.expectedRevision !== project.revision) throw new Error('Workflow reviewer assignment revision conflict')
      if (!await authorizeTarget(input.assignedPrincipal, project,
        'capability:checker', input.nodeId, input.workId)) {
        throw new Error('Workflow reviewer target is not authorized')
      }
      project = { ...project, revision: project.revision + 1 }
      return { project, assignment: { assignedByPrincipal: actor,
        assignedPrincipal: input.assignedPrincipal } }
    },
  }
  const handler = createProjectPlanHttpHandler(service, {
    authenticateUser: req => req.headers.authorization === 'Bearer manager'
      ? { userId: 'manager' } : null,
    authorizeMutation: req => req.headers['x-csrf'] === 'ok',
    authorizePlan: (principal, current) => managerGrant && principal.userId === 'manager'
      && current.lead === 'business:search',
    inspectRuntime: async () => ({ status: 'quiet', sessionIds: [] }),
    listReviewerCandidates: async (_principal, _project, home, nodeId) => {
      assert.equal(home, 'capability:checker')
      assert.equal(nodeId, 'check')
      return [{ userId: 'bob', name: 'Bob' }]
    },
    authorizeReviewerTarget: (target, _project, home, nodeId, workId) => targetGrant
      && target === 'bob' && home === 'capability:checker'
      && nodeId === 'check' && workId === 'work-1',
  })
  const url = '/api/bizagent/project-plan'
  const auth = { authorization: 'Bearer manager' }
  const write = { ...auth, 'x-csrf': 'ok', 'content-type': 'application/json' }
  const input = { action: 'reassign', projectId: 'project-2', expectedRevision: 4,
    nodeId: 'check', workId: 'work-1', expectedPrincipal: null,
    assignedPrincipal: 'bob', reason: 'Bob is available.' }
  assert.equal((await request(handler, 'GET', `${url}?projectId=project-2&nodeId=check`)).statusCode, 401)
  const access = await request(handler, 'GET', `${url}?projectId=project-2&nodeId=check`,
    undefined, auth)
  assert.equal(access.body.canReassign, true)
  assert.deepEqual(access.body.reviewerCandidates, [{ userId: 'bob', name: 'Bob' }])
  assert.equal((await request(handler, 'GET', `${url}?projectId=project-2&nodeId=missing`,
    undefined, auth)).statusCode, 404)
  assert.equal((await request(handler, 'POST', url, input, auth)).statusCode, 403)
  assert.equal((await request(handler, 'POST', url, { ...input, actor: 'admin' }, write)).statusCode, 400)
  assert.deepEqual(calls, [])
  targetGrant = false
  assert.equal((await request(handler, 'POST', url, input, write)).statusCode, 403)
  targetGrant = true
  managerGrant = false
  assert.equal((await request(handler, 'POST', url, input, write)).statusCode, 403)
  managerGrant = true
  assert.equal((await request(handler, 'POST', url, { ...input, expectedRevision: 3 },
    write)).body.error.code, 'revision-conflict')
  const assigned = await request(handler, 'POST', url, input, write)
  assert.equal(assigned.body.assignment.assignedByPrincipal, 'manager')
  assert.equal(assigned.body.assignment.assignedPrincipal, 'bob')
  assert.equal((await request(handler, 'POST', url, input, write)).body.error.code,
    'revision-conflict')
  project = { ...project, lead: 'business:other' }
  assert.equal((await request(handler, 'GET', `${url}?projectId=project-2`, undefined, auth)).statusCode, 403)
})
