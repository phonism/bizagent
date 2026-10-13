import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { type ContextBudget, type HomeAddress, parseHomeAddress } from './domain.js'
import { hostTimeZone, nextCronAt, resolveTimeZone } from './cron.js'

export interface LearningScheduleConfig {
  home: string
  cron: string
  model: string
  provider?: string
  maxTokens?: number
  dailyRuns?: number
}

export interface ResolvedLearningSchedule {
  home: HomeAddress
  cron: string
  model: string
  provider?: string
  maxTokens?: number
  dailyRuns: number
}

export interface Config {
  homeRoot?: string
  defaultHome?: string
  defaultIdentity?: string
  autoCreateDefaultHome?: boolean
  workspaceHomes?: Record<string, string>
  identityMaxBytes?: number
  indexMaxBytes?: number
  learningCheckpointEnabled?: boolean
  learningSchedulerEnabled?: boolean
  learningSchedules?: LearningScheduleConfig[]
  timeZone?: string
}

export const Config: Schema<Config> = Schema.object({
  homeRoot: Schema.string().description('BizAgent data root. Defaults to $DSH_HOME/bizagent.'),
  defaultHome: Schema.string().default('personal:default'),
  defaultIdentity: Schema.string(),
  autoCreateDefaultHome: Schema.boolean().default(true),
  workspaceHomes: Schema.dict(Schema.string()).default({}),
  identityMaxBytes: Schema.number().step(1).min(256).default(6144),
  indexMaxBytes: Schema.number().step(1).min(512).default(16384),
  learningCheckpointEnabled: Schema.boolean().default(true),
  learningSchedulerEnabled: Schema.boolean().default(false).description(
    'Run host-configured learning schedules every 30 seconds. Enable on exactly one host process for this profile.'),
  learningSchedules: Schema.array(Schema.object({
    home: Schema.string(), cron: Schema.string(), model: Schema.string(),
    provider: Schema.string(), maxTokens: Schema.number().step(1).min(1),
    dailyRuns: Schema.number().step(1).min(1).max(4).default(1),
  })).default([]),
  timeZone: Schema.string().description(
    'IANA time zone for cron schedules and daily run limits. Defaults to the host time zone.'),
})

export interface ResolvedConfig {
  homeRoot: string
  defaultHome?: HomeAddress
  defaultIdentity?: string
  autoCreateDefaultHome: boolean
  workspaceHomes: ReadonlyArray<{ root: string; address: HomeAddress }>
  budget: ContextBudget
  learningCheckpointEnabled: boolean
  learningSchedulerEnabled: boolean
  learningSchedules: ReadonlyArray<ResolvedLearningSchedule>
  timeZone: string
}

export function resolveConfig(input: Config = {}): ResolvedConfig {
  const dshRoot = process.env['DSH_HOME']?.trim() || join(homedir(), '.dsh')
  const configuredRoot = input.homeRoot?.trim() || join(dshRoot, 'bizagent')
  const homeRoot = resolve(expandHome(configuredRoot))
  const defaultHome = input.defaultHome?.trim()
    ? parseHomeAddress(input.defaultHome.trim())
    : undefined
  const workspaceHomes = Object.entries(input.workspaceHomes ?? {})
    .map(([root, address]) => ({
      root: resolve(expandHome(root)),
      address: parseHomeAddress(address),
    }))
    .sort((a, b) => b.root.length - a.root.length)
  const identityMaxBytes = input.identityMaxBytes ?? 6144
  const indexMaxBytes = input.indexMaxBytes ?? 16384
  if (!Number.isSafeInteger(identityMaxBytes) || identityMaxBytes < 256) {
    throw new TypeError('identityMaxBytes must be an integer >= 256')
  }
  if (!Number.isSafeInteger(indexMaxBytes) || indexMaxBytes < 512) {
    throw new TypeError('indexMaxBytes must be an integer >= 512')
  }
  const timeZone = input.timeZone?.trim() ? resolveTimeZone(input.timeZone) : hostTimeZone()
  const learningSchedules = (input.learningSchedules ?? []).map(item => {
    const home = parseHomeAddress(item.home)
    const cron = item.cron.trim()
    nextCronAt(cron, Date.now())
    const model = item.model.trim()
    const provider = item.provider?.trim()
    const dailyRuns = item.dailyRuns ?? 1
    if (!model || model.length > 200) throw new TypeError('learning schedule model must contain 1 to 200 characters')
    if (provider !== undefined && (!provider || provider.length > 200)) {
      throw new TypeError('learning schedule provider must contain 1 to 200 characters')
    }
    if (!Number.isSafeInteger(dailyRuns) || dailyRuns < 1 || dailyRuns > 4) {
      throw new TypeError('learning schedule dailyRuns must be between 1 and 4')
    }
    if (item.maxTokens !== undefined && (!Number.isSafeInteger(item.maxTokens) || item.maxTokens < 1)) {
      throw new TypeError('learning schedule maxTokens must be a positive integer')
    }
    if (workspaceHomes.filter(mapping => mapping.address === home).length !== 1) {
      throw new TypeError(`learning schedule Home ${home} requires exactly one mapped Workspace`)
    }
    return { home, cron, model, dailyRuns,
      ...(provider ? { provider } : {}),
      ...(item.maxTokens ? { maxTokens: item.maxTokens } : {}),
    }
  })
  if (new Set(learningSchedules.map(item => item.home)).size !== learningSchedules.length) {
    throw new TypeError('learning schedules require distinct Homes')
  }
  return {
    homeRoot,
    ...(defaultHome !== undefined ? { defaultHome } : {}),
    ...(input.defaultIdentity?.trim() ? { defaultIdentity: input.defaultIdentity.trim() } : {}),
    autoCreateDefaultHome: input.autoCreateDefaultHome ?? true,
    workspaceHomes,
    budget: { identityMaxBytes, indexMaxBytes },
    learningCheckpointEnabled: input.learningCheckpointEnabled ?? true,
    learningSchedulerEnabled: input.learningSchedulerEnabled ?? false,
    learningSchedules,
    timeZone,
  }
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  if (isAbsolute(path)) return path
  return resolve(path)
}
