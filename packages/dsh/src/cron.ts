const MINUTE = 60_000
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

interface CronField { values: Set<number>; wildcard: boolean }
interface WallClock { year: number; month: number; day: number; weekday: number; hour: number; minute: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The host's IANA time zone, or UTC when the runtime cannot report one. */
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Validate an IANA time zone name and return its canonical spelling. */
export function resolveTimeZone(timeZone: string): string {
  const name = timeZone.trim()
  if (!name) throw new TypeError('timeZone must name an IANA time zone')
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
  } catch {
    throw new TypeError(`unknown timeZone: ${timeZone}`)
  }
}

/** Calendar day (YYYY-MM-DD) of an instant in the given time zone. */
export function zonedDay(time: number, timeZone = 'UTC'): string {
  const clock = wallClock(time, timeZone)
  return `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`
}

/** Next five-field cron occurrence in `timeZone`, strictly after `after`. */
export function nextCronAt(cron: string, after: number, timeZone = 'UTC'): number {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid cron clock')
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('cron requires five fields')
  const [minute, hour, day, month, weekday] = [
    parseField(fields[0]!, 0, 59), parseField(fields[1]!, 0, 23),
    parseField(fields[2]!, 1, 31), parseField(fields[3]!, 1, 12, MONTHS),
    parseField(fields[4]!, 0, 7, DAYS),
  ]
  const limit = after + 8 * 366 * 24 * 60 * MINUTE
  let candidate = Math.floor(after / MINUTE) * MINUTE + MINUTE
  while (candidate < limit) {
    const local = wallClock(candidate, timeZone)
    const dateMatch = day.wildcard && weekday.wildcard ? true
      : day.wildcard ? weekday.values.has(local.weekday)
        : weekday.wildcard ? day.values.has(local.day)
          : day.values.has(local.day) || weekday.values.has(local.weekday)
    // Skip to the next local hour when the date or hour cannot match. Offset changes happen on
    // hour or half-hour boundaries, so this never steps over a valid minute.
    if (!month.values.has(local.month) || !dateMatch || !hour.values.has(local.hour)) {
      candidate += (60 - local.minute) * MINUTE
      continue
    }
    if (minute.values.has(local.minute)) return candidate
    candidate += MINUTE
  }
  throw new Error('cron has no occurrence within eight years')
}

function wallClock(time: number, timeZone: string): WallClock {
  if (timeZone === 'UTC') {
    const date = new Date(time)
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
      weekday: date.getUTCDay(), hour: date.getUTCHours(), minute: date.getUTCMinutes() }
  }
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric',
      month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric' })
    formatters.set(timeZone, formatter)
  }
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(time)) parts[part.type] = part.value
  return { year: Number(parts['year']), month: Number(parts['month']), day: Number(parts['day']),
    weekday: DAYS.indexOf(String(parts['weekday']).toUpperCase()),
    hour: Number(parts['hour']), minute: Number(parts['minute']) }
}

function parseField(text: string, min: number, max: number, names?: readonly string[]): CronField {
  const wildcard = text === '*' || text === '?'
  const values = new Set<number>()
  for (const entry of text.toUpperCase().split(',')) {
    const match = /^([^/]+)(?:\/(\d+))?$/.exec(entry)
    if (!match) throw new Error(`invalid cron field: ${text}`)
    const [, base, stepText] = match
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isSafeInteger(step) || step < 1) throw new Error(`invalid cron step: ${text}`)
    let start: number
    let end: number
    if (base === '*' || base === '?') { start = min; end = max }
    else if (base!.includes('-')) {
      const parts = base!.split('-')
      if (parts.length !== 2) throw new Error(`invalid cron range: ${text}`)
      start = fieldNumber(parts[0]!, min, max, names)
      end = fieldNumber(parts[1]!, min, max, names)
    } else {
      start = fieldNumber(base!, min, max, names)
      end = stepText === undefined ? start : max
    }
    if (start > end) throw new Error(`reversed cron range: ${text}`)
    for (let value = start; value <= end; value += step) values.add(max === 7 && value === 7 ? 0 : value)
  }
  if (values.size === 0) throw new Error(`empty cron field: ${text}`)
  return { values, wildcard }
}

function fieldNumber(text: string, min: number, max: number, names?: readonly string[]): number {
  const named = names?.indexOf(text)
  const value = named !== undefined && named >= 0 ? named + (max === 12 ? 1 : 0) : Number(text)
  if (!Number.isSafeInteger(value) || value < min || value > max || text.trim() === '') {
    throw new Error(`invalid cron value: ${text}`)
  }
  return value
}
