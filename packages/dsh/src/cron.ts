const MINUTE = 60_000
const CST_OFFSET = 8 * 60 * MINUTE
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

interface CronField { values: Set<number>; wildcard: boolean }

/** Next five-field cron occurrence in Asia/Shanghai, strictly after `after`. */
export function nextCronAt(cron: string, after: number): number {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid cron clock')
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('cron requires five fields')
  const [minute, hour, day, month, weekday] = [
    parseField(fields[0]!, 0, 59), parseField(fields[1]!, 0, 23),
    parseField(fields[2]!, 1, 31), parseField(fields[3]!, 1, 12, MONTHS),
    parseField(fields[4]!, 0, 7, DAYS),
  ]
  for (let candidate = Math.floor(after / MINUTE) * MINUTE + MINUTE;
    candidate < after + 8 * 366 * 24 * 60 * MINUTE; candidate += MINUTE) {
    const cst = new Date(candidate + CST_OFFSET)
    const dow = cst.getUTCDay()
    const dateMatch = day.wildcard && weekday.wildcard ? true
      : day.wildcard ? weekday.values.has(dow)
        : weekday.wildcard ? day.values.has(cst.getUTCDate())
          : day.values.has(cst.getUTCDate()) || weekday.values.has(dow)
    if (minute.values.has(cst.getUTCMinutes()) && hour.values.has(cst.getUTCHours())
      && month.values.has(cst.getUTCMonth() + 1) && dateMatch) return candidate
  }
  throw new Error('cron has no occurrence within eight years')
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
