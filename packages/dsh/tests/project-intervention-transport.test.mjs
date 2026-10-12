import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createProjectInterventionHttpHandler } from '../lib/project-intervention-transport.js'

function request(handler, method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  req.method = method
  req.url = url
  req.headers = headers
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value },
    end(value) { this.body = JSON.parse(value) } }
  return handler(req, res).then(() => res)
}

test('human Project intervention route rechecks Host grant and retries a paused cleanup', async () => {
  let project = { id: 'project-1', lead: 'business:search', status: 'open', revision: 3 }
  let grant = true
  let failInterruption = true
  let quiet = false
  const interrupted = []
  const service = {
    projectLedger: { get: id => id === project.id ? project : undefined },
    workLedger: { list: () => [{ id: 'work-1', projectId: 'project-1', status: 'cancelled',
      cancelledByProjectPrincipal: 'alice' }] },
    async pauseProjectAsHuman(actor, input, authorize) {
      if (!await authorize(actor, project)) throw new Error('Project intervention is not authorized for the current Project')
      if (project.intervention?.paused) return { project, cancelledWorkIds: [], idempotentReplay: true }
      if (input.expectedProjectRevision !== project.revision) throw new Error('Project revision changed')
      project = { ...project, revision: project.revision + 1, intervention: { paused: true } }
      return { project, cancelledWorkIds: ['work-1'] }
    },
    async resumeProjectAsHuman(actor, input, authorize, inspect) {
      if (!await authorize(actor, project)) throw new Error('Project intervention is not authorized for the current Project')
      if (input.expectedProjectRevision !== project.revision) throw new Error('Project revision changed')
      if ((await inspect()).status !== 'quiet') throw new Error('Project execution is unknown; keep it paused')
      project = { ...project, revision: project.revision + 1, intervention: { paused: false } }
      return { project }
    },
  }
  const handler = createProjectInterventionHttpHandler(service, {
    authenticateUser: req => req.headers.authorization === 'Bearer alice' ? { userId: 'alice' } : null,
    authorizeMutation: req => req.headers['x-csrf'] === 'ok',
    authorizeIntervention: (principal, current) => grant && principal.userId === 'alice'
      && current.lead === 'business:search',
    async afterPause(_principal, projectId, workIds) {
      interrupted.push({ projectId, workIds })
      if (failInterruption) throw new Error('injected Host interruption failure')
      return { interrupted: ['worker-session'], failed: [] }
    },
    inspectRuntime: async () => ({ status: quiet ? 'quiet' : 'unknown', sessionIds: quiet ? [] : ['worker-session'] }),
  })
  const url = '/api/bizagent/project-intervention'
  const alice = { authorization: 'Bearer alice' }
  const write = { ...alice, 'x-csrf': 'ok', 'content-type': 'application/json' }
  const pause = { action: 'pause', projectId: 'project-1', expectedRevision: 3,
    reason: 'Check the execution plan.' }
  assert.equal((await request(handler, 'GET', `${url}?projectId=project-1`)).statusCode, 401)
  assert.equal((await request(handler, 'POST', url, pause, alice)).statusCode, 403)
  assert.equal((await request(handler, 'POST', url, { ...pause, actor: 'admin' }, write)).statusCode, 400)
  assert.equal((await request(handler, 'POST', url, { ...pause, expectedRevision: 2 }, write)).body.error.code,
    'revision-conflict')
  grant = false
  assert.equal((await request(handler, 'POST', url, pause, write)).statusCode, 403)
  grant = true
  const before = await request(handler, 'GET', `${url}?projectId=project-1`, undefined, alice)
  assert.equal(before.body.canPause, true)
  assert.equal(before.headers['Cache-Control'], 'no-store')
  const failed = await request(handler, 'POST', url, pause, write)
  assert.equal(failed.statusCode, 503)
  assert.equal(failed.body.error.code, 'pause-incomplete')
  assert.equal(project.intervention.paused, true)
  failInterruption = false
  const retry = await request(handler, 'POST', url, pause, write)
  assert.equal(retry.body.idempotentReplay, true)
  assert.deepEqual(interrupted[1].workIds, ['work-1'])
  assert.equal((await request(handler, 'GET', `${url}?projectId=project-1`, undefined, alice)).body.canResume, true)
  const resume = { action: 'resume', projectId: 'project-1', expectedRevision: 4 }
  assert.equal((await request(handler, 'POST', url, resume, write)).statusCode, 409)
  quiet = true
  assert.equal((await request(handler, 'POST', url, resume, write)).body.project.intervention.paused, false)
  project = { ...project, lead: 'business:other' }
  assert.equal((await request(handler, 'GET', `${url}?projectId=project-1`,
    undefined, alice)).statusCode, 403)
})

test('pause still asks Host to interrupt when Work cleanup fails after the durable fence', async () => {
  let project = { id: 'project-1', lead: 'business:search', status: 'open', revision: 1 }
  let interruptionAttempts = 0
  const handler = createProjectInterventionHttpHandler({
    projectLedger: { get: () => project }, workLedger: { list: () => [] },
    async pauseProjectAsHuman() {
      project = { ...project, revision: 2, intervention: { paused: true } }
      throw new Error('injected Work ledger failure')
    },
  }, {
    authenticateUser: () => ({ userId: 'alice' }),
    authorizeMutation: () => true,
    authorizeIntervention: (_principal, current) => current.lead === 'business:search',
    async afterPause() { interruptionAttempts++; return { interrupted: [], failed: [] } },
    inspectRuntime: async () => ({ status: 'unknown', sessionIds: [] }),
  })
  const response = await request(handler, 'POST', '/api/bizagent/project-intervention',
    { action: 'pause', projectId: 'project-1', expectedRevision: 1, reason: 'Check work.' },
    { 'content-type': 'application/json' })
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.error.code, 'pause-incomplete')
  assert.equal(project.intervention.paused, true)
  assert.equal(interruptionAttempts, 1)
})
