import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { UiFrameParticipation } from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'
import { homeName } from './home-name.js'

type FrameDockProps = PropsRuntime<'conversation.input.dock'>
  & InjectFace<{ api: BizAgentUiPort }>
  & PropsLocale<'bizagent'>

export function FrameParticipationDock({ sessionId, useSession, api, t }: FrameDockProps) {
  const [participation, setParticipation] = useState<UiFrameParticipation>()
  const [unavailable, setUnavailable] = useState(false)
  const blank = useSession(session => session.blank)
  const removed = useSession(session => session.removed)
  // Frames change during turns; refetch whenever the Session starts or stops running.
  const running = useSession(session => session.running)

  useEffect(() => {
    if (blank || removed) {
      setParticipation(undefined)
      return
    }
    const abort = new AbortController()
    void api.frameParticipation(String(sessionId), abort.signal)
      .then(value => {
        if (!abort.signal.aborted) {
          setParticipation(value)
          setUnavailable(false)
        }
      })
      .catch(() => { if (!abort.signal.aborted) setUnavailable(true) })
    return () => { abort.abort() }
  }, [api, sessionId, blank, removed, running])

  if (participation?.sessionId !== String(sessionId) || participation.frames.length === 0) return null

  return (
    <div className="ba-frame-dock" aria-label={t('frames.aria')}>
      <span className="ba-frame-dock-label">{t('frames.label')}</span>
      <span className="ba-frame-chip ba-frame-primary" title={participation.primaryHome.address}>
        <span>{t('frames.primary')}</span> {homeName(participation.primaryHome, t)}
      </span>
      {participation.frames.map(frame => (
        <span className="ba-frame-chip" data-mode={frame.mode} key={frame.address} title={frame.address}>
          <span>{t(`frames.${frame.mode}`)}</span> {frame.displayName}
          {frame.focused ? <b aria-label={t('frames.focus')}>· {t('frames.focus')}</b> : null}
          {frame.refreshRequired ? <b className="ba-frame-stale">· {t('frames.refresh')}</b> : null}
        </span>
      ))}
      <span className="ba-frame-dock-note">{unavailable ? t('frames.unavailable') : t('frames.note')}</span>
    </div>
  )
}
