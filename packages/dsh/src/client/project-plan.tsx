import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UiProjectDetail, UiProjectPlanAccess, UiProjectPlanStep } from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'

type T = PropsLocale<'bizagent'>['t']

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function ProjectPlanPanel({ detail, api, t, onChanged }: {
  detail: UiProjectDetail; api: BizAgentUiPort; t: T; onChanged: () => void
}) {
  const { project, work, workflow } = detail
  const latestProposal = project.workflowProposals?.at(-1)
  const proposal = latestProposal && latestProposal.baseWorkflowRevision === project.workflow?.revision
    && latestProposal.executionEpoch === (project.intervention?.epoch ?? 0)
    ? latestProposal : undefined
  const [access, setAccess] = useState<UiProjectPlanAccess>()
  const [useProposal, setUseProposal] = useState(Boolean(proposal))
  const [summary, setSummary] = useState(proposal?.workflow.summary ?? project.workflow?.summary ?? '')
  const [steps, setSteps] = useState<UiProjectPlanStep[]>(() => (proposal?.workflow ?? project.workflow)?.steps.map(step => ({
    ...step, after: [...step.after],
  })) ?? [])
  const [reason, setReason] = useState(proposal?.reason ?? '')
  const currentProgression = project.progressionChanges?.at(-1)
  const progressionSteps = project.workflow?.steps.filter(step =>
    workflow?.nodes.find(node => node.id === step.id)?.status !== 'done') ?? []
  const legacyReviewCount = project.workflow?.steps.filter(step => step.reviewer).length ?? 0
  const [progressionMode, setProgressionMode] = useState<'plan' | 'automatic' | 'reviewed'>(
    currentProgression?.mode ?? (legacyReviewCount === 0 ? 'automatic'
      : legacyReviewCount === project.workflow?.steps.length ? 'reviewed' : 'plan'))
  const [progressionReviewers, setProgressionReviewers] = useState<Record<string, string>>(() =>
    Object.fromEntries(project.workflow?.steps.map(step => [step.id,
      currentProgression?.reviewers.find(item => item.nodeId === step.id)?.reviewerHome
      ?? step.reviewer ?? step.executor]) ?? []))
  const [progressionReason, setProgressionReason] = useState('')
  const [restartNodeIds, setRestartNodeIds] = useState<string[]>([])
  const [reopenNodeId, setReopenNodeId] = useState('')
  const [reopenReason, setReopenReason] = useState('')
  const [reassignNodeId, setReassignNodeId] = useState('')
  const [reassignPrincipal, setReassignPrincipal] = useState('')
  const [reassignReason, setReassignReason] = useState('')
  const [reviewerCandidates, setReviewerCandidates] = useState<NonNullable<UiProjectPlanAccess['reviewerCandidates']>>([])
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!api.projectPlanAccess || !project.workflow) { setAccess(undefined); return }
    const abort = new AbortController()
    setAccess(undefined)
    void api.projectPlanAccess(project.id, abort.signal)
      .then(next => { if (!abort.signal.aborted) setAccess(next) })
      .catch(cause => { if (!abort.signal.aborted) setError(message(cause)) })
    return () => { abort.abort() }
  }, [api, project.id, project.revision, project.workflow])
  useEffect(() => {
    setReviewerCandidates([])
    setReassignPrincipal('')
    if (!reassignNodeId || !access?.canReassign || !api.projectPlanAccess) return
    const abort = new AbortController()
    setCandidatesLoading(true)
    void api.projectPlanAccess(project.id, abort.signal, reassignNodeId)
      .then(next => {
        if (!abort.signal.aborted && next?.revision === project.revision) {
          setReviewerCandidates(next.reviewerCandidates ?? [])
        }
      })
      .catch(cause => { if (!abort.signal.aborted) setError(message(cause)) })
      .finally(() => { if (!abort.signal.aborted) setCandidatesLoading(false) })
    return () => { abort.abort() }
  }, [access?.canReassign, api, project.id, project.revision, reassignNodeId])
  const current = access?.revision === project.revision
    && access.workflowRevision === project.workflow?.revision
  if (!current || !api.projectPlanActionAsHuman || !project.workflow) return null
  const mutate = api.projectPlanActionAsHuman
  const canEdit = Boolean(access.canAmend || access.canRebuild)
  const saveProgression = async (): Promise<void> => {
    if (!access.canSetProgression || !progressionReason.trim() || progressionMode === 'plan') return
    if (progressionMode === 'reviewed' && progressionSteps.some(step =>
      !progressionReviewers[step.id]?.trim())) {
      setError(t('projects.completeProgressionReviewers'))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await mutate({ action: 'progression', projectId: project.id,
        expectedRevision: project.revision, mode: progressionMode,
        reviewers: progressionMode === 'automatic' ? [] : progressionSteps.map(step => ({
          nodeId: step.id, reviewerHome: progressionReviewers[step.id]!.trim(),
        })), reason: progressionReason.trim() })
      onChanged()
    } catch (cause) { setError(message(cause)); onChanged() }
    finally { setBusy(false) }
  }
  const patchStep = (index: number, values: Partial<UiProjectPlanStep>): void => {
    setSteps(items => items.map((item, i) => i === index ? { ...item, ...values } : item))
  }
  const save = async (): Promise<void> => {
    if (!canEdit || !reason.trim() || !summary.trim() || steps.length === 0) return
    if (steps.some(step => !step.title.trim() || !step.intent.trim()
      || !step.executor.trim() || !step.acceptanceCriteria.trim())) {
      setError(t('projects.completePlanFields'))
      return
    }
    if (steps.some(step => Boolean(step.reviewer?.trim()) !== Boolean(step.reviewCriteria?.trim()))) {
      setError(t('projects.reviewerCriteriaPair'))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await mutate({ action: access.canRebuild ? 'rebuild' : 'amend', projectId: project.id,
        expectedRevision: project.revision, expectedWorkflowRevision: project.workflow!.revision,
        reason: reason.trim(), idempotencyKey,
        ...(useProposal && proposal ? { proposalKey: proposal.idempotencyKey } : {}),
        ...(access.canRebuild ? { restartNodeIds } : {}),
        workflow: { summary: summary.trim(), steps: steps.map(step => ({
          id: step.id.trim(), title: step.title.trim(), intent: step.intent.trim(),
          executor: step.executor.trim(), acceptanceCriteria: step.acceptanceCriteria.trim(),
          after: step.after.map(id => id.trim()).filter(Boolean),
          ...(step.reviewer?.trim() ? {
            reviewer: step.reviewer.trim(), reviewCriteria: step.reviewCriteria?.trim() ?? '',
          } : {}),
        })) },
      })
      onChanged()
    } catch (cause) { setError(message(cause)); onChanged() }
    finally { setBusy(false) }
  }
  const reopen = async (): Promise<void> => {
    if (!access.canReopen || !reopenNodeId || !reopenReason.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await mutate({ action: 'reopen', projectId: project.id, expectedRevision: project.revision,
        nodeId: reopenNodeId, reason: reopenReason.trim() })
      onChanged()
    } catch (cause) { setError(message(cause)); onChanged() }
    finally { setBusy(false) }
  }
  const reassign = async (): Promise<void> => {
    const node = workflow?.nodes.find(item => item.id === reassignNodeId && item.status === 'waiting')
    if (!access.canReassign || !node?.latestWorkId || !reassignPrincipal
      || !reviewerCandidates.some(item => item.userId === reassignPrincipal)
      || !reassignReason.trim()) return
    const previous = project.nodeReviewerAssignments?.findLast(item => item.workId === node.latestWorkId)
      ?.assignedPrincipal ?? null
    setBusy(true)
    setError(undefined)
    try {
      await mutate({ action: 'reassign', projectId: project.id, expectedRevision: project.revision,
        nodeId: node.id, workId: node.latestWorkId, expectedPrincipal: previous,
        assignedPrincipal: reassignPrincipal, reason: reassignReason.trim() })
      onChanged()
    } catch (cause) { setError(message(cause)); onChanged() }
    finally { setBusy(false) }
  }
  const completed = workflow?.nodes.filter(node => node.status === 'done' || node.status === 'waiting') ?? []
  const restartable = completed.filter(node => node.status === 'done')
  const waiting = completed.filter(node => node.status === 'waiting' && node.latestWorkId
    && (() => {
      const result = work.find(item => item.id === node.latestWorkId)
      const gate = result?.workflowReview
      return gate?.mode === 'reviewed' || gate === undefined
        && project.workflow?.steps.some(step => step.id === node.id && step.reviewer)
    })())
  const selectedWaiting = waiting.find(node => node.id === reassignNodeId)
  const currentReviewer = project.nodeReviewerAssignments?.findLast(item =>
    item.workId === selectedWaiting?.latestWorkId)?.assignedPrincipal
  return <section className="ba-projects-section ba-projects-plan">
    <h5>{t('projects.planTitle')}</h5>
    {access.canSetProgression ? <details>
      <summary>{t('projects.progressionTitle')}</summary>
      <div className="ba-projects-human-review">
        <p>{t('projects.progressionHint')}</p>
        {access.progressionNotification ? <p>{access.progressionNotification.state === 'pending'
          ? t('projects.progressionNoticePending') : t('projects.progressionNoticeDelivered')}</p> : null}
        <label>{t('projects.progressionMode')}<select value={progressionMode}
          onChange={event => { setProgressionMode(event.target.value as 'automatic' | 'reviewed') }}>
          {progressionMode === 'plan' ? <option value="plan">{t('projects.progressionByNode')}</option> : null}
          <option value="automatic">{t('projects.progressionAutomatic')}</option>
          <option value="reviewed">{t('projects.progressionReviewed')}</option>
        </select></label>
        {progressionMode === 'reviewed' ? progressionSteps.map(step =>
          <label key={step.id}>{step.title} · {t('projects.planReviewer')}
            <input required value={progressionReviewers[step.id] ?? ''}
              onChange={event => { setProgressionReviewers(items => ({ ...items,
                [step.id]: event.target.value })) }} /></label>) : null}
        <label>{t('projects.planReason')}<textarea required maxLength={4000}
          value={progressionReason} onChange={event => { setProgressionReason(event.target.value) }} /></label>
        <button type="button" className="ba-button"
          disabled={busy || !progressionReason.trim() || progressionMode === 'plan'}
          onClick={() => { void saveProgression() }}>{t('projects.saveProgression')}</button>
      </div>
    </details> : null}
    {canEdit ? <details>
      <summary>{proposal && useProposal ? t('projects.reviewProposal')
        : access.canRebuild ? t('projects.rebuildPlan') : t('projects.amendPlan')}</summary>
      <div className="ba-projects-human-review">
        {proposal ? <p>{useProposal ? t('projects.proposalHint', { session: proposal.bySessionId })
          : t('projects.proposalAvailable')}
          <button type="button" className="ba-button" onClick={() => {
            const next = useProposal ? project.workflow! : proposal.workflow
            setUseProposal(!useProposal)
            setSummary(next.summary)
            setSteps(next.steps.map(step => ({ ...step, after: [...step.after] })))
            setReason(useProposal ? '' : proposal.reason)
          }}>{useProposal ? t('projects.useCurrentPlan') : t('projects.useProposal')}</button>
        </p> : null}
        <p>{access.canRebuild ? t('projects.rebuildHint') : t('projects.amendHint')}</p>
        <label>{t('projects.planSummary')}
          <textarea maxLength={2000} value={summary} onChange={event => { setSummary(event.target.value) }} />
        </label>
        {steps.map((step, index) => {
          const locked = !access.canRebuild && work.some(item => item.workflowNodeId === step.id)
          return <fieldset className="ba-projects-plan-step" key={step.id} disabled={busy || locked}>
            <legend>{t('projects.planStep', { count: index + 1 })} · <code>{step.id}</code></legend>
            {locked ? <p>{t('projects.dispatchedStepLocked')}</p> : null}
            <label>{t('projects.planStepTitle')}<input required maxLength={120} value={step.title}
              onChange={event => { patchStep(index, { title: event.target.value }) }} /></label>
            <label>{t('projects.planIntent')}<textarea required maxLength={4000} value={step.intent}
              onChange={event => { patchStep(index, { intent: event.target.value }) }} /></label>
            <label>{t('projects.planExecutor')}<input required value={step.executor}
              onChange={event => { patchStep(index, { executor: event.target.value }) }} /></label>
            <label>{t('projects.planAcceptance')}<textarea required maxLength={4000}
              value={step.acceptanceCriteria}
              onChange={event => { patchStep(index, { acceptanceCriteria: event.target.value }) }} /></label>
            <label>{t('projects.planDependencies')}<select multiple value={step.after}
              onChange={event => { patchStep(index, {
                after: Array.from(event.target.selectedOptions, option => option.value),
              }) }}>
              {steps.filter(candidate => candidate.id !== step.id).map(candidate =>
                <option key={candidate.id} value={candidate.id}>{candidate.title || candidate.id}</option>)}
            </select></label>
            <label>{t('projects.planReviewer')}<input value={step.reviewer ?? ''}
              onChange={event => { patchStep(index, { reviewer: event.target.value }) }} /></label>
            <label>{t('projects.planReviewCriteria')}<textarea maxLength={4000}
              value={step.reviewCriteria ?? ''}
              onChange={event => { patchStep(index, { reviewCriteria: event.target.value }) }} /></label>
            {!locked && steps.length > 1 ? <button type="button" className="ba-button" onClick={() => {
              setSteps(items => items.filter(item => item.id !== step.id)
                .map(item => ({ ...item, after: item.after.filter(id => id !== step.id) })))
              setRestartNodeIds(items => items.filter(id => id !== step.id))
            }}>{t('projects.removeStep')}</button> : null}
          </fieldset>
        })}
        {steps.length < 12 ? <button type="button" className="ba-button" onClick={() => {
          setSteps(items => [...items, {
            id: `node-${crypto.randomUUID().slice(0, 8)}`, title: '', intent: '',
            executor: project.lead, acceptanceCriteria: '', after: [],
          }])
        }}>{t('projects.addStep')}</button> : null}
        {access.canRebuild && restartable.length > 0 ? <fieldset className="ba-projects-plan-restarts">
          <legend>{t('projects.restartNodes')}</legend>
          {restartable.map(node => <label key={node.id}><input type="checkbox"
            checked={restartNodeIds.includes(node.id)}
            onChange={event => { setRestartNodeIds(items => event.target.checked
              ? [...items, node.id] : items.filter(id => id !== node.id)) }} />
            {node.title}</label>)}
        </fieldset> : null}
        <label>{t('projects.planReason')}<textarea required maxLength={4000}
          value={reason} onChange={event => { setReason(event.target.value) }} /></label>
        <button type="button" className="ba-button" data-variant="primary"
          disabled={busy || !reason.trim() || !summary.trim() || steps.length === 0}
          onClick={() => { void save() }}>
          {access.canRebuild ? t('projects.saveRebuild') : t('projects.saveAmend')}</button>
      </div>
    </details> : null}
    {access.canReopen && completed.length > 0 ? <details>
      <summary>{t('projects.reopenNode')}</summary>
      <div className="ba-projects-human-review">
        <p>{t('projects.reopenHint')}</p>
        <label>{t('projects.reopenSelect')}<select value={reopenNodeId}
          onChange={event => { setReopenNodeId(event.target.value) }}>
          <option value="">{t('projects.chooseNode')}</option>
          {completed.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}
        </select></label>
        <label>{t('projects.planReason')}<textarea maxLength={4000}
          value={reopenReason} onChange={event => { setReopenReason(event.target.value) }} /></label>
        <button type="button" className="ba-button" disabled={busy || !reopenNodeId || !reopenReason.trim()}
          onClick={() => { void reopen() }}>{t('projects.confirmReopen')}</button>
      </div>
    </details> : null}
    {access.canReassign && waiting.length > 0 ? <details>
      <summary>{t('projects.reassignReviewer')}</summary>
      <div className="ba-projects-human-review">
        <p>{t('projects.reassignHint')}</p>
        <label>{t('projects.reassignNode')}<select value={reassignNodeId}
          onChange={event => { setReassignNodeId(event.target.value) }}>
          <option value="">{t('projects.chooseNode')}</option>
          {waiting.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}
        </select></label>
        {selectedWaiting ? <>
          <p>{t('projects.currentReviewer')}: {currentReviewer ?? t('projects.reviewerHomeDefault')}</p>
          <label>{t('projects.newReviewer')}<select value={reassignPrincipal}
            disabled={candidatesLoading} onChange={event => { setReassignPrincipal(event.target.value) }}>
            <option value="">{candidatesLoading ? t('projects.loadingReviewers') : t('projects.chooseReviewer')}</option>
            {reviewerCandidates.filter(item => item.userId !== currentReviewer).map(item =>
              <option key={item.userId} value={item.userId}>{item.name} ({item.userId})</option>)}
          </select></label>
          {!candidatesLoading && reviewerCandidates.length === 0
            ? <p>{t('projects.noReviewerCandidates')}</p> : null}
          <label>{t('projects.planReason')}<textarea maxLength={4000}
            value={reassignReason} onChange={event => { setReassignReason(event.target.value) }} /></label>
          <button type="button" className="ba-button"
            disabled={busy || candidatesLoading || !reassignPrincipal || !reassignReason.trim()}
            onClick={() => { void reassign() }}>{t('projects.confirmReassign')}</button>
        </> : null}
      </div>
    </details> : null}
    {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
  </section>
}
