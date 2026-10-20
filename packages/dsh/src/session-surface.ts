import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { BizAgentService } from './service.js'
import type { UiAgentRuntime, UiSessionActivity, UiSessionContext, UiSessionSummary } from './ui-contract.js'
import { principalSessionId, projectMainSessionId } from './agent-session-address.js'

type Runtime = (sessionId: string) => UiAgentRuntime

/** Lightweight sidebar data: no transcript reads and no creation of new Home bindings. */
export function sessionCatalog(service: BizAgentService, runtime: Runtime): UiSessionSummary[] {
  const works = service.workLedger?.list() ?? []
  const projects = service.projectLedger?.list() ?? []
  const learning = new Set(service.ledger.listLearningLaunches().map(item => item.workerSessionId))
  const mains = new Map(projects.map(project => [projectMainSessionId(project.id), project]))
  return service.ledger.listBindings().filter(binding => service.store.hasHome(binding.homeAddress)).map(binding => {
    const home = service.store.getHome(binding.homeAddress)
    const work = works.find(item => item.workerSessionId === binding.sessionId && item.assignee === home.address)
    const main = mains.get(binding.sessionId)
    const project = main ?? projects.find(item => item.id === work?.projectId)
    return {
      sessionId: binding.sessionId,
      home: { address: home.address, displayName: home.displayName,
        scope: service.store.isPersonalHome(home.address) ? 'personal' : 'organization' },
      runtime: runtime(binding.sessionId),
      kind: work ? 'work' : main ? 'project-main' : learning.has(binding.sessionId) ? 'learning'
        : service.ledger.getInboxWakeOrigin(binding.sessionId) ? 'inbox'
          : principalSessionId(home.address) === binding.sessionId ? 'principal' : 'conversation',
      ...(work ? { workId: work.id, workGoal: work.goal, workStatus: work.status } : {}),
      ...(project ? { projectId: project.id, projectTitle: project.title } : {}),
    }
  })
}

export async function sessionContext(service: BizAgentService, sessionId: string,
  cwd: string | undefined, events: readonly SessionEvent[], runtime: Runtime): Promise<UiSessionContext> {
  const frames = await service.frameStatusForSession(sessionId, cwd, events)
  const summary = sessionCatalog(service, runtime).find(item => item.sessionId === sessionId)
  if (!summary) throw new Error('Session has no available Home')
  const assets = service.store.listAssets(summary.home.address)
  const work = (service.workLedger?.list() ?? []).filter(item =>
    item.requester === summary.home.address && item.returnToSessionId === sessionId
    || item.assignee === summary.home.address && item.workerSessionId === sessionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  const ids = new Set(work.flatMap(item => item.projectId ? [item.projectId] : []))
  for (const participation of service.ledger.listProjectTurns()) {
    if (participation.sessionId === sessionId) ids.add(participation.projectId)
  }
  const projects = (service.projectLedger?.list() ?? []).filter(project =>
    (project.lead === summary.home.address || project.seats?.some(seat =>
      seat.homeAddress === summary.home.address && seat.status === 'active'))
    && (ids.has(project.id) || project.createdBySessionId === sessionId || summary.projectId === project.id))
  return {
    summary,
    frames: frames.state.frames.map(frame => ({ address: frame.address,
      displayName: service.store.hasHome(frame.address) ? service.store.getHome(frame.address).displayName : frame.address, mode: frame.mode,
      focused: frames.state.focusAddress === frame.address, refreshRequired: frames.staleFrames.includes(frame.address) })),
    home: { activeAssets: assets.filter(asset => asset.status === 'active').length,
      candidates: assets.filter(asset => asset.status === 'candidate').length,
      pendingProposals: service.ledger.listProposals({ toAddress: summary.home.address, status: 'pending' }).length },
    work: work.slice(0, 20).map(item => ({ id: item.id, goal: item.goal, requester: item.requester,
      assignee: item.assignee, status: item.status, updatedAt: item.updatedAt,
      requesterName: service.store.hasHome(item.requester) ? service.store.getHome(item.requester).displayName : item.requester,
      assigneeName: service.store.hasHome(item.assignee) ? service.store.getHome(item.assignee).displayName : item.assignee,
      returnToSessionId: item.returnToSessionId,
      runtime: item.workerSessionId ? runtime(item.workerSessionId) : 'unloaded',
      ...(item.workerSessionId ? { workerSessionId: item.workerSessionId } : {}),
      ...(item.projectId ? { projectId: item.projectId } : {}),
      ...(item.resultSubject ? { resultSubject: item.resultSubject } : {}),
      ...(item.resultBody ? { resultBody: item.resultBody } : {}),
      ...(item.resultArtifacts ? { resultArtifacts: item.resultArtifacts } : {}),
    })),
    projects: projects.slice(0, 20).map(project => ({ id: project.id, title: project.title,
      status: project.status, goal: project.goal })),
    activity: sessionActivity(events).slice(-100), moreWork: work.length > 20,
  }
}

const ACTIONS: Record<string, UiSessionActivity['kind']> = {
  bizagent_memory_remember: 'memory', bizagent_memory_update: 'memory',
  bizagent_learning_checkpoint: 'learning', bizagent_memory_propose: 'proposal',
  bizagent_knowledge_propose: 'proposal', bizagent_work_dispatch: 'work',
  bizagent_work_start: 'work', bizagent_work_accept: 'work', bizagent_work_complete: 'work',
  bizagent_work_cancel: 'work', bizagent_project_create: 'project', bizagent_project_submit: 'project',
  bizagent_project_review: 'project', bizagent_frame_open: 'frame', bizagent_learning_launch: 'learning',
  bizagent_learning_batch_settle: 'learning', bizagent_worklog_record: 'learning',
}

/** Project successful durable results only; a tool call alone is never evidence of success. */
export function sessionActivity(events: readonly SessionEvent[]): UiSessionActivity[] {
  const calls = new Map<string, { action: string; kind: UiSessionActivity['kind']; turn: number }>()
  const activity: UiSessionActivity[] = []
  for (const event of events) {
    if (event.type === 'tool/call' && ACTIONS[event.data.name]) {
      calls.set(String(event.data.callId), { action: event.data.name, kind: ACTIONS[event.data.name]!, turn: event.data.turn })
    }
    if (event.type !== 'tool/result' || event.data.error !== undefined || event.data.message.isError) continue
    const call = calls.get(String(event.data.message.toolCallId))
    if (!call) continue
    calls.delete(String(event.data.message.toolCallId))
    const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (text.length > 256 * 1024) continue
    try {
      const value = JSON.parse(text) as Record<string, unknown>
      if (!value || typeof value !== 'object' || value.error) continue
      const entity = [value.asset, value.work, value.project, value.proposal, value.checkpoint]
        .find(item => item && typeof item === 'object') as Record<string, unknown> | undefined
      const title = entity?.title ?? entity?.description ?? entity?.goal ?? entity?.reason
      activity.push({ id: `activity-${event.seq}`, seq: event.seq, turn: call.turn, kind: call.kind,
        action: call.action, title: typeof title === 'string' ? title.slice(0, 300) : '',
        ...(typeof entity?.status === 'string' ? { status: entity.status } : {}),
        ...(typeof entity?.id === 'string' ? { entityId: entity.id } : {}) })
    } catch { /* Foreign or malformed results stay available in DSH's original tool detail. */ }
  }
  return activity
}
