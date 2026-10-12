import type { ResolvedConfig, ResolvedLearningSchedule } from './config.js'
import { nowIso, parseHomeAddress, stableId, type HomeAddress,
  type LearningLaunch, type LearningScheduleCursor, type LearningSchedulePolicy } from './domain.js'
import { nextCronAt } from './cron.js'
import type { LearningSessionRunner } from './learning-session-runner.js'
import type { BizAgentService } from './service.js'

const DAY_MS = 24 * 60 * 60_000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000

export interface LearningScheduleStatus {
  homeAddress: HomeAddress
  hostEnabled: boolean
  configured: boolean
  maxDailyRuns?: number
  schedule?: ResolvedLearningSchedule
  policy?: LearningSchedulePolicy
  cursor?: LearningScheduleCursor
  nextDueAt?: number
  runsToday: number
  recentLaunches: LearningLaunch[]
}

/** Single-host, opt-in learning clock. Each due period is consumed at most once by its durable cursor. */
export class LearningScheduler {
  private pass: Promise<LearningScheduleCursor[]> | undefined

  constructor(private readonly service: BizAgentService,
    private readonly runner: LearningSessionRunner,
    private readonly config: ResolvedConfig,
    private readonly clock: () => number = Date.now) {}

  status(homeInput: string): LearningScheduleStatus {
    const homeAddress = parseHomeAddress(homeInput)
    this.service.store.getHome(homeAddress)
    const base = this.config.learningSchedules.find(item => item.home === homeAddress)
    const policy = this.service.ledger.getLearningSchedulePolicy(homeAddress)
    const schedule = base === undefined ? undefined : effectiveSchedule(base, policy)
    const fingerprint = schedule === undefined ? undefined : stableId('learning-schedule',
      JSON.stringify({ schedule, revision: policy?.revision ?? 0 }))
    const recordedCursor = this.service.ledger.getLearningScheduleCursor(homeAddress)
    const cursor = recordedCursor?.scheduleFingerprint === fingerprint ? recordedCursor : undefined
    const active = this.config.learningSchedulerEnabled && schedule !== undefined && policy?.enabled !== false
    return { homeAddress, hostEnabled: this.config.learningSchedulerEnabled,
      configured: base !== undefined,
      ...(base ? { maxDailyRuns: base.dailyRuns } : {}),
      ...(schedule ? { schedule } : {}),
      ...(policy ? { policy } : {}),
      ...(cursor ? { cursor } : {}),
      ...(active ? { nextDueAt: cursor?.nextDueAt ?? nextCronAt(schedule.cron, this.clock()) } : {}),
      runsToday: this.runsToday(homeAddress, this.clock()),
      recentLaunches: this.service.ledger.listLearningLaunches(homeAddress).slice(0, 10),
    }
  }

