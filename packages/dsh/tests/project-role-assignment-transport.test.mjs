import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createProjectRoleAssignmentHttpHandler } from '../lib/project-role-assignment-transport.js'

test('human Project role route checks current grant, candidate scope, CSRF and revisions', async () => {
  let project = { id: 'project-1', lead: 'business:search', status: 'open', revision: 3,
    seats: [{ homeAddress: 'role:analyst', status: 'active', responsibility: 'Analyze data.' }],
    roleSuggestions: [], roleDecisions: [] }
  const calls = []
  const service = { projectLedger: { get: id => id === project.id ? project : undefined },
    async decideProjectRoleAsHuman(actor, input, authorizeManager, authorizeTarget) {
      calls.push({ actor, input })
      if (!await authorizeManager(actor, project)) throw new Error('Project role decision is not authorized')
      if (input.expectedProjectRevision !== project.revision) {
        throw new Error('Project role decision requires the current open Project revision')
      }
      if (input.action === 'assign' && !await authorizeTarget(input.targetPrincipal, project, input.roleHome)) {
        throw new Error('Project role target is not authorized')
      }
      project = { ...project, revision: project.revision + 1 }
      return { project, decision: { action: input.action, byPrincipal: actor } }
    } }
  const handler = createProjectRoleAssignmentHttpHandler(service, {
    authenticateUser: req => req.headers.authorization === 'Bearer alice'
      ? { userId: 'alice' } : null,
    authorizeMutation: req => req.headers['x-csrf'] === 'ok',
    authorizeRead: (principal, current) => principal.userId === 'alice'
      && current.lead === 'business:search',
    authorizeManage: (principal, current) => principal.userId === 'alice'
      && current.lead === 'business:search',
    listCandidates: (_principal, _project, roleHome) => roleHome === 'role:analyst'
      ? [{ id: 'bob', label: 'Bob' }] : [],
    authorizeTarget: (target, _project, roleHome) => target === 'bob' && roleHome === 'role:analyst',
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
  const url = '/api/bizagent/project-role-assignments'
  const read = { authorization: 'Bearer alice' }
  const write = { ...read, 'x-csrf': 'ok', 'content-type': 'application/json' }
  const input = { projectId: 'project-1', roleHome: 'role:analyst', action: 'assign',
    targetPrincipal: 'bob', expectedProjectRevision: 3, expectedBindingRevision: 0,
    idempotencyKey: 'assign-bob', reason: 'Bob owns the analysis.' }
  assert.equal((await send('GET', `${url}?projectId=project-1`)).statusCode, 401)
  assert.equal((await send('POST', url, input, read)).statusCode, 403)
  assert.equal((await send('POST', url, { ...input, actor: 'admin' }, write)).statusCode, 400)
  assert.deepEqual(calls, [])
  const access = await send('GET', `${url}?projectId=project-1`, undefined, read)
  assert.equal(access.body.canManage, true)
  assert.equal(access.body.roles[0].roleHome, 'role:analyst')
  assert.equal(access.headers['Cache-Control'], 'no-store')
  assert.deepEqual((await send('GET', `${url}?projectId=project-1&roleHome=role%3Aanalyst`,
    undefined, read)).body.candidates.map(item => item.id), ['bob'])
  assert.equal((await send('GET', `${url}?projectId=project-1&roleHome=role%3Aother`,
    undefined, read)).statusCode, 403)
  assert.equal((await send('POST', url, { ...input, expectedProjectRevision: 2 }, write))
    .body.error.code, 'revision-conflict')
  const saved = await send('POST', url, input, write)
  assert.equal(saved.body.decision.byPrincipal, 'alice')
  assert.equal(calls.at(-1).input.targetPrincipal, 'bob')
  project = { ...project, lead: 'business:other' }
  assert.equal((await send('GET', `${url}?projectId=project-1`, undefined, read)).statusCode, 403)
  assert.equal((await send('POST', url, { ...input, expectedProjectRevision: 4 }, write)).statusCode, 403)
})
