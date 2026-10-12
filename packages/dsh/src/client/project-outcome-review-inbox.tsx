import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UiProjectOutcomeReviewInbox } from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'
import { ProjectArtifactLink } from './project-artifact-link.js'

type T = PropsLocale<'bizagent'>['t']
type Item = UiProjectOutcomeReviewInbox['items'][number]

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function OutcomeCard({ item, api, t, onReviewed }: {
  item: Item; api: BizAgentUiPort; t: T; onReviewed: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const decide = async (decision: 'accept' | 'rework'): Promise<void> => {
    if (!api.reviewProjectAsHuman || !reason.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await api.reviewProjectAsHuman({ projectId: item.projectId, claimId: item.claimId,
        expectedRevision: item.revision, decision, reason: reason.trim() })
      onReviewed()
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  return <article className="ba-projects-inbox-card">
    <div className="ba-projects-section-head">
      <strong>{item.projectTitle}</strong>
      <span>{item.submittedAt.slice(0, 16).replace('T', ' ')}</span>
    </div>
    <small>{t('projects.lead')}: {item.lead} · {item.claimId}</small>
    <p><strong>{t('projects.goal')}:</strong> {item.goal}</p>
    <p><strong>{t('projects.doneWhen')}:</strong> {item.doneWhen}</p>
    <p><strong>{item.summary}</strong></p>
    <p>{item.body}</p>
    <p><strong>{t('projects.assessment')}:</strong> {item.doneWhenAssessment}</p>
    {item.artifacts.length > 0 ? <ul>{item.artifacts.map(artifact =>
      <li key={artifact.path}><code>{artifact.path}</code> · {artifact.bytes} B · <code>{artifact.sha256.slice(0, 12)}</code>
        {' · '}<ProjectArtifactLink api={api} projectId={item.projectId} claimId={item.claimId}
          artifactPath={artifact.path} label={t('projects.downloadArtifact')}
          errorLabel={t('projects.downloadFailed')} /></li>)}</ul> : null}
    {item.work.length > 0 ? <ul>{item.work.map(work =>
      <li key={work.id}><code>{work.id}</code> · {work.status}
        {work.resultSubject ? <p><strong>{work.resultSubject}</strong></p> : null}
        {work.resultBody ? <p>{work.resultBody}</p> : null}
        {work.status === 'completed' && !work.resultBody
          ? <p>{t('projects.workEvidenceUnavailable')}</p> : null}
        {(work.resultArtifacts?.length ?? 0) > 0 ? <ul>{work.resultArtifacts?.map(artifact =>
          <li key={artifact.path}><code>{artifact.path}</code> · {artifact.bytes} B · <code>{artifact.sha256.slice(0, 12)}</code>
            {' · '}<ProjectArtifactLink api={api} projectId={item.projectId}
              claimId={item.claimId} workId={work.id} artifactPath={artifact.path}
              label={t('projects.downloadArtifact')} errorLabel={t('projects.downloadFailed')} /></li>)}</ul> : null}</li>)}</ul> : null}
    <label>{t('projects.reviewReason')}
      <textarea value={reason} maxLength={4000} onChange={event => { setReason(event.target.value) }} />
    </label>
    <div className="ba-projects-inbox-actions">
      <button type="button" className="ba-button" data-variant="primary"
        disabled={busy || !reason.trim()} onClick={() => { void decide('accept') }}>
        {t('projects.acceptResult')}</button>
      <button type="button" className="ba-button" disabled={busy || !reason.trim()}
        onClick={() => { void decide('rework') }}>{t('projects.returnForRework')}</button>
    </div>
    {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
  </article>
}

export function ProjectOutcomeReviewInbox({ inbox, api, t, onReviewed, onMore, moreBusy }: {
  inbox: UiProjectOutcomeReviewInbox; api: BizAgentUiPort; t: T
  onReviewed: () => void; onMore: () => void; moreBusy: boolean
}) {
  return <section className="ba-projects-inbox">
    <h4>{t('projects.myOutcomes')}</h4>
    <p>{t('projects.myOutcomesHint')}</p>
    {inbox.items.length === 0 ? <p>{t('projects.noMyOutcomes')}</p> : null}
    <div className="ba-projects-inbox-list">{inbox.items.map(item =>
      <OutcomeCard key={`${item.projectId}:${item.claimId}`} item={item} api={api} t={t}
        onReviewed={onReviewed} />)}</div>
    {inbox.nextOffset !== undefined ? <button type="button" className="ba-button"
      disabled={moreBusy} onClick={onMore}>{t('projects.more')}</button> : null}
  </section>
}
