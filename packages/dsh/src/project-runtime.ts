import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { stableId, type ProjectTurnParticipation } from './domain.js'
import type { BizAgentService } from './service.js'
import type { WorkRunner } from './work-runner.js'

type Agents = Pick<AgentRegistry, 'get'>
type Sessions = Pick<SessionQueryEngine, 'listSessions' | 'readSession'>
export type ProjectRuntimeInspection = {
  status: 'quiet' | 'busy' | 'unknown'
  sessionIds: string[]
}

function dedicatedProjectSessionIds(service: BizAgentService, projectId: string): Set<string> {
  const ids = new Set<string>()
  for (const work of service.workLedger?.list() ?? []) {
    if (work.projectId === projectId
      && work.workerSessionId === stableId('work-session', work.id)) ids.add(work.workerSessionId)
  }
  for (const plan of service.ledger.listInboxWakePlans()) {
    if (plan.recipient.startsWith(`seat:${projectId}:`)) ids.add(plan.sessionId)
  }
  return ids
}

/** Dedicated Sessions, formal Work Sessions, and explicitly joined Home turns. */
export function projectSessionIds(service: BizAgentService, projectId: string): string[] {
  const ids = dedicatedProjectSessionIds(service, projectId)
  for (const work of service.workLedger?.list() ?? []) {
    if (work.projectId === projectId && work.workerSessionId !== undefined) ids.add(work.workerSessionId)
  }
  for (const turn of service.ledger.listProjectTurns(projectId)) ids.add(turn.sessionId)
  return [...ids].sort()
}

function activeJoinedTurn(agent: ReturnType<Agents['get']>, turns: ProjectTurnParticipation[]): boolean {
  if (agent?.status !== 'running') return false
  const events = agent.session?.events ?? []
  const latest = [...events].reverse().find(event => event.type === 'turn/start')
  return latest?.type === 'turn/start'
    && turns.some(turn => turn.turn === latest.data.turn)
    && !events.some(event => event.type === 'turn/end' && event.data.turn === latest.data.turn)
}

function matchesBoundSession(service: BizAgentService, id: string, agent: ReturnType<Agents['get']>): boolean {
  const binding = service.ledger.getBinding(id)
  return agent !== undefined && String(agent.id) === id && String(agent.session?.header.id) === id
    && binding !== undefined && (binding.cwd === undefined || agent.session.header.cwd === binding.cwd)
}

export function interruptProjectSessions(agents: Agents, service: BizAgentService,
  projectId: string, excludeSessionId: string): { interrupted: string[]; failed: string[] } {
  const interrupted: string[] = []
  const failed: string[] = []
  const dedicated = dedicatedProjectSessionIds(service, projectId)
  const turns = service.ledger.listProjectTurns(projectId)
  for (const id of projectSessionIds(service, projectId)) {
    if (id === excludeSessionId) continue
    const agent = agents.get(id as SessionId)
    if (agent !== undefined && !matchesBoundSession(service, id, agent)) {
      failed.push(id); continue
    }
    if (agent?.status !== 'running'
      || (!dedicated.has(id) && !activeJoinedTurn(agent, turns.filter(turn => turn.sessionId === id)))) continue
    try {
      agent.cancel({ kind: 'hook', reason: `Project ${projectId} paused` })
      interrupted.push(id)
    } catch { failed.push(id) }
  }
  return { interrupted, failed }
}

export async function inspectProjectRuntime(agents: Agents, sessions: Sessions,
  service: BizAgentService, projectId: string, excludeSessionId: string): Promise<ProjectRuntimeInspection> {
  const known = projectSessionIds(service, projectId).filter(id => id !== excludeSessionId)
  const dedicated = dedicatedProjectSessionIds(service, projectId)
  const participations = service.ledger.listProjectTurns(projectId)
  let listed: Awaited<ReturnType<Sessions['listSessions']>>
  try { listed = await sessions.listSessions() }
  catch { return { status: 'unknown', sessionIds: known } }
  const records = new Map(listed.map(item => [String(item.header.id), item]))
  const busy: string[] = []
  const unknown: string[] = []
  for (const id of known) {
    const live = agents.get(id as SessionId)
    if (live !== undefined && !matchesBoundSession(service, id, live)) {
      unknown.push(id); continue
    }
    const turns = participations.filter(item => item.sessionId === id)
    if (dedicated.has(id) && live?.status === 'running') { busy.push(id); continue }
    if (!dedicated.has(id) && activeJoinedTurn(live, turns)) { busy.push(id); continue }
    if (dedicated.has(id) && live !== undefined && live.status !== 'idle') {
      unknown.push(id); continue
    }
    if (dedicated.has(id) && live !== undefined
      && (live.inbox.nextTurn.length > 0 || live.inbox.nextStep.length > 0)) {
      unknown.push(id); continue
    }
    const record = records.get(id)
    if (record?.live && live === undefined) { unknown.push(id); continue }
    if (record === undefined) {
      if (turns.length > 0 || live !== undefined) unknown.push(id)
      continue
    }
    if (!record.persisted) { unknown.push(id); continue }
    try {
      const snapshot = await sessions.readSession(id as SessionId)
      const binding = service.ledger.getBinding(id)
      if (String(snapshot.session.id) !== id || binding === undefined
        || (binding.cwd !== undefined && snapshot.session.cwd !== binding.cwd)) {
        unknown.push(id); continue
      }
      const turns = snapshot.events.filter(event => event.type === 'turn/start' || event.type === 'turn/end')
      if (dedicated.has(id) || participations.filter(item => item.sessionId === id).length === 0) {
        if (turns.at(-1)?.type === 'turn/start') unknown.push(id)
      } else if (participations.some(item => item.sessionId === id
        && (!turns.some(event => event.type === 'turn/start' && event.data.turn === item.turn)
          || !turns.some(event => event.type === 'turn/end' && event.data.turn === item.turn)))) {
        unknown.push(id)
      }
    } catch { unknown.push(id) }
  }
  return busy.length > 0 ? { status: 'busy', sessionIds: busy }
    : unknown.length > 0 ? { status: 'unknown', sessionIds: unknown }
    : { status: 'quiet', sessionIds: [] }
}

/** Bind the optional human intervention route to the same runtime checks used by Agent tools. */
export function createProjectInterventionRuntimeHooks(agents: Agents, sessions: Sessions,
  service: BizAgentService, workRunner: Pick<WorkRunner, 'releaseWhenIdle'>) {
  return {
    afterPause: async (_principal: unknown, projectId: string, cancelledWorkIds: string[]) => {
      const interruption = interruptProjectSessions(agents, service, projectId, '')
      for (const workId of cancelledWorkIds) workRunner.releaseWhenIdle(workId)
      return interruption
    },
    inspectRuntime: async (_principal: unknown, projectId: string) =>
      inspectProjectRuntime(agents, sessions, service, projectId, ''),
  }
}
