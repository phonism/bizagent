import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { UiSessionActivity, UiSessionContext, UiSessionSummary } from '../ui-contract.js'
import type { DashboardTarget } from './controller.js'
import type { SessionSurfaces } from './session-resource.js'
import { homeName } from './home-name.js'
import { MarkdownBody } from './markdown.js'

export interface SessionSurfaceFace {
  surfaces: SessionSurfaces
  openDashboard: (target?: DashboardTarget) => void
  openSession: (sessionId: string) => Promise<void>
}
type Locale = PropsLocale<'bizagent'>
type T = Locale['t']
type Face = InjectFace<SessionSurfaceFace>
type HeaderProps = PropsRuntime<'conversation.session.header.actions'> & Locale & Face
type ViewProps = PropsRuntime<'conversation.view'> & Locale & Face
type LeadingProps = PropsRuntime<'sidebar.session.row.leading'> & Locale & Face
type HoverProps = PropsRuntime<'sidebar.session.row.hover'> & Locale & Face
type MenuProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> & Locale & Face
type TailProps = PropsRuntime<'conversation.chat.turnTail'> & Locale & Face

const subscribeNothing = () => () => undefined
function useContext(surfaces: SessionSurfaces, sessionId: string, running: boolean, enabled = true) {
  const resource = useMemo(() => surfaces.context(sessionId), [surfaces, sessionId])
  const state = useSyncExternalStore(enabled ? resource.subscribe : subscribeNothing, resource.getSnapshot)
  useEffect(() => { if (enabled) { void resource.refresh(); void surfaces.catalog.refresh() } }, [resource, surfaces, running, enabled])
  return { ...state, refresh: resource.refresh }
}

export function SessionHomeAction({ surfaces, sessionId, useSession, openDashboard, t }: HeaderProps) {
  const blank = useSession(session => session.blank || session.removed)
  const running = useSession(session => session.running)
  const { data, error } = useContext(surfaces, String(sessionId), running, !blank)
  if (blank) return null
  if (!data) return error ? <button type="button" className="ba-session-home"
    onClick={() => openDashboard()} title={error}>{t('sessionUI.unavailable')}</button> : null
  return <div className="ba-session-actions">
    <button type="button" className="ba-session-home" title={`${data.summary.home.address} · ${t(`sessionUI.kind.${data.summary.kind}`)}`}
      onClick={() => openDashboard({ view: 'learning', homeAddress: data.summary.home.address, sessionId: String(sessionId) })}>
      <span className="ba-session-symbol" aria-hidden="true">◈</span>
      <span>{homeName(data.summary.home, t)}{error ? ' · !' : ''}</span>
      {data.summary.kind !== 'conversation' ? <small>{t(`sessionUI.kind.${data.summary.kind}`)}</small> : null}
      {data.home.candidates + data.home.pendingProposals > 0 ? <span className="ba-count">
        {data.home.candidates + data.home.pendingProposals}</span> : null}
    </button>
    {data.summary.projectTitle && data.projects.some(project => project.id === data.summary.projectId) ? <button type="button" className="ba-session-project"
      onClick={() => openDashboard({ view: 'projects', projectId: data.summary.projectId!, sessionId: String(sessionId) })}>
      {data.summary.projectTitle}</button> : null}
  </div>
}

export function SessionQuickActions({ sessionId, surfaces, openDashboard, t }: HeaderProps) {
  const { data } = useSyncExternalStore(surfaces.inbox.subscribe, surfaces.inbox.getSnapshot)
  const pending = data?.messages.length ?? 0
  return <button type="button" className="ba-session-home" onClick={() => openDashboard({ view: 'humanInbox', sessionId: String(sessionId) })}>
    {t('nav.humanInbox')}{pending > 0 ? <span className="ba-count">{pending}{data?.nextBeforeMessageId ? '+' : ''}</span> : null}</button>
}

export function SessionRowLeading({ sessionId, surfaces, t }: LeadingProps) {
  const { data } = useSyncExternalStore(surfaces.catalog.subscribe, surfaces.catalog.getSnapshot)
  const summary = data?.sessions.find(item => item.sessionId === String(sessionId))
  if (!summary || summary.kind === 'conversation' && summary.home.scope === 'personal') return null
  return <span className="ba-session-row-mark" data-kind={summary.kind}
    title={`${homeName(summary.home, t)} · ${t(`sessionUI.kind.${summary.kind}`)}`}
    aria-label={`${homeName(summary.home, t)} · ${t(`sessionUI.kind.${summary.kind}`)}`}>
    {summary.kind === 'work' ? '↗' : summary.kind === 'project-main' ? '◇' : '◈'}</span>
}

