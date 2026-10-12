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

test('only a successful remember result suppresses a duplicate checkpoint', () => {
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
  assert.ok(trigger.detect(events, 1), 'dispatch without completion must not suppress learning')
  events.push({
    seq: 3, time: 3, type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'remember-call', content: [] }] } },
  })
  assert.equal(trigger.detect(events, 1), undefined)
  events[3].data.message.content[0].isError = true
  assert.ok(trigger.detect(events, 1), 'a failed write must still get a checkpoint')
  events[3].data.message.content[0].isError = false
  events[3].data.error = { name: 'Error', code: 'storage-failed' }
  assert.ok(trigger.detect(events, 1), 'internal failures also keep the checkpoint eligible')
  delete events[3].data.error
  events[3].data.message.content[0].toolCallId = 'unrelated-call'
  assert.ok(trigger.detect(events, 1), 'an unrelated successful result is not learning')

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
  codeModeEvents[2].data.isError = true
  assert.ok(trigger.detect(codeModeEvents, 1))
  codeModeEvents[2].type = 'tool/code-dispatch-start'
  assert.ok(trigger.detect(codeModeEvents, 1), 'an unfinished Code Mode dispatch is not learning')
})

test('a later correction is not suppressed by earlier learning or another turn', () => {
  const trigger = new ExplicitCorrectionTrigger()
  const events = [
    { seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } },
    message(1, '下次请先备份配置。'),
    { seq: 2, time: 2, type: 'tool/call', data: { callId: 'old', name: 'bizagent_memory_remember' } },
    { seq: 3, time: 3, type: 'tool/result', data: { message: {
      content: [{ type: 'tool-result', toolCallId: 'old', content: [] }],
    } } },
    message(4, '记住：下次也要验证备份能够恢复。'),
    { seq: 5, time: 5, type: 'turn/start', data: { turn: 2 } },
    message(6, '以后不要再覆盖已完成的备份。'),
  ]
  assert.equal(trigger.detect(events, 1).evidenceRef.fromSeq, 4)
  assert.equal(trigger.detect(events, 2).evidenceRef.fromSeq, 6)
  assert.equal(trigger.detect(events, 99), undefined)
})

test('Code Mode learning started before a correction cannot settle that correction', () => {
  const trigger = new ExplicitCorrectionTrigger()
  const data = { subCallId: 'code:0', name: 'bizagent_memory_remember', isError: false, content: [] }
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'tool/code-dispatch-start', data },
    message(2, '记住：要先验证备份。'),
    { seq: 3, type: 'tool/code-dispatch', data },
  ]
  assert.equal(trigger.detect(events, 1).evidenceRef.fromSeq, 2)
})
