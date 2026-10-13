import { useMemo } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

type Translate = PropsLocale<'bizagent'>['t']

/**
 * Agent-written Markdown (claims, assets, proposals, mail) rendered with DSH's own renderer, which
 * treats the text as untrusted: raw HTML and unsafe link protocols are disabled.
 */
export function MarkdownBody({ text, className, t }: { text: string; className?: string; t: Translate }) {
  const labels = useMemo(() => ({
    code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])
  return <div className={className ? `ba-markdown ${className}` : 'ba-markdown'}>
    <MarkdownText text={text} labels={labels} variant="compact" />
  </div>
}
