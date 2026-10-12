import { useState, type MouseEvent } from 'react'
import { BIZAGENT_PROJECT_REVIEW_API } from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'

export function ProjectArtifactLink({ api, projectId, claimId, artifactPath, workId, label, errorLabel }: {
  api: BizAgentUiPort; projectId: string; claimId: string; artifactPath: string
  workId?: string; label: string; errorLabel: string
}) {
  const [error, setError] = useState(false)
  const query = new URLSearchParams({ projectId, claimId, artifactPath,
    ...(workId === undefined ? {} : { workId }) })
  const download = async (event: MouseEvent<HTMLAnchorElement>): Promise<void> => {
    if (!api.downloadProjectReviewArtifact) return
    event.preventDefault()
    setError(false)
    try {
      const blob = await api.downloadProjectReviewArtifact({ projectId, claimId, artifactPath,
        ...(workId === undefined ? {} : { workId }) })
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = artifactPath.split('/').at(-1) || 'artifact'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
    } catch { setError(true) }
  }
  return <><a href={`${BIZAGENT_PROJECT_REVIEW_API}?${query}`}
    onClick={(event) => { void download(event) }}>{label}</a>
    {error ? <span role="alert"> {errorLabel}</span> : null}</>
}
