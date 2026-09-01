import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ExplicitCorrectionTrigger } from '../lib/learning-trigger.js'

function message(seq, text, source = { kind: 'user' }) {
  return {
    seq,
    time: seq,
    type: 'user/message',
    surfaceOp: 'append',
    data: {
      id: `message-${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source,
    },
  }
}

test('explicit correction trigger is conservative and preserves exact evidence', () => {
  const trigger = new ExplicitCorrectionTrigger()
  const ordinary = [
    { seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } },
    message(1, '请分析一下这份配置。'),
  ]
  assert.equal(trigger.detect(ordinary, 1), undefined)

  const correction = [
    { seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } },
    message(1, '记住：以后修改配置之前必须先创建备份。'),
  ]
  const match = trigger.detect(correction, 1)
  assert.equal(match.reason, 'explicit-correction')
  assert.equal(match.evidenceRef.fromSeq, 1)
  assert.equal(match.evidenceRef.toSeq, 1)
  assert.match(match.excerpt, /必须先创建备份/)
})

test('an explicit remember tool call suppresses a duplicate checkpoint', () => {
  const trigger = new ExplicitCorrectionTrigger()
  const events = [
    { seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } },
    message(1, '下次请先备份配置。'),
    {
      seq: 2,
      time: 2,
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'remember-call',
        name: 'bizagent_memory_remember',
        arguments: '{}',
      },
    },
  ]
  assert.equal(trigger.detect(events, 1), undefined)

  const codeModeEvents = [
    { seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } },
    message(1, '下次请先备份配置。'),
    {
      seq: 2,
      time: 2,
      type: 'tool/code-dispatch',
      data: {
        rootCallId: 'run-code',
        parentCallId: 'run-code',
        subCallId: 'run-code:code:0',
        name: 'bizagent_memory_remember',
        arguments: {},
        isError: false,
        content: [{ type: 'text', text: 'remembered' }],
      },
    },
  ]
  assert.equal(trigger.detect(codeModeEvents, 1), undefined)
})
