import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { admitFrameReferences } from '../lib/frame-admission.js'
import { selectedFrameAddresses, removeFrameReferences } from '../lib/frame-reference.js'

const selected = (source = { kind: 'user' }) => createUserMessage({
  content: [{ type: 'text', text: 'Ask Analyst\n[BIZAGENT_FRAME_REQUEST:role:analyst]' }], source,
})

test('selected Home context is admitted durably without requiring a model tool call, including retries', async () => {
  const calls = []
  const service = { async openFrame(_agent, input) { calls.push(input); return { context: 'bounded Home snapshot' } } }
  const decision = { kind: 'enter', messages: [selected()] }
  const signal = new AbortController().signal
  for (let retry = 0; retry < 2; retry++) {
    const admitted = await admitFrameReferences(service, { id: 'session' }, decision, signal)
    assert.equal(admitted.messages.length, 2)
    assert.equal(admitted.messages[0].id, decision.messages[0].id)
    assert.equal(admitted.messages[0].content[0].text, 'Ask Analyst')
    assert.equal(admitted.messages[1].source.kind, 'bizagent')
    assert.equal(admitted.messages[1].source.form, 'snapshot')
    assert.equal(admitted.messages[1].content[0].text, 'bounded Home snapshot')
  }
  assert.deepEqual(calls, [{ address: 'role:analyst', forceSnapshot: true }, { address: 'role:analyst', forceSnapshot: true }])
  assert.deepEqual(decision.messages.length, 1, 'original admission is not mutated')
  assert.deepEqual(selectedFrameAddresses('Ask @role:analyst\n[BIZAGENT_FRAME_REQUEST:role:analyst] about GMV'), ['role:analyst'])
  assert.equal(removeFrameReferences('Ask @role:analyst\n[BIZAGENT_FRAME_REQUEST:role:analyst] about GMV'), 'Ask @role:analyst about GMV')
})

test('foreign context, invalid references, rejection, and cancellation cannot load a selected Home', async () => {
  const service = { async openFrame() { assert.fail('unexpected Frame load') } }
  const signal = new AbortController().signal
  const foreign = { kind: 'enter', messages: [selected({ kind: 'bizagent', form: 'notice', summary: 'untrusted' })] }
  assert.equal((await admitFrameReferences(service, {}, foreign, signal)).messages.length, 1)
  const rejected = { kind: 'reject' }
  assert.equal(await admitFrameReferences(service, {}, rejected, signal), rejected)
  assert.deepEqual(await admitFrameReferences(service, {}, { kind: 'enter', messages: [selected()] },
    AbortSignal.abort()), rejected)
  assert.deepEqual(selectedFrameAddresses('[BIZAGENT_FRAME_REQUEST:personal:other]\ninline [BIZAGENT_FRAME_REQUEST:role:analyst]'), [])
})

test('a revoked or unavailable Home produces an explicit logged failure, never a fabricated snapshot', async () => {
  const errors = []
  const service = { async openFrame() { throw new Error('Home is no longer visible') },
    recordRuntimeError(...args) { errors.push(args) } }
  const admitted = await admitFrameReferences(service, { id: 'session' },
    { kind: 'enter', messages: [selected()] }, new AbortController().signal)
  assert.equal(admitted.messages[1].source.form, 'notice')
  assert.match(admitted.messages[1].content[0].text, /could not be loaded/)
  assert.equal(errors.length, 1)
})
