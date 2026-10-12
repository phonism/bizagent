import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { BIZAGENT_PROJECT_NODE_REVIEW_API, type UiProjectNodeReviewInbox } from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'

type T = PropsLocale<'bizagent'>['t']
type Item = UiProjectNodeReviewInbox['items'][number]

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function ReviewCard({ item, api, t, onReviewed }: {
  item: Item; api: BizAgentUiPort; t: T; onReviewed: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const decide = async (decision: 'approve' | 'rework'): Promise<void> => {
    if (!api.reviewProjectNodeAsHuman || !reason.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await api.reviewProjectNodeAsHuman({ projectId: item.projectId, nodeId: item.nodeId,
        workId: item.workId, expectedRevision: item.revision, decision, reason: reason.trim() })
      onReviewed()
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  return <article className="ba-projects-inbox-card">
    <div className="ba-projects-section-head">
      <strong>{item.projectTitle} · {item.nodeTitle}</strong>
      <span>{item.completedAt.slice(0, 16).replace('T', ' ')}</span>
    </div>
    <small>{t('projects.reviewer')}: {item.reviewerHome} · {item.workId}</small>
    <p><strong>{t('projects.nodeReviewCriteria')}</strong> {item.reviewCriteria}</p>
    <p><strong>{item.resultSubject}</strong></p>
    <p>{item.resultBody}</p>
    {item.resultArtifacts.length > 0 ? <ul>{item.resultArtifacts.map(artifact =>
      <li key={artifact.path}><code>{artifact.path}</code> · {artifact.bytes} B · <code>{artifact.sha256.slice(0, 12)}</code>
        {' · '}<a href={`${BIZAGENT_PROJECT_NODE_REVIEW_API}?${new URLSearchParams({
          projectId: item.projectId, nodeId: item.nodeId, workId: item.workId,
          artifactPath: artifact.path,
        })}`}>{t('projects.downloadArtifact')}</a></li>)}</ul> : null}
    <label>{t('projects.reviewReason')}
      <textarea value={reason} maxLength={4000} onChange={event => { setReason(event.target.value) }} />
    </label>
    <div className="ba-projects-inbox-actions">
      <button type="button" className="ba-button" data-variant="primary"
        disabled={busy || !reason.trim()} onClick={() => { void decide('approve') }}>
        {t('projects.approveNode')}</button>
      <button type="button" className="ba-button" disabled={busy || !reason.trim()}
        onClick={() => { void decide('rework') }}>{t('projects.returnForRework')}</button>
    </div>
    {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
  </article>
}

export function ProjectNodeReviewInbox({ inbox, api, t, onReviewed, onMore, moreBusy }: {
  inbox: UiProjectNodeReviewInbox; api: BizAgentUiPort; t: T
  onReviewed: () => void; onMore: () => void; moreBusy: boolean
}) {
  return <section className="ba-projects-inbox">
    <h4>{t('projects.myReviews')}</h4>
    <p>{t('projects.myReviewsHint')}</p>
    {inbox.items.length === 0 ? <p>{t('projects.noMyReviews')}</p> : null}
    <div className="ba-projects-inbox-list">{inbox.items.map(item =>
      <ReviewCard key={`${item.projectId}:${item.nodeId}:${item.workId}`} item={item}
        api={api} t={t} onReviewed={onReviewed} />)}</div>
    {inbox.nextOffset !== undefined ? <button type="button" className="ba-button"
      disabled={moreBusy} onClick={onMore}>{t('projects.more')}</button> : null}
  </section>
}
