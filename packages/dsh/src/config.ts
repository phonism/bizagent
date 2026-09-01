import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { type ContextBudget, type HomeAddress, parseHomeAddress } from './domain.js'

export interface Config {
  homeRoot?: string
  defaultHome?: string
  defaultIdentity?: string
  autoCreateDefaultHome?: boolean
  workspaceHomes?: Record<string, string>
  identityMaxBytes?: number
  indexMaxBytes?: number
  learningCheckpointEnabled?: boolean
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
})

export interface ResolvedConfig {
  homeRoot: string
  defaultHome?: HomeAddress
  defaultIdentity?: string
  autoCreateDefaultHome: boolean
  workspaceHomes: ReadonlyArray<{ root: string; address: HomeAddress }>
  budget: ContextBudget
  learningCheckpointEnabled: boolean
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
  return {
    homeRoot,
    ...(defaultHome !== undefined ? { defaultHome } : {}),
    ...(input.defaultIdentity?.trim() ? { defaultIdentity: input.defaultIdentity.trim() } : {}),
    autoCreateDefaultHome: input.autoCreateDefaultHome ?? true,
    workspaceHomes,
    budget: { identityMaxBytes, indexMaxBytes },
    learningCheckpointEnabled: input.learningCheckpointEnabled ?? true,
  }
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  if (isAbsolute(path)) return path
  return resolve(path)
}
