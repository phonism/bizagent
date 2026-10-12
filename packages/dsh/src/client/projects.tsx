import { useEffect, useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { BIZAGENT_PROJECT_NODE_REVIEW_API,
  type UiProjectDetail, type UiProjectList, type UiProjectReviewAccess,
  type UiProjectNodeReviewAccess, type UiProjectInterventionAccess } from '../ui-contract.js'
import type { UiProjectNodeReviewInbox, UiProjectOutcomeReviewInbox } from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'
import { ProjectPlanPanel } from './project-plan.js'
import { ProjectNodeReviewInbox } from './project-node-review-inbox.js'
import { ProjectOutcomeReviewInbox } from './project-outcome-review-inbox.js'
import { ProjectDeliveryFeedbackPanel } from './project-delivery-feedback.js'
import { ProjectRoleAssignmentsPanel } from './project-role-assignments.js'
import { ProjectArtifactLink } from './project-artifact-link.js'

type T = PropsLocale<'bizagent'>['t']
type Project = UiProjectList['projects'][number]
type Bucket = 'paused' | 'blocked' | 'review' | 'waiting' | 'active' | 'accepted'

function bucket(project: Project, workflow?: UiProjectDetail['workflow']): Bucket {
  if (project.status === 'accepted') return 'accepted'
  if (project.status === 'awaiting_acceptance') return 'review'
  if (project.status === 'blocked') return 'blocked'
  if (project.intervention?.paused) return 'paused'
  if (workflow?.nodes.some(node => node.status === 'waiting')) return 'review'
  if (workflow?.nodes.some(node => node.status === 'running')) return 'waiting'
  return 'active'
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function ProjectsDashboard({ api, sessionId, onOpenMain, t }: {
  api: BizAgentUiPort
  sessionId: string | undefined
  onOpenMain?: (projectId: string) => Promise<void>
  t: T
}) {
  const [list, setList] = useState<UiProjectList>()
  const [detail, setDetail] = useState<UiProjectDetail>()
  const [selectedId, setSelectedId] = useState<string>()
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [moreBusy, setMoreBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [detailError, setDetailError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewInbox, setReviewInbox] = useState<UiProjectNodeReviewInbox | null>()
  const [reviewMoreBusy, setReviewMoreBusy] = useState(false)
  const [outcomeInbox, setOutcomeInbox] = useState<UiProjectOutcomeReviewInbox | null>()
  const [outcomeMoreBusy, setOutcomeMoreBusy] = useState(false)

  useEffect(() => {
    if (sessionId === undefined) { setList(undefined); setSelectedId(undefined); return }
    const abort = new AbortController()
    setLoading(true)
    setError(undefined)
    void api.projects(sessionId, undefined, abort.signal).then(next => {
      if (abort.signal.aborted) return
      setList(next)
      setSelectedId(current => next.projects.some(project => project.id === current)
        ? current : next.projects[0]?.id)
    }).catch(cause => { if (!abort.signal.aborted) setError(message(cause)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { abort.abort() }
  }, [api, sessionId, revision])

  useEffect(() => {
    if (!api.projectNodeReviewInbox) { setReviewInbox(null); return }
    const abort = new AbortController()
    setReviewInbox(undefined)
    void api.projectNodeReviewInbox(0, abort.signal)
      .then(next => { if (!abort.signal.aborted) setReviewInbox(next ?? null) })
      .catch(cause => { if (!abort.signal.aborted) { setError(message(cause)); setReviewInbox(null) } })
    return () => { abort.abort() }
  }, [api, revision])

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
    || ['paused', 'review'].includes(bucket(project, list?.progress[project.id]))),
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
        progress: { ...current.progress, ...next.progress },
        projects: [...current.projects, ...next.projects.filter(project =>
          !current.projects.some(existing => existing.id === project.id))],
      })
    } catch (cause) { setError(message(cause)) }
    finally { setMoreBusy(false) }
  }
  const loadMoreReviews = async (): Promise<void> => {
    if (!api.projectNodeReviewInbox || reviewInbox?.nextOffset === undefined || reviewMoreBusy) return
    setReviewMoreBusy(true)
    setError(undefined)
    try {
      const next = await api.projectNodeReviewInbox(reviewInbox.nextOffset)
      if (next) setReviewInbox(current => current == null ? next : {
        ...next, items: [...current.items, ...next.items.filter(item =>
          !current.items.some(existing => existing.projectId === item.projectId
            && existing.nodeId === item.nodeId && existing.workId === item.workId))],
      })
    } catch (cause) { setError(message(cause)) }
    finally { setReviewMoreBusy(false) }
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
        {reviewOpen || (reviewInbox !== null && reviewInbox !== undefined)
          || (outcomeInbox !== null && outcomeInbox !== undefined) ? <button type="button" className="ba-button"
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
      {reviewInbox === undefined || outcomeInbox === undefined
        ? <p className="ba-projects-empty">{t('projects.loadingReviews')}</p> : null}
      {reviewInbox !== undefined && reviewInbox !== null
        ? <ProjectNodeReviewInbox inbox={reviewInbox} api={api} t={t}
          onReviewed={() => { setRevision(current => current + 1) }}
          onMore={() => { void loadMoreReviews() }} moreBusy={reviewMoreBusy} /> : null}
      {outcomeInbox !== undefined && outcomeInbox !== null
        ? <ProjectOutcomeReviewInbox inbox={outcomeInbox} api={api} t={t}
          onReviewed={() => { setRevision(current => current + 1) }}
          onMore={() => { void loadMoreOutcomes() }} moreBusy={outcomeMoreBusy} /> : null}
      {reviewInbox === null && outcomeInbox === null
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
              <span className="ba-projects-status" data-status={bucket(project, list.progress[project.id])}>
                {t(`projects.status.${bucket(project, list.progress[project.id])}`)}
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
  const { project, workflow, work } = detail
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
        <span className="ba-projects-status" data-status={bucket(project, detail.workflow)}>
          {t(`projects.status.${bucket(project, detail.workflow)}`)}
        </span>
        <h4>{project.title}</h4>
        <code>{project.id}</code>
      </div>
      <span className="ba-projects-revision">{t('projects.revision', { revision: project.revision })}</span>
      {project.driver && onOpenMain ? <button type="button" className="ba-button"
        onClick={() => { void onOpenMain(project.id).catch(cause => { setError(message(cause)) }) }}>
        {t('projects.openMain')}</button> : null}
    </div>
    {project.intervention?.paused ? <p className="ba-projects-pause">
      <strong>{t('projects.paused')}</strong>
      {project.intervention.history.at(-1)?.reason}
    </p> : null}
    {project.status === 'blocked' && project.humanHandoffs?.at(-1) ? <section className="ba-projects-section">
      <h5>{t('projects.humanHandoffTitle')}</h5>
      <p><strong>{project.humanHandoffs.at(-1)!.question}</strong></p>
      <p>{project.humanHandoffs.at(-1)!.reason}</p>
      <p>{t('projects.humanHandoffAssignee')}: <code>{project.humanHandoffs.at(-1)!.assignee}</code></p>
      {project.humanHandoffs.at(-1)!.fallbackRecipient ? <p>
        {t('projects.humanHandoffFallback')}: <code>{project.humanHandoffs.at(-1)!.fallbackRecipient}</code>
      </p> : null}
      {project.humanHandoffs.at(-1)!.options ? <ul>{project.humanHandoffs.at(-1)!.options!.map(option =>
        <li key={option.label}>{option.label}{option.detail ? ` — ${option.detail}` : ''}</li>)}</ul> : null}
      <p>{t('projects.humanHandoffHint')}</p>
    </section> : null}
    <dl className="ba-projects-brief">
      <div><dt>{t('projects.goal')}</dt><dd>{project.goal}</dd></div>
      <div><dt>{t('projects.doneWhen')}</dt><dd>{project.doneWhen}</dd></div>
      <div><dt>{t('projects.lead')}</dt><dd><code>{project.lead}</code></dd></div>
    </dl>
    {['open', 'blocked'].includes(project.status) ? <ProjectIntervention project={project} api={api} t={t}
      onChanged={onAccepted} /> : null}
    {workflow ? <section className="ba-projects-section">
      <div className="ba-projects-section-head">
        <h5>{t('projects.workflow')}</h5>
        <span>{t('projects.workflowRevision', { revision: project.workflow?.revision ?? 1 })}</span>
      </div>
      <ol className="ba-projects-steps">
        {workflow.nodes.map(node => {
          const step = project.workflow?.steps.find(item => item.id === node.id)
          const result = work.find(item => item.id === node.latestWorkId)
          const reviewGate = result?.workflowReview
          const reviewerHome = reviewGate?.mode === 'reviewed' ? reviewGate.reviewerHome
            : reviewGate?.mode === 'automatic' ? undefined : step?.reviewer
          const reviewCriteria = reviewGate?.mode === 'reviewed' ? reviewGate.criteria
            : step?.reviewCriteria ?? ''
          return <li key={node.id} data-status={node.status}>
            <span className="ba-projects-node-mark" aria-hidden="true" />
            <div>
              <div className="ba-projects-node-head"><strong>{node.title}</strong>
                <span>{t(`projects.node.${node.status}`)}</span></div>
              <p>{step?.intent}</p>
              <small>{node.executor} {node.attempts > 0 ? `· ${t('projects.attempts', { count: node.attempts })}` : ''}</small>
              {node.status === 'waiting' && reviewerHome ? <p className="ba-projects-reviewer">
                {t('projects.reviewer')}: {reviewerHome}</p> : null}
              {node.status === 'waiting' && node.latestWorkId
                && project.nodeReviewerAssignments?.some(item => item.workId === node.latestWorkId)
                ? <p className="ba-projects-reviewer">{t('projects.currentReviewer')}: {
                  project.nodeReviewerAssignments.findLast(item => item.workId === node.latestWorkId)
                    ?.assignedPrincipal}</p> : null}
              {node.latestWorkId ? <code>{node.latestWorkId} · {node.latestWorkStatus}</code> : null}
              {node.status === 'waiting' && reviewerHome && node.latestWorkId
                ? <ProjectNodeReview project={project} nodeId={node.id}
                  workId={node.latestWorkId} reviewCriteria={reviewCriteria}
                  work={result} api={api} t={t}
                  onReviewed={onAccepted} /> : null}
            </div>
          </li>
        })}
      </ol>
      <ProjectPlanPanel key={`${project.id}:${project.revision}`} detail={detail} api={api} t={t}
        onChanged={onAccepted} />
    </section> : <section className="ba-projects-section">
      <h5>{t('projects.workflow')}</h5><p>{t('projects.noWorkflow')}</p>
    </section>}
    {work.length > 0 && !workflow ? <section className="ba-projects-section">
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
      <p>{currentClaim.body}</p>
      <div className="ba-projects-claim-evidence">
        <strong>{t('projects.assessment')}</strong>
        <p>{currentClaim.doneWhenAssessment}</p>
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
    <ProjectDeliveryFeedbackPanel projectId={project.id}
      revision={project.revision} api={api} t={t} onChanged={onAccepted} />
    <ProjectRoleAssignmentsPanel projectId={project.id}
      revision={project.revision} api={api} t={t} onChanged={onAccepted} />
  </>
}

function ProjectIntervention({ project, api, t, onChanged }: {
  project: Project; api: BizAgentUiPort; t: T; onChanged: () => void
}) {
  const [access, setAccess] = useState<UiProjectInterventionAccess>()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!api.projectInterventionAccess) { setAccess(undefined); return }
    const abort = new AbortController()
    setAccess(undefined)
    void api.projectInterventionAccess(project.id, abort.signal)
      .then(next => { if (!abort.signal.aborted) setAccess(next) })
      .catch(cause => { if (!abort.signal.aborted) setError(message(cause)) })
    return () => { abort.abort() }
  }, [api, project.id, project.revision])
  const current = access?.revision === project.revision
  if (!current || !api.projectInterventionAsHuman) return null
  const mutateIntervention = api.projectInterventionAsHuman
  const run = async (action: 'pause' | 'resume'): Promise<void> => {
    if (action === 'pause' && !reason.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await mutateIntervention(action === 'pause'
        ? { action, projectId: project.id, expectedRevision: project.revision, reason: reason.trim() }
        : { action, projectId: project.id, expectedRevision: project.revision })
      setReason('')
      onChanged()
    } catch (cause) {
      setError(message(cause))
      onChanged()
    } finally { setBusy(false) }
  }
  return <section className="ba-projects-section ba-projects-human-review">
    <h5>{t('projects.interventionTitle')}</h5>
    {access.canPause ? <>
      <p>{t('projects.pauseHint')}</p>
      <label>{t('projects.pauseReason')}
        <textarea maxLength={4000} value={reason}
          onChange={event => { setReason(event.target.value) }} /></label>
      <button type="button" className="ba-button" disabled={busy || !reason.trim()}
        onClick={() => { void run('pause') }}>{t('projects.pauseExecution')}</button>
    </> : null}
    {access.canResume ? <>
      <p>{t('projects.resumeHint')}</p>
      <button type="button" className="ba-button" data-variant="primary" disabled={busy}
        onClick={() => { void run('resume') }}>{t('projects.resumeExecution')}</button>
    </> : null}
    {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
  </section>
}

function ProjectNodeReview({ project, nodeId, workId, reviewCriteria, work, api, t, onReviewed }: {
  project: Project; nodeId: string; workId: string; reviewCriteria: string
  work: UiProjectDetail['work'][number] | undefined; api: BizAgentUiPort; t: T
  onReviewed: () => void
}) {
  const [access, setAccess] = useState<UiProjectNodeReviewAccess>()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!api.projectNodeReviewAccess) { setAccess(undefined); return }
    const abort = new AbortController()
    setAccess(undefined)
    void api.projectNodeReviewAccess(project.id, nodeId, abort.signal)
      .then(next => { if (!abort.signal.aborted) setAccess(next) })
      .catch(cause => { if (!abort.signal.aborted) setError(message(cause)) })
    return () => { abort.abort() }
  }, [api, project.id, project.revision, nodeId, workId])
  const current = access?.canReview && access.revision === project.revision
    && access.workId === workId
  const decide = async (decision: 'approve' | 'rework'): Promise<void> => {
    if (!current || !api.reviewProjectNodeAsHuman || !reason.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await api.reviewProjectNodeAsHuman({ projectId: project.id, nodeId, workId,
        expectedRevision: project.revision, decision, reason: reason.trim() })
      setReason('')
      onReviewed()
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  if (!current) return null
  return <div className="ba-projects-human-review">
    {reviewCriteria ? <p><strong>{t('projects.nodeReviewCriteria')}</strong> {reviewCriteria}</p> : null}
    {work?.resultSubject ? <p><strong>{work.resultSubject}</strong></p> : null}
    {work?.resultBody ? <p>{work.resultBody}</p> : null}
    {(work?.resultArtifacts?.length ?? 0) > 0 ? <ul>{work?.resultArtifacts?.map(item =>
      <li key={item.path}><code>{item.path}</code> · {item.bytes} B · <code>{item.sha256.slice(0, 12)}</code>
        {' · '}<a href={`${BIZAGENT_PROJECT_NODE_REVIEW_API}?${new URLSearchParams({
          projectId: project.id, nodeId, workId, artifactPath: item.path,
        })}`}>{t('projects.downloadArtifact')}</a></li>)}</ul> : null}
    <label>{t('projects.reviewReason')}
      <textarea value={reason} maxLength={4000} onChange={event => { setReason(event.target.value) }} />
    </label>
    <div>
      <button type="button" className="ba-button" data-variant="primary"
        disabled={busy || !reason.trim()} onClick={() => { void decide('approve') }}>
        {t('projects.approveNode')}</button>
      <button type="button" className="ba-button" disabled={busy || !reason.trim()}
        onClick={() => { void decide('rework') }}>{t('projects.returnForRework')}</button>
    </div>
    {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
  </div>
}
