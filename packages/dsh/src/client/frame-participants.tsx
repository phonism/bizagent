import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionSurfaceFace } from './session-surfaces.js'
import { homeName } from './home-name.js'

type FrameDockProps = PropsRuntime<'conversation.input.dock'>
  & InjectFace<Pick<SessionSurfaceFace, 'surfaces' | 'openDashboard'>>
  & PropsLocale<'bizagent'>

const subscribeNothing = () => () => undefined
export function FrameParticipationDock({ sessionId, useSession, surfaces, openDashboard, t }: FrameDockProps) {
  const blank = useSession(session => session.blank)
  const removed = useSession(session => session.removed)
  // Frames change during turns; refetch whenever the Session starts or stops running.
  const running = useSession(session => session.running)
  const resource = useMemo(() => surfaces.context(String(sessionId)), [surfaces, sessionId])
  const { data, error } = useSyncExternalStore(blank || removed ? subscribeNothing : resource.subscribe, resource.getSnapshot)
  const participation = data ? { sessionId: data.summary.sessionId, primaryHome: data.summary.home, frames: data.frames } : undefined
  const unavailable = error !== undefined

  useEffect(() => {
    if (!blank && !removed) void resource.refresh()
  }, [resource, blank, removed, running])

  if (blank || removed || participation?.sessionId !== String(sessionId) || participation.frames.length === 0) return null

  return (
    <div className="ba-frame-dock" aria-label={t('frames.aria')}>
      <span className="ba-frame-dock-label">{t('frames.label')}</span>
      <span className="ba-frame-chip ba-frame-primary" title={participation.primaryHome.address}>
        <span>{t('frames.primary')}</span> {homeName(participation.primaryHome, t)}
      </span>
      {participation.frames.map(frame => (
        <button type="button" className="ba-frame-chip" data-mode={frame.mode} key={frame.address} title={frame.address}
          onClick={() => openDashboard({ view: 'learning', homeAddress: frame.address, sessionId: String(sessionId) })}>
          <span>{t(`frames.${frame.mode}`)}</span> {frame.displayName}
          {frame.focused ? <b aria-label={t('frames.focus')}>· {t('frames.focus')}</b> : null}
          {frame.refreshRequired ? <b className="ba-frame-stale">· {t('frames.refresh')}</b> : null}
        </button>
      ))}
      <span className="ba-frame-dock-note">{unavailable ? t('frames.unavailable') : t('frames.note')}</span>
    </div>
  )
}
