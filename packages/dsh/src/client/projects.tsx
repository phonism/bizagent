import { useEffect, useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UiProjectDetail, UiProjectList, UiProjectReviewAccess,
  UiProjectOutcomeReviewInbox } from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'
import { ProjectOutcomeReviewInbox } from './project-outcome-review-inbox.js'
import { ProjectArtifactLink } from './project-artifact-link.js'
import { MarkdownBody } from './markdown.js'

type T = PropsLocale<'bizagent'>['t']
type Project = UiProjectList['projects'][number]
type Bucket = 'review' | 'active' | 'accepted'

function bucket(project: Project): Bucket {
  if (project.status === 'accepted') return 'accepted'
  if (project.status === 'awaiting_acceptance') return 'review'
  return 'active'
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function ProjectsDashboard({ api, sessionId, initialProjectId, onOpenMain, t }: {
  api: BizAgentUiPort
  sessionId: string | undefined
  initialProjectId?: string | undefined
  onOpenMain?: (projectId: string) => Promise<void>
  t: T
}) {
  const [list, setList] = useState<UiProjectList>()
  const [detail, setDetail] = useState<UiProjectDetail>()
  const [selectedId, setSelectedId] = useState<string | undefined>(initialProjectId)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [moreBusy, setMoreBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [detailError, setDetailError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [outcomeInbox, setOutcomeInbox] = useState<UiProjectOutcomeReviewInbox | null>()
  const [outcomeMoreBusy, setOutcomeMoreBusy] = useState(false)

  useEffect(() => { if (initialProjectId) setSelectedId(initialProjectId) }, [initialProjectId])

  useEffect(() => {
    if (sessionId === undefined) { setList(undefined); setSelectedId(undefined); return }
    const abort = new AbortController()
    setLoading(true)
    setError(undefined)
    void api.projects(sessionId, undefined, abort.signal).then(async next => {
      // A deep link may address a Project outside the first page; read it with the same
      // Session authorization, then pin its real record into this view.
      if (initialProjectId && !next.projects.some(project => project.id === initialProjectId)) {
        const target = await api.projectDetail(sessionId, initialProjectId, abort.signal)
        next = { ...next, projects: [target.project, ...next.projects] }
      }
      if (abort.signal.aborted) return
      setList(next)
      setSelectedId(current => next.projects.some(project => project.id === current)
        ? current : next.projects[0]?.id)
    }).catch(cause => { if (!abort.signal.aborted) setError(message(cause)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { abort.abort() }
  }, [api, sessionId, revision, initialProjectId])

  useEffect(() => {
    if (!api.projectOutcomeReviewInbox) { setOutcomeInbox(null); return }
    const abort = new AbortController()
    setOutcomeInbox(undefined)
    void api.projectOutcomeReviewInbox(0, abort.signal)
      .then(next => { if (!abort.signal.aborted) setOutcomeInbox(next ?? null) })
      .catch(cause => { if (!abort.signal.aborted) { setError(message(cause)); setOutcomeInbox(null) } })
    return () => { abort.abort() }
  }, [api, revision])

  useEffect(() => {
    if (sessionId === undefined || selectedId === undefined) { setDetail(undefined); return }
    const abort = new AbortController()
    setDetail(undefined)
    setDetailError(undefined)
    void api.projectDetail(sessionId, selectedId, abort.signal)
      .then(next => { if (!abort.signal.aborted) setDetail(next) })
      .catch(cause => { if (!abort.signal.aborted) setDetailError(message(cause)) })
    return () => { abort.abort() }
  }, [api, sessionId, selectedId, revision])

  const visible = useMemo(() => (list?.projects ?? []).filter(project => !attentionOnly
    || bucket(project) === 'review'),
  [attentionOnly, list])
  useEffect(() => {
    if (list !== undefined && !visible.some(project => project.id === selectedId)) {
      setSelectedId(visible[0]?.id)
    }
  }, [list, selectedId, visible])
  const selected = detail?.project.id === selectedId ? detail : undefined
  const loadMore = async (): Promise<void> => {
    if (sessionId === undefined || list?.nextBeforeProjectId === undefined || moreBusy) return
    setMoreBusy(true)
    setError(undefined)
    try {
      const next = await api.projects(sessionId, list.nextBeforeProjectId)
      setList(current => current === undefined ? next : {
        ...next,
        projects: [...current.projects, ...next.projects.filter(project =>
          !current.projects.some(existing => existing.id === project.id))],
      })
    } catch (cause) { setError(message(cause)) }
    finally { setMoreBusy(false) }
  }
  const loadMoreOutcomes = async (): Promise<void> => {
    if (!api.projectOutcomeReviewInbox || outcomeInbox?.nextOffset === undefined || outcomeMoreBusy) return
    setOutcomeMoreBusy(true)
    setError(undefined)
    try {
      const next = await api.projectOutcomeReviewInbox(outcomeInbox.nextOffset)
      if (next) setOutcomeInbox(current => current == null ? next : {
        ...next, items: [...current.items, ...next.items.filter(item =>
          !current.items.some(existing => existing.projectId === item.projectId
            && existing.claimId === item.claimId))],
      })
    } catch (cause) { setError(message(cause)) }
    finally { setOutcomeMoreBusy(false) }
  }

  return <div className="ba-projects-shell">
    <header className="ba-projects-heading">
      <div>
        <h3>{t('projects.title')}</h3>
        <p>{t('projects.subtitle')}</p>
      </div>
      <div className="ba-projects-heading-actions">
        {reviewOpen || (outcomeInbox !== null && outcomeInbox !== undefined) ? <button type="button" className="ba-button"
          onClick={() => { setReviewOpen(current => !current) }}>
          {reviewOpen ? t('projects.back') : t('projects.myReviewQueue')}
        </button> : null}
        <button type="button" className="ba-button" disabled={loading || (sessionId === undefined && !reviewOpen)}
          onClick={() => { setRevision(current => current + 1) }}>{t('projects.refresh')}</button>
      </div>
    </header>
    {sessionId === undefined && !reviewOpen ? <p className="ba-projects-empty">{t('projects.noSession')}</p> : null}
    {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
    {loading && list === undefined && !reviewOpen ? <p className="ba-projects-empty">{t('projects.loading')}</p> : null}
    {reviewOpen ? <>
      {outcomeInbox === undefined
        ? <p className="ba-projects-empty">{t('projects.loadingReviews')}</p> : null}
      {outcomeInbox !== undefined && outcomeInbox !== null
        ? <ProjectOutcomeReviewInbox inbox={outcomeInbox} api={api} t={t}
          onReviewed={() => { setRevision(current => current + 1) }}
          onMore={() => { void loadMoreOutcomes() }} moreBusy={outcomeMoreBusy} /> : null}
      {outcomeInbox === null
        ? <p className="ba-projects-empty">{t('projects.reviewsUnavailable')}</p> : null}
    </> : null}
    {list !== undefined && !reviewOpen ? <div className="ba-projects-layout">
      <aside className="ba-projects-directory" aria-label={t('projects.list')}>
        <div className="ba-projects-directory-head">
          <strong>{t('projects.list')}</strong>
          <span>{list.projects.length}</span>
        </div>
        <label className="ba-projects-filter">
          <input type="checkbox" checked={attentionOnly} onChange={event => { setAttentionOnly(event.target.checked) }} />
          {t('projects.attention')}
        </label>
        {visible.length === 0 ? <p className="ba-projects-empty">{t(attentionOnly ? 'projects.noAttention' : 'projects.empty')}</p> : null}
        <div className="ba-projects-list">
          {visible.map(project => <button type="button" key={project.id}
            className="ba-projects-row" data-selected={selectedId === project.id ? 'true' : 'false'}
            aria-pressed={selectedId === project.id}
            onClick={() => { setSelectedId(project.id) }}>
            <span className="ba-projects-row-top">
              <strong>{project.title}</strong>
              <span className="ba-projects-status" data-status={bucket(project)}>
                {t(`projects.status.${bucket(project)}`)}
              </span>
            </span>
            <span className="ba-projects-row-goal">{project.goal}</span>
            <small>{project.lead} · {project.updatedAt.slice(0, 10)}</small>
          </button>)}
        </div>
        {list.nextBeforeProjectId ? <button type="button" className="ba-button ba-projects-more"
          disabled={moreBusy} onClick={() => { void loadMore() }}>{t('projects.more')}</button> : null}
      </aside>
      <main className="ba-projects-detail">
        {detailError ? <p className="ba-inline-error" role="alert">{detailError}</p>
          : selected === undefined ? <p className="ba-projects-empty">{selectedId ? t('projects.loadingDetail') : t('projects.select')}</p>
          : <ProjectDetail key={selected.project.id} detail={selected} api={api}
            {...(onOpenMain === undefined ? {} : { onOpenMain })}
            t={t}
            onAccepted={() => { setRevision(current => current + 1) }} />}
      </main>
    </div> : null}
  </div>
}

function ProjectDetail({ detail, api, onOpenMain, t, onAccepted }: {
  detail: UiProjectDetail; api: BizAgentUiPort; t: T
  onOpenMain?: (projectId: string) => Promise<void>
  onAccepted: () => void
}) {
  const { project, work } = detail
  const currentClaim = project.claims.find(claim => claim.id === project.currentClaimId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [reviewAccess, setReviewAccess] = useState<UiProjectReviewAccess>()
  const [reviewReason, setReviewReason] = useState('')
  useEffect(() => {
    if (!currentClaim || !api.projectReviewAccess) {
      setReviewAccess(undefined)
      return
    }
    const abort = new AbortController()
    setReviewAccess(undefined)
    void api.projectReviewAccess(project.id, abort.signal)
      .then(access => { if (!abort.signal.aborted) setReviewAccess(access) })
      .catch(cause => { if (!abort.signal.aborted) setError(message(cause)) })
    return () => { abort.abort() }
  }, [api, project.id, project.revision, currentClaim?.id])
  const review = async (decision: 'accept' | 'rework'): Promise<void> => {
    if (!currentClaim || !api.reviewProjectAsHuman || !reviewReason.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await api.reviewProjectAsHuman({ projectId: project.id, claimId: currentClaim.id,
        expectedRevision: project.revision, decision, reason: reviewReason.trim() })
      setReviewReason('')
      onAccepted()
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  return <>
    <div className="ba-projects-detail-head">
      <div>
        <span className="ba-projects-status" data-status={bucket(project)}>
          {t(`projects.status.${bucket(project)}`)}
        </span>
        <h4>{project.title}</h4>
        <code>{project.id}</code>
      </div>
      <span className="ba-projects-revision">{t('projects.revision', { revision: project.revision })}</span>
      {project.driver && onOpenMain ? <button type="button" className="ba-button"
        onClick={() => { void onOpenMain(project.id).catch(cause => { setError(message(cause)) }) }}>
        {t('projects.openMain')}</button> : null}
    </div>
    <dl className="ba-projects-brief">
      <div><dt>{t('projects.goal')}</dt><dd>{project.goal}</dd></div>
      <div><dt>{t('projects.doneWhen')}</dt><dd>{project.doneWhen}</dd></div>
      <div><dt>{t('projects.lead')}</dt><dd><code>{project.lead}</code></dd></div>
    </dl>
    {work.length > 0 ? <section className="ba-projects-section">
      <h5>{t('projects.work')}</h5>
      <ul className="ba-projects-work">{work.map(item => <li key={item.id}>
        <strong>{item.goal}</strong><span>{item.status}</span><small>{item.assignee}</small>
      </li>)}</ul>
    </section> : null}
    {(project.seats?.length ?? 0) > 0 ? <section className="ba-projects-section">
      <h5>{t('projects.seats')}</h5>
      <ul className="ba-projects-seats">{project.seats?.map(seat => <li key={seat.id}>
        <code>{seat.homeAddress}</code><span>{seat.responsibility}</span>
        <small>{seat.status}</small>
      </li>)}</ul>
    </section> : null}
    {currentClaim ? <section className="ba-projects-section ba-projects-claim">
      <h5>{t('projects.claim')}</h5>
      <strong>{currentClaim.summary}</strong>
      <MarkdownBody text={currentClaim.body} t={t} />
      <div className="ba-projects-claim-evidence">
        <strong>{t('projects.assessment')}</strong>
        <MarkdownBody text={currentClaim.doneWhenAssessment} t={t} />
        {(currentClaim.artifacts?.length ?? 0) > 0 ? <ul>{currentClaim.artifacts?.map(item =>
          <li key={item.path}><code>{item.path}</code> · {item.bytes} B · <code>{item.sha256.slice(0, 12)}</code>
            {reviewAccess?.revision === project.revision ? <> · <ProjectArtifactLink api={api}
              projectId={project.id} claimId={currentClaim.id} artifactPath={item.path}
              label={t('projects.downloadArtifact')} errorLabel={t('projects.downloadFailed')} /></> : null}</li>)}</ul> : null}
        {currentClaim.work.length > 0 ? <ul>{currentClaim.work.map(item =>
          <li key={item.id}><code>{item.id}</code> · {item.status}</li>)}</ul> : null}
      </div>
      <small>{t('projects.claimReview')}: {project.reviews.findLast(item => item.claimId === currentClaim.id)?.decision
        ?? t('projects.pendingReview')}</small>
      {reviewAccess?.outcomeReworkNotification?.claimId === currentClaim.id ? <p role="status">
        {reviewAccess.outcomeReworkNotification.state === 'pending'
          ? t('projects.outcomeReworkNoticePending') : t('projects.outcomeReworkNoticeDelivered')}
      </p> : null}
      {project.status === 'awaiting_acceptance' && reviewAccess?.canReview
        && reviewAccess.revision === project.revision && reviewAccess.claimId === currentClaim.id
        && api.reviewProjectAsHuman ? <div className="ba-projects-human-review">
          <label>{t('projects.reviewReason')}
            <textarea value={reviewReason} maxLength={4000}
              onChange={event => { setReviewReason(event.target.value) }} /></label>
          <div>
            <button type="button" className="ba-button" data-variant="primary"
              disabled={busy || !reviewReason.trim()} onClick={() => { void review('accept') }}>
              {t('projects.acceptResult')}</button>
            <button type="button" className="ba-button" disabled={busy || !reviewReason.trim()}
              onClick={() => { void review('rework') }}>{t('projects.returnForRework')}</button>
          </div>
          {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
        </div> : null}
    </section> : null}
  </>
}
