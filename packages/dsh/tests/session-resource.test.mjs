import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/client/session-resource.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false })
const { SessionResource } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

test('Session readers share requests and cancel abandoned loads without publishing stale data', async () => {
  const requests = []
  const resource = new SessionResource(signal => new Promise(resolve => requests.push({ signal, resolve })))
  const unsubscribe = resource.subscribe(() => undefined)
  const second = resource.subscribe(() => undefined)
  await resource.refresh()
  assert.equal(requests.length, 1)
  unsubscribe()
  assert.equal(requests[0].signal.aborted, false)
  second()
  assert.equal(requests[0].signal.aborted, true)
  const next = resource.subscribe(() => undefined)
  assert.equal(requests.length, 2)
  requests[1].resolve({ sessionId: 'new' })
  await new Promise(resolve => setImmediate(resolve))
  requests[0].resolve({ sessionId: 'stale' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(resource.getSnapshot().data, { sessionId: 'new' })
  next()
})
