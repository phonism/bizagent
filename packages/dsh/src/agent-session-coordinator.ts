import type { AgentHandle, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { nowIso, parseHomeAddress, type HomeAddress } from './domain.js'
import { principalSessionId, projectMainAddress, projectMainSessionId,
  type AgentSessionAddress } from './agent-session-address.js'
import type { BizAgentService } from './service.js'

type Agents = Pick<AgentRegistry, 'get' | 'create' | 'resume'>
type Sessions = Pick<SessionQueryEngine, 'listSessions'>

/** Owns only the runtime handles it opens. Session IDs and Home bindings survive process restarts. */
export class AgentSessionCoordinator {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly pending = new Map<string, Promise<AgentSessionAddress>>()
  private closing = false

  constructor(private readonly agents: Agents, private readonly sessions: Sessions,
    private readonly service: BizAgentService,
    private readonly creationModel?: () => AgentOptions) {}

  openPrincipal(homeInput: string): Promise<AgentSessionAddress> {
    const homeAddress = parseHomeAddress(homeInput)
    return this.open({ kind: 'principal', homeAddress,
      logicalAddress: homeAddress, sessionId: principalSessionId(homeAddress) })
  }

  openProjectMain(projectId: string): Promise<AgentSessionAddress> {
    const project = this.service.projectLedger?.get(projectId)
    if (!project || project.driver !== projectMainAddress(projectId)) {
      throw new Error('Project has no current Main address')
    }
    return this.open({ kind: 'project-main', homeAddress: project.lead,
      logicalAddress: project.driver, sessionId: projectMainSessionId(projectId), projectId })
  }

  private open(address: AgentSessionAddress): Promise<AgentSessionAddress> {
    if (this.closing) throw new Error('Agent Session coordinator is closing')
    const pending = this.pending.get(address.sessionId)
    if (pending) return pending
    const task = this.openOne(address)
    this.pending.set(address.sessionId, task)
    void task.finally(() => { if (this.pending.get(address.sessionId) === task) this.pending.delete(address.sessionId) })
      .catch(() => undefined)
    return task
  }

  private async openOne(address: AgentSessionAddress): Promise<AgentSessionAddress> {
    const home = this.service.store.getHome(address.homeAddress)
    if (home.status !== 'active') throw new Error('Agent Home is not active')
    const workspace = this.service.store.homeWorkspacePath(address.homeAddress)
    const binding = this.service.ledger.getBinding(address.sessionId)
    if (binding && (binding.homeAddress !== address.homeAddress || binding.cwd !== workspace)) {
      throw new Error('Agent Session is bound to a different Home or Workspace')
    }
    if (!binding) await this.service.ledger.putBinding({ sessionId: address.sessionId,
      homeAddress: address.homeAddress as HomeAddress, cwd: workspace, boundAt: nowIso() })
    const sessionId = address.sessionId as SessionId
    const record = (await this.sessions.listSessions())
      .find(item => String(item.header.id) === address.sessionId)
    if (record && record.header.cwd !== workspace) {
      throw new Error('persisted Agent Session Workspace differs from its Home')
    }
    if (record && !record.persisted && !this.agents.get(sessionId)) {
      throw new Error('Agent Session exists but cannot be resumed')
    }
    let agent = this.agents.get(sessionId)
    if (!agent) {
      const setup = (agentCtx: Parameters<NonNullable<Parameters<AgentRegistry['create']>[0]['setup']>>[0]) => {
        agentCtx.systemPrompt.section({ name: 'bizagent:agent-session-mode', order: 50,
          text: address.kind === 'principal'
            ? `This is the unique long-term Principal for ${address.homeAddress}. Keep its conversation continuous. A Principal turn does not require a worklog.`
            : `This is the dedicated Project Main for ${address.logicalAddress}, acting as ${address.homeAddress}. Use this execution conversation to coordinate this Project, read its current record before decisions, and keep project work separate from the long-term Principal. The Home's AGENTS.md is the execution guide when present; record work in the Project and Worklog as appropriate.`,
        })
      }
      const handle = record
        ? await this.agents.resume({ resumeSessionId: sessionId, setup })
        : await this.agents.create({ sessionId, meta: { cwd: workspace }, setup,
          ...(this.creationModel === undefined ? {} : { agentOptions: this.creationModel() }) })
      this.handles.set(address.sessionId, handle)
      agent = handle.agent
    }
    if (String(agent.id) !== address.sessionId
      || String(agent.session.header.id) !== address.sessionId
      || agent.session.header.cwd !== workspace) {
      const handle = this.handles.get(address.sessionId)
      if (handle) { this.handles.delete(address.sessionId); await handle.dispose() }
      throw new Error('Agent Session identity or Workspace differs from the durable address')
    }
    return address
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled(this.pending.values())
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.all(handles.map(handle => handle.dispose()))
  }
}