export function SessionRowHover({ sessionId, surfaces, t }: HoverProps) {
  const { data } = useSyncExternalStore(surfaces.catalog.subscribe, surfaces.catalog.getSnapshot)
  const summary = data?.sessions.find(item => item.sessionId === String(sessionId))
  if (!summary) return null
  return <div className="ba-session-hover"><strong>{homeName(summary.home, t)}</strong>
    <span>{t(`sessionUI.kind.${summary.kind}`)}</span>
    {summary.projectTitle ? <span>{summary.projectTitle}</span> : null}
    {summary.workGoal ? <span>{summary.workGoal}</span> : null}
    {summary.workStatus ? <span>{t(`sessionUI.work.${summary.workStatus}`)}</span> : null}
  </div>
}

export function SessionRowMenu({ sessionId, surfaces, openDashboard, useMenuOpenState, t }: MenuProps) {
  const { data } = useSyncExternalStore(surfaces.catalog.subscribe, surfaces.catalog.getSnapshot)
  const summary = data?.sessions.find(item => item.sessionId === String(sessionId))
  const [, setOpen] = useMenuOpenState()
  if (!summary) return null
  return <button type="button" role="menuitem" className="ba-session-menu" onClick={() => {
    setOpen(false)
    openDashboard({ view: 'learning', homeAddress: summary.home.address, sessionId: String(sessionId) })
  }}>{t('sessionUI.openHome')}</button>
}

export function SessionWorkView({ sessionId, surfaces, openDashboard, openSession, useSession,
  viewRequest, completeViewRequest, t }: ViewProps) {
  const running = useSession(session => session.running)
  const { data, error, loading, refresh } = useContext(surfaces, String(sessionId), running)
  const [actionError, setActionError] = useState<string>()
  const [opening, setOpening] = useState<string>()
  const workRef = useMemo(() => new Map<string, HTMLElement>(), [])
  useEffect(() => {
    if (!viewRequest || !data) return
    const element = workRef.get(viewRequest.focus)
    element?.scrollIntoView({ block: 'center', behavior: 'instant' })
    element?.focus({ preventScroll: true })
    completeViewRequest()
  }, [data, viewRequest, workRef, completeViewRequest])
  const navigateSession = async (id: string) => {
    setOpening(id); setActionError(undefined)
    try { await openSession(id) }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setOpening(undefined) }
  }
  return <div className="ba-session-workspace">
    <header className="ba-session-workspace-header"><div><h2>{t('sessionUI.workView')}</h2>
      <p>{data ? homeName(data.summary.home, t) : t('sessionUI.loading')}</p></div>
      <button type="button" className="ba-button" disabled={loading} onClick={() => { void refresh() }}>{t('dashboard.refresh')}</button>
    </header>
    {error ? <p className="ba-inline-error" role="alert">{t('sessionUI.loadFailed')} {error}</p> : null}
    {actionError ? <p className="ba-inline-error" role="alert">{actionError}</p> : null}
    {data ? <>
      <div className="ba-session-home-summary">
        <span className="ba-session-symbol" aria-hidden="true">◈</span>
        <div><strong>{homeName(data.summary.home, t)}</strong><p>{t(`sessionUI.kind.${data.summary.kind}`)} · {t(`sessionUI.runtime.${data.summary.runtime}`)}</p></div>
        <button type="button" className="ba-button" onClick={() => openDashboard({ view: 'learning',
          homeAddress: data.summary.home.address, sessionId: String(sessionId) })}>
          {t('sessionUI.memoryCount', { count: data.home.activeAssets })}</button>
      </div>
      {data.home.candidates + data.home.pendingProposals > 0 ? <button type="button" className="ba-session-attention"
        onClick={() => openDashboard({ view: 'learning', homeAddress: data.summary.home.address, sessionId: String(sessionId) })}>
        {t('sessionUI.learningPending', { candidates: data.home.candidates, proposals: data.home.pendingProposals })}</button> : null}
      <section className="ba-session-section"><h3>{t('sessionUI.relatedWork')}</h3>
        <p className="ba-session-hint">{t('sessionUI.workHint')}</p>
        {data.work.length === 0 ? <p className="ba-session-empty">{t('sessionUI.noWork')}</p> : null}
        {data.work.map(work => <article key={work.id} className="ba-session-work-card" tabIndex={-1}
          ref={node => { if (node) workRef.set(work.id, node); else workRef.delete(work.id) }}>
          <div className="ba-session-card-title"><h4>{work.goal}</h4><span className="ba-work-status" data-status={work.status}>{t(`sessionUI.work.${work.status}`)}</span></div>
          <p className="ba-session-route"><span title={work.requester}>{work.requesterName}</span><span aria-hidden="true">→</span><span title={work.assignee}>{work.assigneeName}</span></p>
          {work.workerSessionId ? <p className="ba-session-hint">{t('sessionUI.worker')} · {t(`sessionUI.runtime.${work.runtime}`)}</p> : null}
          {work.resultSubject ? <details className="ba-session-result"><summary>{work.resultSubject}</summary>
            {work.resultBody ? <MarkdownBody text={work.resultBody.replace(`Completed Work ${work.id}\n\n`, '')} t={t} /> : null}
            {work.resultArtifacts?.map(artifact => <div key={artifact.path}><code>{artifact.path}</code> · {artifact.bytes} B</div>)}
          </details> : null}
          <div className="ba-session-card-actions">
            {work.workerSessionId && work.workerSessionId !== String(sessionId) ? <button type="button" className="ba-button" disabled={opening !== undefined}
              onClick={() => { void navigateSession(work.workerSessionId!) }}>{t('sessionUI.openWorker')}</button> : null}
            {work.returnToSessionId !== String(sessionId) ? <button type="button" className="ba-button" disabled={opening !== undefined}
              onClick={() => { void navigateSession(work.returnToSessionId) }}>{t('sessionUI.openRequester')}</button> : null}
            {work.projectId && data.projects.some(project => project.id === work.projectId) ? <button type="button" className="ba-button" onClick={() => openDashboard({ view: 'projects', projectId: work.projectId!, sessionId: String(sessionId) })}>{t('sessionUI.openProject')}</button> : null}
          </div>
        </article>)}
        {data.moreWork ? <p>{t('sessionUI.moreWork')}</p> : null}
      </section>
      {data.projects.length > 0 ? <section className="ba-session-section"><h3>{t('nav.projects')}</h3>
        {data.projects.map(project => <button type="button" key={project.id} className="ba-session-project-row"
          onClick={() => openDashboard({ view: 'projects', projectId: project.id, sessionId: String(sessionId) })}>
          <strong>{project.title}</strong><span>{t(`sessionUI.project.${project.status}`)}</span>
        </button>)}
      </section> : null}
      <section className="ba-session-section"><h3>{t('sessionUI.activity')}</h3>
        {data.activity.length === 0 ? <p className="ba-session-empty">{t('sessionUI.noActivity')}</p> : null}
        <ActivityList activity={[...data.activity].reverse()} home={data.summary.home}
          sessionId={String(sessionId)} openDashboard={openDashboard} t={t} />
      </section>
    </> : null}
  </div>
}

