import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextCronAt } from '../lib/cron.js'

test('five-field cron follows Shanghai time and standard day matching', () => {
  const utc = Date.parse('2026-09-25T00:59:00.000Z')
  assert.equal(nextCronAt('0 9 * * *', utc), Date.parse('2026-09-25T01:00:00.000Z'))
  assert.equal(nextCronAt('0 9 * * MON-FRI', Date.parse('2026-09-25T01:00:00.000Z')),
    Date.parse('2026-09-28T01:00:00.000Z'))
  assert.equal(nextCronAt('*/15 * * * *', utc), Date.parse('2026-09-25T01:00:00.000Z'))
  assert.throws(() => nextCronAt('0 9 * *', utc), /five fields/)
  assert.throws(() => nextCronAt('0 25 * * *', utc), /invalid cron value/)
})
