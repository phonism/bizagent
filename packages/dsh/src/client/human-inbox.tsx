import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UiHumanInboxDetail, UiHumanInboxList, UiHumanInboxSummary } from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'

type T = PropsLocale<'bizagent'>['t']
const newReplyKey = (): string => globalThis.crypto?.randomUUID?.()
  ?? `reply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export function HumanInboxDashboard({ api, t }: { api: BizAgentUiPort; t: T }) {
  const [direction, setDirection] = useState<'incoming' | 'outgoing'>('incoming')
  const [pendingOnly, setPendingOnly] = useState(false)
  const [items, setItems] = useState<UiHumanInboxSummary[] | null>()
  const [notificationPreference, setNotificationPreference] = useState<UiHumanInboxList['notificationPreference']>()
  const [cursor, setCursor] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [detail, setDetail] = useState<UiHumanInboxDetail>()
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [replyKey, setReplyKey] = useState(newReplyKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setItems(undefined)
    setCursor(undefined)
    setError(undefined)
    void api.humanInbox(direction, pendingOnly, undefined, abort.signal).then(next => {
      if (abort.signal.aborted) return
      setItems(next?.messages ?? null)
      setNotificationPreference(next?.notificationPreference)
      setCursor(next?.nextBeforeMessageId)
      setSelectedId(current => next?.messages.some(item => item.id === current) ? current : next?.messages[0]?.id)
    }).catch(cause => { if (!abort.signal.aborted) setError(message(cause)) })
    return () => abort.abort()
  }, [api, direction, pendingOnly, revision])

  useEffect(() => {
    if (!selectedId) { setDetail(undefined); return }
    const abort = new AbortController()
    setDetail(undefined)
    setSubject('')
    setBody('')
    setReplyKey(newReplyKey())
    void api.humanInboxDetail(selectedId, abort.signal)
      .then(next => { if (!abort.signal.aborted) {
        setDetail(next)
        setSubject(`Re: ${next.message.subject}`.slice(0, 200))
      } })
      .catch(cause => { if (!abort.signal.aborted) setError(message(cause)) })
    return () => abort.abort()
  }, [api, selectedId, revision])

  async function act(task: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setError(undefined)
    try { await task(); setRevision(value => value + 1) }
    catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }

  async function loadMore(): Promise<void> {
    if (!cursor || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const next = await api.humanInbox(direction, pendingOnly, cursor)
      if (next) {
        setItems(current => [...(current ?? []), ...next.messages.filter(item =>
          !current?.some(existing => existing.id === item.id))])
        setCursor(next.nextBeforeMessageId)
      }
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }

  function reply(event: FormEvent): void {
    event.preventDefault()
    if (!detail || !subject.trim() || !body.trim()) return
    void act(async () => {
      await api.replyHumanInbox(detail.message.id, subject.trim(), body.trim(), replyKey)
      setBody('')
      setReplyKey(newReplyKey())
    })
  }

  const canReply = detail?.delivery?.status === 'delivered'
    && (detail.message.returnAddress !== undefined
      || detail.message.fromAddress.startsWith('personal:')
      || detail.message.fromAddress.startsWith('business:')
      || detail.message.fromAddress.startsWith('role:')
      || detail.message.fromAddress.startsWith('capability:'))
  return <main className="ba-inbox-page">
    <header className="ba-pulse-header">
      <div><p className="ba-pulse-eyebrow">HUMAN / INBOX</p>
        <h3>{t('humanInbox.title')}</h3><p>{t('humanInbox.subtitle')}</p></div>
      <button type="button" className="ba-pulse-quiet" disabled={busy}
        onClick={() => setRevision(value => value + 1)}>{t('humanInbox.refresh')}</button>
    </header>
    <div className="ba-inbox-filters">
      <button type="button" data-active={direction === 'incoming'}
        onClick={() => setDirection('incoming')}>{t('humanInbox.incoming')}</button>
      <button type="button" data-active={direction === 'outgoing'}
        onClick={() => setDirection('outgoing')}>{t('humanInbox.outgoing')}</button>
      {direction === 'incoming' ? <label><input type="checkbox" checked={pendingOnly}
        onChange={event => setPendingOnly(event.target.checked)} /> {t('humanInbox.pendingOnly')}</label> : null}
      {notificationPreference ? <label><input type="checkbox" checked={notificationPreference.enabled}
        disabled={busy} onChange={event => void act(() => api.setHumanNotificationPreference(
          event.target.checked, notificationPreference.revision))} /> {t('humanInbox.externalPush')}</label> : null}
    </div>
    {error ? <p className="ba-pulse-error" role="alert">{error}</p> : null}
    {items === undefined ? <p className="ba-pulse-empty">{t('humanInbox.loading')}</p>
      : items === null ? <p className="ba-pulse-empty">{t('humanInbox.unavailable')}</p>
        : <div className="ba-inbox-layout">
          <aside className="ba-inbox-list">
            {items.length === 0 ? <p>{t('humanInbox.empty')}</p> : items.map(item => <button type="button"
              key={item.id} data-active={item.id === selectedId} onClick={() => setSelectedId(item.id)}>
              <strong>{item.subject}</strong><span>{item.fromAddress} · {new Date(item.sentAt).toLocaleString()}</span>
              <small>{item.kind === 'turn-complete' ? t('humanInbox.turnComplete') : item.kind} · {item.delivery?.handledAt ? t('humanInbox.handled')
                : item.delivery?.status === 'delivered' ? t('humanInbox.pending') : item.priority}</small>
            </button>)}
            {cursor ? <button type="button" className="ba-inbox-more" disabled={busy}
              onClick={() => void loadMore()}>{t('humanInbox.more')}</button> : null}
          </aside>
          <article className="ba-inbox-detail">
            {!selectedId ? <p>{t('humanInbox.select')}</p> : !detail || detail.message.id !== selectedId
              ? <p>{t('humanInbox.loading')}</p> : <>
                <p className="ba-pulse-eyebrow">{detail.message.kind} / {detail.message.priority}</p>
                <h4>{detail.message.subject}</h4>
                <p className="ba-inbox-meta">{detail.message.fromAddress} · {new Date(detail.message.sentAt).toLocaleString()}</p>
                {detail.message.due ? <p className="ba-inbox-meta">{t('humanInbox.due')}: {new Date(detail.message.due).toLocaleString()}</p> : null}
                {detail.message.humanAction ? <div className="ba-inbox-action">
                  <strong>{detail.message.humanAction.request}</strong>
                  <p>{detail.message.humanAction.reason}</p>
                  {detail.message.humanAction.options ? <div className="ba-inbox-options">
                    {detail.message.humanAction.options.map(option => <button type="button" key={option.label}
                      disabled={!canReply || busy} onClick={() => { setBody(option.label); setReplyKey(newReplyKey()) }}>
                      <strong>{option.label}</strong>{option.detail ? <small>{option.detail}</small> : null}
                    </button>)}
                  </div> : null}
                  {detail.message.humanAction.href ? <a href={detail.message.humanAction.href}>
                    {detail.message.humanAction.label ?? t('humanInbox.openAction')}</a> : null}
                </div> : null}
                <pre className="ba-inbox-body">{detail.message.body}</pre>
                {detail.delivery?.status === 'delivered' && !detail.delivery.handledAt
                  ? <button type="button" disabled={busy}
                    onClick={() => void act(() => api.handleHumanInbox(detail.message.id))}>
                    {t('humanInbox.handle')}</button> : null}
                {detail.delivery?.handledAt ? <p className="ba-inbox-meta">{t('humanInbox.handled')}: {
                  new Date(detail.delivery.handledAt).toLocaleString()}</p> : null}
                {canReply ? <form className="ba-inbox-reply" onSubmit={reply}>
                  <h5>{t('humanInbox.reply')}</h5>
                  <label>{t('humanInbox.subject')}<input value={subject} maxLength={200}
                    onChange={event => { setSubject(event.target.value); setReplyKey(newReplyKey()) }} /></label>
                  <label>{t('humanInbox.body')}<textarea value={body} maxLength={16000}
                    onChange={event => { setBody(event.target.value); setReplyKey(newReplyKey()) }} rows={5} /></label>
                  <button type="submit" disabled={busy || !subject.trim() || !body.trim()}>
                    {t('humanInbox.send')}</button>
                </form> : null}
              </>}
          </article>
        </div>}
  </main>
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
