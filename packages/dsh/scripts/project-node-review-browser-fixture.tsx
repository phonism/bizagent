import { createRoot } from 'react-dom/client'
import { ProjectsDashboard } from '../src/client/projects.js'
import { zh } from '../src/client/locales.js'
import { BIZAGENT_UI_CSS } from '../src/client/styles.js'

const style = document.createElement('style')
style.textContent = `${BIZAGENT_UI_CSS}\n:root {
  --dsw-alias-bg-base: #f7f8fc; --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #f0f3fa; --dsw-alias-bg-mask-3: #23304b;
  --dsw-alias-label-primary: #18243c; --dsw-alias-label-secondary: #64718a;
  --dsw-alias-label-caption: #8a96aa; --dsw-alias-border-l2: #dce2ed;
  --dsw-alias-border-l3: #c9d2e2; --dsw-font-family: 'Avenir Next', 'PingFang SC', sans-serif;
  --ds-font-family-code: ui-monospace, SFMono-Regular, Menlo, monospace;
}\n.ba-projects-shell { width: min(1280px, 100vw); height: 92vh; }`
document.head.append(style)

type FixtureStep = { id: string; title: string; intent: string; executor: string
  acceptanceCriteria: string; after: string[]; reviewer?: string; reviewCriteria?: string }
let project: {
  id: string; title: string; lead: string; goal: string; doneWhen: string; updatedAt: string
  status: string; revision: number; workflow: { revision: number; summary: string;
    steps: FixtureStep[] }; claims: never[]; reviews: never[]
  nodeReviews: Array<{ nodeId: string; workId: string; decision: string; reason: string;
    reviewedByPrincipal: string }>; seats: never[]
  nodeReviewerAssignments: Array<{ nodeId: string; workId: string; reviewerHome: string;
    assignedPrincipal: string; assignedByPrincipal: string; reason: string; at: string }>
  intervention?: { paused: boolean; epoch: number; history: Array<{ reason: string }> }
} = {
  id: 'project-demo', title: '季度报告证据整理', lead: 'business:search',
  goal: '形成一份可复核的季度报告。', doneWhen: '数据来源完整，报告结论有文件依据。',
  updatedAt: '2026-09-28T00:00:00.000Z', status: 'open', revision: 2,
  workflow: { revision: 1, summary: '先核对数据，再提交报告。', steps: [{ id: 'verify', title: '核对指标',
    intent: '核对报告和数据来源。', executor: 'capability:analyst',
    reviewer: 'capability:checker', reviewCriteria: '每项指标都能追溯到来源。',
    acceptanceCriteria: '提交核对结果。', after: [] }] },
  claims: [], reviews: [], nodeReviews: [], nodeReviewerAssignments: [], seats: [],
}
let nodeStatus: 'waiting' | 'done' | 'ready' = 'waiting'
const work = [{ id: 'work-1', goal: '核对指标', status: 'completed', assignee: 'capability:analyst',
  workflowNodeId: 'verify',
  resultSubject: '指标来源已核对', resultBody: '三项指标均有可追溯来源。',
  resultArtifacts: [{ path: 'artifacts/check.md', bytes: 512, sha256: 'a'.repeat(64) }] }]
const workflow = () => ({ nodes: project.workflow.steps.map(step => ({
  id: step.id, title: step.title, executor: step.executor, after: step.after,
  status: step.id === 'verify' ? nodeStatus : 'ready', attempts: step.id === 'verify' ? 1 : 0,
  ...(step.id === 'verify' ? { latestWorkId: 'work-1', latestWorkStatus: 'completed' } : {}),
})),
readyNodeIds: [] })
const api = {
  async projects() { return { homeAddress: 'business:search', projects: [project],
    progress: { 'project-demo': workflow() } } },
  async projectDetail() { return { project, work, workflow: workflow() } },
  async projectNodeReviewAccess() { return { canReview: nodeStatus === 'waiting'
    && !project.intervention?.paused
    && !project.nodeReviewerAssignments.length,
    revision: project.revision, workId: 'work-1' } },
  async projectNodeReviewInbox(offset = 0) { return { items: offset > 0 || nodeStatus !== 'waiting'
    || project.intervention?.paused || project.nodeReviewerAssignments.length ? [] : [{
    projectId: project.id, projectTitle: project.title, revision: project.revision,
    nodeId: 'verify', nodeTitle: '核对指标', reviewCriteria: '每项指标都能追溯到来源。',
    reviewerHome: 'capability:checker', workId: 'work-1',
    completedAt: '2026-09-28T08:00:00.000Z', resultSubject: '指标来源已核对',
    resultBody: '三项指标均有可追溯来源。', resultArtifacts: work[0].resultArtifacts,
  }] } },
  async projectInterventionAccess() { return { revision: project.revision,
    canPause: !project.intervention?.paused, canResume: Boolean(project.intervention?.paused) } },
  async projectInterventionAsHuman(input: { action: 'pause' | 'resume'; reason?: string }) {
    project = { ...project, revision: project.revision + 1,
      intervention: { paused: input.action === 'pause', epoch: input.action === 'pause' ? 0 : 1,
        history: [{ reason: input.reason ?? '复核调整' }] } }
    return { project }
  },
  async projectPlanAccess(_projectId: string, _signal?: AbortSignal, nodeId?: string) {
    return { revision: project.revision,
    workflowRevision: project.workflow.revision,
    canAmend: !project.intervention?.paused, canRebuild: Boolean(project.intervention?.paused),
    canReopen: !project.intervention?.paused, canReassign: !project.intervention?.paused,
    ...(nodeId ? { reviewerCandidates: [{ userId: 'bob', name: 'Bob' }] } : {}) } },
  async projectPlanActionAsHuman(input: { action: 'amend' | 'rebuild' | 'reopen' | 'reassign';
    workflow?: { summary: string; steps: FixtureStep[] }; reason?: string;
    assignedPrincipal?: string }) {
    if (input.action === 'reopen') nodeStatus = 'ready'
    else if (input.action === 'reassign') project = { ...project,
      nodeReviewerAssignments: [...project.nodeReviewerAssignments, {
        nodeId: 'verify', workId: 'work-1', reviewerHome: 'capability:checker',
        assignedPrincipal: input.assignedPrincipal ?? 'bob', assignedByPrincipal: 'manager',
        reason: input.reason ?? '', at: new Date().toISOString(),
      }] }
    else if (input.workflow) project = { ...project, workflow: {
      ...input.workflow, revision: project.workflow.revision + 1 } }
    project = { ...project, revision: project.revision + 1 }
    return { project }
  },
  async reviewProjectNodeAsHuman(input: { decision: 'approve' | 'rework'; reason: string }) {
    nodeStatus = input.decision === 'approve' ? 'done' : 'ready'
    project = { ...project, revision: project.revision + 1,
      nodeReviews: [...project.nodeReviews, { nodeId: 'verify', workId: 'work-1',
        decision: input.decision, reason: input.reason, reviewedByPrincipal: 'alice' }] as never }
    return { project }
  },
}
const t = ((key: keyof typeof zh, params?: Record<string, string | number>) =>
  (zh[key] ?? key).replace(/\{(\w+)\}/g, (_match, field: string) =>
    String(params?.[field] ?? `{${field}}`))) as never
createRoot(document.getElementById('root')!).render(
  <div className="ba-overlay"><ProjectsDashboard api={api as never}
    sessionId={new URLSearchParams(location.search).has('noSession') ? undefined : 'session-demo'}
    t={t} /></div>)
