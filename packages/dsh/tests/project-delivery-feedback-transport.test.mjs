import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createProjectDeliveryFeedbackHttpHandler } from '../lib/project-delivery-feedback-transport.js'
import { ProjectSnapshotStore } from '../lib/worklog-snapshot.js'

test('human delivery feedback route checks identity, mutation protection, current grant and revision', async () => {
  const hash = 'a'.repeat(64)
  let project = { id: 'project-1', lead: 'business:search', status: 'open', revision: 2,
    workingAssets: [{ path: 'context/notes.md', revision: 1, sha256: hash, bytes: 12 }],
    claims: [], deliveryFeedback: [] }
  const calls = []
  const service = { projectLedger: { get: id => id === project.id ? project : undefined },
    async addProjectDeliveryFeedbackAsHuman(actor, input, authorize) {
      calls.push({ actor, input })
      if (!await authorize(actor, project)) throw new Error('Project delivery feedback is not authorized')
      if (project.revision !== input.expectedProjectRevision) {
        throw new Error('Project delivery feedback revision conflict')
      }
      project = { ...project, revision: project.revision + 1,
        deliveryFeedback: [{ id: 'opinion-1', byPrincipal: actor, body: input.body,
          path: input.path, version: input.version, sha256: input.expectedSha256 }] }
      return { project, feedback: project.deliveryFeedback[0] }
    } }
  const handler = createProjectDeliveryFeedbackHttpHandler(service, {
    authenticateUser: req => req.headers.authorization === 'Bearer alice'
      ? { userId: 'alice' } : null,
    authorizeMutation: req => req.headers['x-csrf'] === 'ok',
    authorizeFeedback: (principal, current) => principal.userId === 'alice'
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
  const url = '/api/bizagent/project-delivery-feedback'
  const read = { authorization: 'Bearer alice' }
  const write = { ...read, 'x-csrf': 'ok', 'content-type': 'application/json' }
  const input = { projectId: 'project-1', path: 'context/notes.md', version: 'working',
    expectedSha256: hash, expectedProjectRevision: 2,
    idempotencyKey: 'opinion-one', body: 'Add sample range.' }
  assert.equal((await send('GET', `${url}?projectId=project-1`)).statusCode, 401)
  assert.equal((await send('POST', url, input, read)).statusCode, 403)
  assert.equal((await send('POST', url, { ...input, actor: 'admin' }, write)).statusCode, 400)
  assert.deepEqual(calls, [])
  const listed = await send('GET', `${url}?projectId=project-1`, undefined, read)
  assert.equal(listed.body.workingAssets[0].sha256, hash)
  assert.equal(listed.headers['Cache-Control'], 'no-store')
  assert.equal((await send('POST', url, { ...input, expectedProjectRevision: 1 }, write))
    .body.error.code, 'revision-conflict')
  const saved = await send('POST', url, { ...input, section: 'Evidence' }, write)
  assert.equal(saved.body.feedback.byPrincipal, 'alice')
  assert.equal(calls.at(-1).input.section, 'Evidence')
  assert.equal((await send('GET', `${url}?projectId=project-1`, undefined, read))
    .body.feedback[0].id, 'opinion-1')
  project = { ...project, lead: 'business:other' }
  assert.equal((await send('GET', `${url}?projectId=project-1`, undefined, read)).statusCode, 403)
  assert.equal((await send('POST', url, { ...input, expectedProjectRevision: 3 }, write))
    .statusCode, 403)
})

test('human delivery route serves only authorized retained Project versions', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bizagent-delivery-feedback-route-')))
  try {
    const first = Buffer.from('First version\n')
    const second = Buffer.from('Second version\n')
    const snapshots = new ProjectSnapshotStore(root)
    const firstObject = await snapshots.retain(first)
    const secondObject = await snapshots.retain(second)
    const project = { id: 'project-1', lead: 'business:search', status: 'open', revision: 4,
      workingAssets: [
        { path: 'context/notes.md', revision: 1, ...firstObject },
        { path: 'context/notes.md', revision: 2, ...secondObject },
      ], claims: [], deliveryFeedback: [{ id: 'opinion-1', path: 'context/notes.md',
        version: 'working', workingRevision: 1, ...firstObject }] }
    const handler = createProjectDeliveryFeedbackHttpHandler({ store: { root },
      projectLedger: { get: () => project } }, {
      authenticateUser: req => req.headers.authorization === 'Bearer alice'
        ? { userId: 'alice' } : null,
      authorizeMutation: () => false,
      authorizeFeedback: (_principal, current) => current.lead === 'business:search',
    })
    const send = async (url, headers = {}) => {
      const req = Readable.from([])
      req.method = 'GET'
      req.url = url
      req.headers = headers
      const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value },
        end(value) { this.body = value } }
      await handler(req, res)
      return res
    }
    const base = '/api/bizagent/project-delivery-feedback?projectId=project-1'
    const read = { authorization: 'Bearer alice' }
    assert.equal((await send(`${base}&feedbackId=opinion-1`)).statusCode, 401)
    assert.deepEqual((await send(`${base}&feedbackId=opinion-1`, read)).body, first)
    assert.deepEqual((await send(`${base}&assetPath=context%2Fnotes.md&version=working&revision=1`, read)).body,
      first)
    assert.deepEqual((await send(`${base}&assetPath=context%2Fnotes.md&version=working`, read)).body,
      second)
    assert.equal((await send(`${base}&feedbackId=missing`, read)).statusCode, 404)
    assert.equal((await send(`${base}&assetPath=private%2Fsecret.md&version=working`, read)).statusCode, 404)
    assert.equal((await send(`${base}&feedbackId=opinion-1&assetPath=context%2Fnotes.md`, read)).statusCode, 400)
  } finally { await rm(root, { recursive: true, force: true }) }
})