  async configure(homeInput: string, input: { expectedRevision: number; enabled: boolean;
    cron: string; dailyRuns: number }): Promise<LearningScheduleStatus> {
    const homeAddress = parseHomeAddress(homeInput)
    const base = this.config.learningSchedules.find(item => item.home === homeAddress)
    if (!this.config.learningSchedulerEnabled || !base) {
      throw new Error('learning scheduler is not enabled for this Home by its host')
    }
    if (this.service.store.getHome(homeAddress).status !== 'active') {
      throw new Error('learning schedule Home is not active')
    }
    const cron = input.cron.trim()
    if (cron.length > 100) throw new Error('learning schedule cron is too long')
    nextCronAt(cron, this.clock())
    if (!Number.isSafeInteger(input.dailyRuns) || input.dailyRuns < 1 || input.dailyRuns > base.dailyRuns) {
      throw new Error(`learning schedule dailyRuns must be between 1 and ${base.dailyRuns}`)
    }
    if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0) throw new Error('invalid learning schedule revision or enabled flag')
    await this.service.ledger.withLearningBatchWrite(async () => {
      const prior = this.service.ledger.getLearningSchedulePolicy(homeAddress)
      if ((prior?.revision ?? 0) !== input.expectedRevision) {
        throw new Error('learning schedule changed; refresh before saving')
      }
      if (prior?.enabled === input.enabled && prior.cron === cron && prior.dailyRuns === input.dailyRuns) return
      await this.service.ledger.putLearningSchedulePolicy({
        schemaVersion: 1, homeAddress, revision: input.expectedRevision + 1,
        enabled: input.enabled, cron, dailyRuns: input.dailyRuns,
        updatedBy: 'local-ui', updatedAt: nowIso(),
      })
    })
    return this.status(homeAddress)
  }

  runDue(): Promise<LearningScheduleCursor[]> {
    if (!this.config.learningSchedulerEnabled) return Promise.resolve([])
    if (this.pass) return this.pass
    const task = this.tick().finally(() => { if (this.pass === task) this.pass = undefined })
    this.pass = task
    return task
  }

  private async tick(): Promise<LearningScheduleCursor[]> {
    const results: LearningScheduleCursor[] = []
    let launched = 0
    for (const base of this.config.learningSchedules) {
      const policy = this.service.ledger.getLearningSchedulePolicy(base.home)
      if (policy?.enabled === false) continue
      const schedule = effectiveSchedule(base, policy)
      const now = this.clock()
      const fingerprint = stableId('learning-schedule', JSON.stringify({ schedule,
        revision: policy?.revision ?? 0 }))
      let cursor = this.service.ledger.getLearningScheduleCursor(schedule.home)
      if (cursor?.scheduleFingerprint !== fingerprint) {
        cursor = await this.service.ledger.putLearningScheduleCursor({
          schemaVersion: 1, homeAddress: schedule.home, scheduleFingerprint: fingerprint,
          nextDueAt: nextCronAt(schedule.cron, now), updatedAt: nowIso(),
        })
      }
      if (cursor.nextDueAt > now || launched >= 2) { results.push(cursor); continue }
      const dueAt = cursor.nextDueAt
      let outcome: LearningScheduleCursor['lastOutcome']
      let launchId: string | undefined
      let reason: string | undefined
      const existing = this.service.ledger.getLearningLaunch(scheduledLaunchId(schedule.home, fingerprint, dueAt))
      if (existing) {
        outcome = 'launched'
        launchId = existing.id
        reason = 'reconciled an already reserved learning launch for this due period'
      } else if (now - dueAt > DAY_MS) {
        outcome = 'expired'
        reason = 'missed due period was more than 24 hours old'
      } else if (this.runsToday(schedule.home, now) >= schedule.dailyRuns) {
        outcome = 'limit'
        reason = 'daily automatic learning run limit reached'
      } else if (this.service.ledger.listLearningLaunches(schedule.home)
        .some(item => ['reserved', 'active', 'needs_review'].includes(item.status))
        || this.service.ledger.listLearningBatches(schedule.home).some(item => item.status === 'open')) {
        outcome = 'deferred'
        reason = 'Home has an unresolved learning launch or open batch'
      } else if (!await this.service.hasPendingLearningMaterials(schedule.home)) {
        outcome = 'empty'
        reason = 'no pending material in the bounded learning scan'
      } else {
        try {
          const result = await this.runner.requestScheduled(schedule, dueAt, fingerprint, now,
            policy?.revision ?? 0)
          const launch = result.launch as { id: string }
          launchId = launch.id
          outcome = 'launched'
          launched += 1
        } catch (error) {
          launchId = scheduledLaunchId(schedule.home, fingerprint, dueAt)
          if (!this.service.ledger.getLearningLaunch(launchId)) launchId = undefined
          outcome = launchId ? 'launched' : 'deferred'
          reason = error instanceof Error ? error.message : String(error)
          this.service.recordRuntimeError(`learning schedule ${schedule.home}`, error)
          if (launchId) launched += 1
        }
      }
      cursor = await this.service.ledger.putLearningScheduleCursor({
        schemaVersion: 1, homeAddress: schedule.home, scheduleFingerprint: fingerprint,
        nextDueAt: nextCronAt(schedule.cron, Math.max(now, dueAt)),
        lastDueAt: dueAt, lastOutcome: outcome,
        ...(launchId ? { lastLaunchId: launchId } : {}),
        ...(reason ? { lastReason: reason.slice(0, 2000) } : {}),
        updatedAt: nowIso(),
      })
      results.push(cursor)
    }
    return results
  }

  private runsToday(home: ResolvedLearningSchedule['home'], now: number): number {
    const day = shanghaiDay(now)
    return this.service.ledger.listLearningLaunches(home)
      .filter(item => item.trigger === 'schedule' && shanghaiDay(Date.parse(item.createdAt)) === day).length
  }
}

function effectiveSchedule(base: ResolvedLearningSchedule,
  policy: LearningSchedulePolicy | undefined): ResolvedLearningSchedule {
  return policy === undefined ? base
    : { ...base, cron: policy.cron, dailyRuns: policy.dailyRuns }
}

function shanghaiDay(time: number): string {
  return new Date(time + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

function scheduledLaunchId(home: string, fingerprint: string, dueAt: number): string {
  const period = stableId('learning-period', `${fingerprint}:${dueAt}`)
  return stableId('learning-launch', `${home}:${period}`)
}
