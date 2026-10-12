import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateWorkOutput } from '../lib/work-output-eval.js'

test('Work output assertions inspect text outside fenced examples and distinguish skip', () => {
  const report = evaluateWorkOutput('artifact', Buffer.from('Complete summary\n```md\nTODO example\n```\n待补充 actual result\n'), 'artifacts/report.md')
  assert.equal(report.path, 'artifacts/report.md')
  assert.deepEqual(report.verdicts.map(verdict => verdict.result), ['pass', 'fail'])
  assert.match(report.verdicts[1].evidence, /待补充 actual result/)
  assert.match(report.sha256, /^[a-f0-9]{64}$/)
  const example = evaluateWorkOutput('artifact', Buffer.from('Final answer\n```\nTODO example\n```'), 'artifacts/report.md')
  assert.deepEqual(example.verdicts.map(verdict => verdict.result), ['pass', 'pass'])
  const empty = evaluateWorkOutput('artifact', Buffer.from('  \n'), 'artifacts/report.txt')
  assert.deepEqual(empty.verdicts.map(verdict => verdict.result), ['fail', 'skip'])
  const binary = evaluateWorkOutput('artifact', Buffer.from([0xff, 0x00]), 'artifacts/chart.png')
  assert.deepEqual(binary.verdicts.map(verdict => verdict.result), ['skip', 'skip'])
  const invalidText = evaluateWorkOutput('artifact', Buffer.from([0xff]), 'artifacts/data.csv')
  assert.deepEqual(invalidText.verdicts.map(verdict => verdict.result), ['skip', 'skip'])
  const body = evaluateWorkOutput('result-body', Buffer.from('Finished with {{missing}}'))
  assert.deepEqual(body.verdicts.map(verdict => verdict.result), ['pass', 'fail'])
})
