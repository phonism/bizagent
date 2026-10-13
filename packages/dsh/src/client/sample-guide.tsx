import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

type Translate = PropsLocale<'bizagent'>['t']

/** One step of the sample team guide: whom to talk to and what to send. */
interface GuideStep {
  key: 'teach' | 'project' | 'run' | 'share'
  /** Home whose chat this step opens; `projects` opens the Projects view instead. */
  target: { home: string; nameKey: 'guide.name.analyst' | 'guide.name.lead' } | 'projects'
}

const STEPS: readonly GuideStep[] = [
  { key: 'teach', target: { home: 'personal:data-analyst', nameKey: 'guide.name.analyst' } },
  { key: 'project', target: { home: 'personal:growth-lead', nameKey: 'guide.name.lead' } },
  { key: 'run', target: 'projects' },
  { key: 'share', target: { home: 'personal:data-analyst', nameKey: 'guide.name.analyst' } },
]

/** Getting-started steps shown on the sample team's Organization view. */
export function SampleGuide({ onOpenChat, onOpenProjects, t }: {
  onOpenChat: (homeAddress: string) => Promise<void>
  onOpenProjects: () => void
  t: Translate
}) {
  const [copied, setCopied] = useState<string>()
  const [error, setError] = useState<string>()
  const copy = (key: string, text: string): void => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(key) }).catch(() => { setCopied(undefined) })
  }
  return (
    <section className="ba-sample-guide" aria-label={t('guide.title')}>
      <div className="ba-sample-guide-head">
        <h3>{t('guide.title')}</h3>
        <p>{t('guide.lead')}</p>
      </div>
      <ol className="ba-sample-steps">
        {STEPS.map((step, index) => {
          const prompt = t(`guide.${step.key}.prompt` as 'guide.teach.prompt')
          return (
            <li key={step.key} className="ba-sample-step">
              <span className="ba-sample-index">{index + 1}</span>
              <div className="ba-sample-body">
                <strong>{t(`guide.${step.key}.title` as 'guide.teach.title')}</strong>
                <blockquote className="ba-sample-prompt">{prompt}</blockquote>
                <p className="ba-sample-after">{t(`guide.${step.key}.after` as 'guide.teach.after')}</p>
                <div className="ba-sample-actions">
                  {step.target === 'projects' ? (
                    <button type="button" className="ba-button" onClick={onOpenProjects}>{t('guide.openProjects')}</button>
                  ) : (
                    <button type="button" className="ba-button" data-variant="primary" onClick={() => {
                      const target = step.target as Exclude<GuideStep['target'], 'projects'>
                      setError(undefined)
                      void onOpenChat(target.home).catch(cause => { setError(String(cause instanceof Error ? cause.message : cause)) })
                    }}>{t('guide.chat', { name: t((step.target as { nameKey: 'guide.name.lead' }).nameKey) })}</button>
                  )}
                  <button type="button" className="ba-button" onClick={() => { copy(step.key, prompt) }}>
                    {copied === step.key ? t('guide.copied') : t('guide.copy')}
                  </button>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
    </section>
  )
}
