import { createHash } from 'node:crypto'
import { extname } from 'node:path'

export type WorkOutputVerdict = {
  checker: 'empty-content' | 'placeholder-leak'
  result: 'pass' | 'fail' | 'skip'
  reason?: string
  evidence?: string
}

export type WorkOutputSourceEvaluation = {
  kind: 'artifact' | 'result-body'
  path?: string
  sha256: string
  bytes: number
  verdicts: WorkOutputVerdict[]
}

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml', '.html', '.xml',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.sql', '.sh', '.css', '.svg',
])
const decoder = new TextDecoder('utf-8', { fatal: true })
const PLACEHOLDERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bTODO\b/u, label: 'TODO' },
  { pattern: /\bFIXME\b/u, label: 'FIXME' },
  { pattern: /\bXXX\b/u, label: 'XXX' },
  { pattern: /待补充|待填写|待确认数据|此处填|占位符/u, label: 'unfilled text' },
  { pattern: /\{\{[^}\n]{1,100}\}\}/u, label: 'template variable' },
]

function verdicts(text: string): WorkOutputVerdict[] {
  const empty: WorkOutputVerdict = text.trim()
    ? { checker: 'empty-content', result: 'pass' }
    : { checker: 'empty-content', result: 'fail', reason: 'Deliverable text is empty' }
  // A fenced code example is not evidence that the delivered prose was left unfinished.
  const prose = text.replace(/```[\s\S]*?(?:```|$)/gu, ' ')
  const placeholder = PLACEHOLDERS.map(item => ({ ...item, match: item.pattern.exec(prose) }))
    .find(item => item.match !== null)
  const leak: WorkOutputVerdict = !text.trim()
    ? { checker: 'placeholder-leak', result: 'skip', reason: 'No text to inspect' }
    : placeholder === undefined
      ? { checker: 'placeholder-leak', result: 'pass' }
      : {
        checker: 'placeholder-leak', result: 'fail', reason: `Unfilled ${placeholder.label} marker`,
        evidence: prose.slice(Math.max(0, placeholder.match!.index - 20), placeholder.match!.index + 60)
          .replace(/\s+/gu, ' ').trim(),
      }
  return [empty, leak]
}

/** Deterministic assertions on a frozen Work result. Verdicts are observations, not acceptance decisions. */
export function evaluateWorkOutput(kind: 'artifact' | 'result-body', bytes: Uint8Array,
  path?: string): WorkOutputSourceEvaluation {
  const source = { kind, ...(path === undefined ? {} : { path }),
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  if (kind === 'artifact' && !TEXT_EXTENSIONS.has(extname(path ?? '').toLowerCase())) {
    return { ...source, verdicts: [
      { checker: 'empty-content', result: 'skip', reason: 'Artifact format is not a supported text type' },
      { checker: 'placeholder-leak', result: 'skip', reason: 'Artifact format is not a supported text type' },
    ] }
  }
  let text: string
  try {
    text = decoder.decode(bytes)
    if (text.includes('\0')) throw new Error('NUL in text')
  } catch {
    return { ...source, verdicts: [
      { checker: 'empty-content', result: 'skip', reason: 'Artifact is not valid UTF-8 text' },
      { checker: 'placeholder-leak', result: 'skip', reason: 'Artifact is not valid UTF-8 text' },
    ] }
  }
  return { ...source, verdicts: verdicts(text) }
}
