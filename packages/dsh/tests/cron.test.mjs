import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextCronAt, resolveTimeZone, zonedDay } from '../lib/cron.js'
import { resolveConfig } from '../lib/config.js'

test('five-field cron follows the configured time zone and standard day matching', () => {
  const utc = Date.parse('2026-09-25T00:59:00.000Z')
  const shanghai = 'Asia/Shanghai'
  assert.equal(nextCronAt('0 9 * * *', utc, shanghai), Date.parse('2026-09-25T01:00:00.000Z'))
  assert.equal(nextCronAt('0 9 * * MON-FRI', Date.parse('2026-09-25T01:00:00.000Z'), shanghai),
    Date.parse('2026-09-28T01:00:00.000Z'))
  assert.equal(nextCronAt('*/15 * * * *', utc, shanghai), Date.parse('2026-09-25T01:00:00.000Z'))
  assert.equal(nextCronAt('0 9 * * *', utc), Date.parse('2026-09-25T09:00:00.000Z'))
  assert.equal(nextCronAt('0 0 29 2 *', utc, shanghai), Date.parse('2028-02-28T16:00:00.000Z'))
  assert.throws(() => nextCronAt('0 9 * *', utc), /five fields/)
  assert.throws(() => nextCronAt('0 25 * * *', utc), /invalid cron value/)
})

test('cron and calendar days follow daylight saving time in the configured zone', () => {
  const zone = 'America/New_York'
  // 2026-03-08: clocks move from 02:00 EST to 03:00 EDT; 02:30 does not exist that day.
  assert.equal(nextCronAt('30 2 * * *', Date.parse('2026-03-08T00:00:00.000Z'), zone),
    Date.parse('2026-03-09T06:30:00.000Z'))
  assert.equal(nextCronAt('0 9 * * *', Date.parse('2026-03-07T15:00:00.000Z'), zone),
    Date.parse('2026-03-08T13:00:00.000Z'))
  assert.equal(nextCronAt('0 9 * * *', Date.parse('2026-11-01T00:00:00.000Z'), zone),
    Date.parse('2026-11-01T14:00:00.000Z'))
  assert.equal(zonedDay(Date.parse('2026-09-25T15:59:00.000Z'), 'Asia/Shanghai'), '2026-09-25')
  assert.equal(zonedDay(Date.parse('2026-09-25T16:00:00.000Z'), 'Asia/Shanghai'), '2026-09-26')
  assert.equal(zonedDay(Date.parse('2026-09-25T16:00:00.000Z')), '2026-09-25')
})

test('timeZone config is validated and defaults to the host zone', () => {
  assert.equal(resolveTimeZone(' Asia/Shanghai '), 'Asia/Shanghai')
  assert.throws(() => resolveTimeZone('Mars/Olympus'), /unknown timeZone/)
  assert.equal(resolveConfig({ timeZone: 'Europe/Berlin' }).timeZone, 'Europe/Berlin')
  assert.equal(resolveConfig({}).timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone)
  assert.throws(() => resolveConfig({ timeZone: 'nowhere' }), /unknown timeZone/)
})
