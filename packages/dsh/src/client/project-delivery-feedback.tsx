import { useEffect, useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { BIZAGENT_PROJECT_DELIVERY_FEEDBACK_API,
  type UiProjectDeliveryFeedbackAccess } from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'

type T = PropsLocale<'bizagent'>['t']
const freshRequestId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

export function ProjectDeliveryFeedbackPanel({ projectId, revision, api, t, onChanged }: {
  projectId: string; revision: number; api: BizAgentUiPort; t: T; onChanged: () => void
}) {
  const [access, setAccess] = useState<UiProjectDeliveryFeedbackAccess>()
  const [selection, setSelection] = useState('')
  const [section, setSection] = useState('')
  const [body, setBody] = useState('')
  const [requestId, setRequestId] = useState(freshRequestId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!api.projectDeliveryFeedbackAccess) { setAccess(undefined); return }
    const abort = new AbortController()
    setAccess(undefined)
    void api.projectDeliveryFeedbackAccess(projectId, abort.signal)
      .then(next => { if (!abort.signal.aborted) setAccess(next) })
      .catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { abort.abort() }
  }, [api, projectId, revision])
  const assets = useMemo(() => [
    ...(access?.workingAssets ?? []).map(item => ({ ...item, version: 'working' as const,
      key: `working:${item.path}` })),
    ...(access?.submitted?.artifacts ?? []).map(item => ({ ...item, version: 'submitted' as const,
      key: `submitted:${item.path}` })),
  ], [access])
  const selected = assets.find(item => item.key === selection) ?? assets[0]
  if (access === undefined) return null
  const submit = async (): Promise<void> => {
    if (!selected || !access.canFeedback || !body.trim() || !api.commentProjectDeliveryAsHuman) return
    setBusy(true)
    setError(undefined)
    try {
      await api.commentProjectDeliveryAsHuman({ projectId, path: selected.path,
        version: selected.version, expectedSha256: selected.sha256,
        expectedProjectRevision: access.revision, idempotencyKey: requestId,
        ...(section.trim() ? { section: section.trim() } : {}), body: body.trim() })
      setBody('')
      setSection('')
      setRequestId(freshRequestId())
      onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <section className="ba-projects-section ba-projects-human-review">
    <h5>{t('projects.deliveryFeedback')}</h5>
    {assets.length > 0 ? <ul>{assets.map(asset =>
      <li key={asset.key}><code>{asset.path}</code> · {asset.version} · <code>{asset.sha256.slice(0, 12)}</code>
        {' · '}<a href={`${BIZAGENT_PROJECT_DELIVERY_FEEDBACK_API}?${new URLSearchParams({
          projectId, assetPath: asset.path, version: asset.version,
          ...(asset.version === 'working' ? { revision: String(asset.revision) } : {}),
        })}`}>{t('projects.downloadArtifact')}</a></li>)}</ul>
      : <p>{t('projects.deliveryNoAssets')}</p>}
    {(access.feedback.length > 0) ? <ul>{access.feedback.slice(-20).reverse().map(item =>
      <li key={item.id}><strong>{item.path}</strong> · {item.version} · <code>{item.sha256.slice(0, 12)}</code>
        {item.section ? <> · {item.section}</> : null}
        <p>{item.body}</p>
        <a href={`${BIZAGENT_PROJECT_DELIVERY_FEEDBACK_API}?${new URLSearchParams({
          projectId, feedbackId: item.id,
        })}`}>{t('projects.feedbackReviewedVersion')}</a>
        {item.resolution ? <p>{t('projects.feedbackResolution')}: {item.resolution.reply}
          {' · '}<code>{item.resolution.path}</code> v{item.resolution.workingRevision}</p>
          : <small>{t('projects.feedbackOpen')}</small>}
      </li>)}</ul> : null}
    {access.canFeedback && selected && api.commentProjectDeliveryAsHuman ? <div>
      <label>{t('projects.feedbackAsset')}
        <select value={selected.key} onChange={event => {
          setSelection(event.target.value); setRequestId(freshRequestId())
        }}>
          {assets.map(asset => <option key={asset.key} value={asset.key}>
            {asset.version}: {asset.path} ({asset.sha256.slice(0, 12)})
          </option>)}
        </select></label>
      <label>{t('projects.feedbackSection')}
        <input value={section} maxLength={200} onChange={event => {
          setSection(event.target.value); setRequestId(freshRequestId())
        }} /></label>
      <label>{t('projects.feedbackBody')}
        <textarea value={body} maxLength={5000} onChange={event => {
          setBody(event.target.value); setRequestId(freshRequestId())
        }} /></label>
      <button type="button" className="ba-button" data-variant="primary"
        disabled={busy || !body.trim()} onClick={() => { void submit() }}>
        {t('projects.feedbackSend')}
      </button>
    </div> : null}
    {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
  </section>
}
