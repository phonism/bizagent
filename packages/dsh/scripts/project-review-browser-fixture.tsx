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

let project = {
  id: 'project-demo', title: '季度报告证据整理', lead: 'business:search',
  goal: '形成一份可复核的季度报告。', doneWhen: '数据来源完整，报告结论有文件依据。',
  updatedAt: '2026-09-28T00:00:00.000Z',
  status: 'awaiting_acceptance', revision: 2, claims: [{ id: 'claim-1',
    summary: '报告与证据已提交', body: '已核对指标来源，并整理为可复核的交付文件。',
    doneWhenAssessment: '三项指标均有来源；结论与数据一致。', work: [{
      id: 'work-1', status: 'completed', resultSubject: '来源字段已核对',
      resultBody: '三项指标均有可靠来源。', resultArtifacts: [{
        path: 'artifacts/fields.md', bytes: 256, sha256: 'b'.repeat(64),
      }],
    }],
    artifacts: [{ path: 'artifacts/report.md', bytes: 2048, sha256: 'a'.repeat(64) }],
  }], currentClaimId: 'claim-1', reviews: [], seats: [],
}
const api = {
  async projects() { return { homeAddress: 'business:search', projects: [project] } },
  async projectDetail() { return { project, work: [] } },
  async projectReviewAccess() { return { canReview: project.status === 'awaiting_acceptance',
    revision: project.revision, claimId: project.currentClaimId } },
  async projectOutcomeReviewInbox(offset = 0) { return { items: offset > 0
    || project.status !== 'awaiting_acceptance' ? [] : [{
    projectId: project.id, projectTitle: project.title, lead: project.lead,
    goal: project.goal, doneWhen: project.doneWhen, revision: project.revision,
    claimId: project.currentClaimId, submittedAt: '2026-09-28T08:00:00.000Z',
    summary: project.claims[0].summary, body: project.claims[0].body,
    doneWhenAssessment: project.claims[0].doneWhenAssessment,
    work: project.claims[0].work, artifacts: project.claims[0].artifacts,
  }] } },
  async reviewProjectAsHuman(input: { decision: 'accept' | 'rework'; reason: string }) {
    project = { ...project, revision: project.revision + 1,
      status: input.decision === 'accept' ? 'accepted' : 'open',
      reviews: [...project.reviews, { claimId: 'claim-1', decision: input.decision,
        reason: input.reason, reviewedByPrincipal: 'alice' }] }
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
