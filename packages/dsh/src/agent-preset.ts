import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions, AgentRegistry, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'

type Agents = Pick<AgentRegistry, 'get' | 'create' | 'resume'>
type Sessions = Pick<SessionQueryEngine, 'listSessions'>

/** The slice of the optional DSH `agentPresets` service this plugin uses. */
interface AgentPresetRoster {
  resolve(id?: string): Promise<{ readonly id: string }>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/**
 * Wrap the Agent factory so plugin-created Sessions join a DSH agent preset, as Sessions created
 * by the DSH host do. The preset supplies the model-facing built-in tools (files, shell, search,
 * subagents); without joining one, an Agent sees only globally registered tools and cannot read
 * or change its Workspace. A new Session records the resolved preset on its header, and a resumed
 * Session rejoins the preset it recorded (or the current default for Sessions created before this
 * existed). A deployment with no preset roster keeps the plain host composition.
 *
 * A caller that names no model gets the host's current default, which is also what DSH's own
 * session controller passes. DSH does not restore a resumed Session's model by itself, and an
 * Agent without one fails every turn while assembling its system prompt.
 */
export function withAgentPreset(ctx: Context, agents: Agents, sessions: Sessions,
  defaultModel: () => AgentOptions): Agents {
  const compose = async (presetId: string | undefined, setup: AgentSetup | undefined) => {
    const roster = (ctx as unknown as { get(name: string): unknown }).get('agentPresets') as
      AgentPresetRoster | undefined
    if (roster === undefined) return { setup }
    const id = (await roster.resolve(presetId)).id
    const joined: AgentSetup = async (agentCtx, agent) => {
      await roster.mount(agentCtx, id)
      return setup?.(agentCtx, agent)
    }
    return { id, setup: joined }
  }
  return {
    get: id => agents.get(id),
    create: async options => {
      const composed = await compose(options.meta?.agentPreset, options.setup)
      return agents.create({
        agentOptions: defaultModel(),
        ...options,
        ...(composed.id === undefined ? {} : { meta: { ...options.meta, agentPreset: composed.id } }),
        ...(composed.setup === undefined ? {} : { setup: composed.setup }),
      })
    },
    resume: async options => {
      const record = (await sessions.listSessions())
        .find(item => String(item.header.id) === String(options.resumeSessionId))
      const recorded = (record?.header as { agentPreset?: unknown } | undefined)?.agentPreset
      const composed = await compose(typeof recorded === 'string' ? recorded : undefined, options.setup)
      return agents.resume({ agentOptions: defaultModel(), ...options,
        ...(composed.setup === undefined ? {} : { setup: composed.setup }) })
    },
  }
}