export function SessionTurnCard({ sessionId, turn, seq, surfaces, openDashboard, t }: TailProps) {
  const { data } = useSyncExternalStore(surfaces.context(String(sessionId)).subscribe, surfaces.context(String(sessionId)).getSnapshot)
  const activity = data?.activity.filter(item => item.turn === turn.turn && item.seq <= seq) ?? []
  if (!data || activity.length === 0) return null
  return <details className="ba-turn-receipt"><summary>{t('sessionUI.turnReceipt', { count: activity.length })}</summary>
    <ActivityList activity={activity} home={data.summary.home} sessionId={String(sessionId)} openDashboard={openDashboard} t={t} />
  </details>
}

function ActivityList({ activity, home, sessionId, openDashboard, t }: {
  activity: UiSessionActivity[]; home: UiSessionSummary['home']; sessionId: string;
  openDashboard: SessionSurfaceFace['openDashboard']; t: T
}) {
  return <ul className="ba-session-activity">{activity.map(item => <li key={item.id}>
    <span className="ba-session-activity-symbol" aria-hidden="true">{item.kind === 'work' ? '↗' : item.kind === 'memory' ? '◈' : '◇'}</span>
      <div><strong>{t(`sessionUI.activity.${item.kind}`)}</strong>{item.status ? <small>{t('sessionUI.recordedStatus', { status: activityStatus(item.status, item.kind, t) })}</small> : null}
      {item.title ? <p>{item.title}</p> : null}
    </div>
    {(item.kind === 'memory' || item.kind === 'proposal' || item.kind === 'project') ? <button type="button" className="ba-session-detail"
      onClick={() => openDashboard({ view: item.kind === 'project' ? 'projects' : 'learning',
        sessionId, homeAddress: home.address,
        ...(item.kind === 'project' && item.entityId ? { projectId: item.entityId } : {}),
        ...(item.kind === 'memory' && item.entityId ? { assetId: item.entityId } : {}) })}>{t('sessionUI.details')}</button> : null}
  </li>)}</ul>
}

function activityStatus(status: string, kind: UiSessionActivity['kind'], t: T): string {
  if (kind === 'project' && ['open', 'awaiting_acceptance', 'accepted'].includes(status)) return t(`sessionUI.project.${status}` as 'sessionUI.project.open')
  if (['active', 'candidate', 'retired', 'superseded'].includes(status)) return t(`status.${status}` as 'status.active')
  if (['open', 'accepted', 'completing', 'completed', 'cancelled'].includes(status)) return t(`sessionUI.work.${status}` as 'sessionUI.work.open')
  if (status === 'awaiting_acceptance') return t('sessionUI.project.awaiting_acceptance')
  return status
}
