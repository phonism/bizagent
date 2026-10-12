import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectDeliveryFeedbackPanel } from '../src/client/project-delivery-feedback.js'
import { ProjectRoleAssignmentsPanel } from '../src/client/project-role-assignments.js'
import { zh } from '../src/client/locales.js'
import { BIZAGENT_UI_CSS } from '../src/client/styles.js'

const style = document.createElement('style')
style.textContent = `${BIZAGENT_UI_CSS}\n:root {
  --dsw-alias-bg-base: #f7f8fc; --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #f0f3fa; --dsw-alias-bg-mask-3: #23304b;
  --dsw-alias-label-primary: #18243c; --dsw-alias-label-secondary: #64718a;
  --dsw-alias-label-caption: #8a96aa; --dsw-alias-border-l2: #dce2ed;
  --dsw-alias-border-l3: #c9d2e2; --dsw-font-family: 'Avenir Next', 'PingFang SC', sans-serif;
}\nbody { margin: 0; background: #f7f8fc; color: #18243c; font-family: 'PingFang SC', sans-serif; }
#root { max-width: 900px; margin: 24px auto; padding: 20px; }`
document.head.append(style)

let projectRevision = 4
let roleRevision = 0
let bindings: Array<{ roleHome: string; principal: string; byPrincipal: string; at: string }> = []
let suggestions = [{ id: 'suggestion-bob', roleHome: 'role:analyst', proposedPrincipal: 'bob',
  reason: '负责核对样本口径。', bySessionId: 'session-analyst',
  at: '2026-09-28T08:00:00.000Z', status: 'pending' }]
let feedback = [{ id: 'feedback-existing', path: 'context/evidence.md', version: 'working',
  sha256: 'a'.repeat(64), section: '样本范围', body: '请补充样本来源。',
  at: '2026-09-28T08:00:00.000Z', byPrincipal: 'reviewer',
  resolution: undefined }]
const api = {
  async projectRoleAssignmentsAccess(_projectId: string, roleHome?: string) {
    return { projectId: 'project-demo', projectRevision, revision: roleRevision, canManage: true,
      roles: [{ roleHome: 'role:analyst', responsibility: '核对数据口径' }], bindings, suggestions,
      ...(roleHome ? { candidates: [{ id: 'bob', label: 'Bob' }, { id: 'carol', label: 'Carol' }] } : {}) }
  },
  async decideProjectRoleAsHuman(input: { action: string; roleHome: string; targetPrincipal?: string;
    suggestionId?: string }) {
    projectRevision++
    if (input.action !== 'reject') roleRevision++
    bindings = input.action === 'assign' && input.targetPrincipal
      ? [{ roleHome: input.roleHome, principal: input.targetPrincipal,
        byPrincipal: 'manager', at: new Date().toISOString() }] : []
    suggestions = suggestions.map(item => item.id === input.suggestionId
      ? { ...item, status: input.action === 'reject' ? 'rejected' : 'accepted' } : item)
    return { projectRevision }
  },
  async projectDeliveryFeedbackAccess() {
    return { projectId: 'project-demo', revision: projectRevision, canFeedback: true,
      workingAssets: [{ path: 'context/evidence.md', revision: 2,
        sha256: 'b'.repeat(64), bytes: 256 }],
      submitted: { claimId: 'claim-1', artifacts: [{ path: 'artifacts/result.md',
        sha256: 'c'.repeat(64), bytes: 512 }] }, feedback }
  },
  async commentProjectDeliveryAsHuman(input: { path: string; version: 'working' | 'submitted';
    expectedSha256: string; section?: string; body: string }) {
    projectRevision++
    feedback = [...feedback, { id: `feedback-${feedback.length + 1}`, path: input.path,
      version: input.version, sha256: input.expectedSha256, section: input.section,
      body: input.body, at: new Date().toISOString(), byPrincipal: 'reviewer',
      resolution: undefined }]
    return { projectRevision }
  },
}
const t = ((key: keyof typeof zh, params?: Record<string, string | number>) =>
  (zh[key] ?? key).replace(/\{(\w+)\}/g, (_match, field: string) =>
    String(params?.[field] ?? `{${field}}`))) as never

function Fixture() {
  const [revision, setRevision] = useState(0)
  return <>
    <h1>Project 协作页面测试</h1>
    <ProjectDeliveryFeedbackPanel projectId="project-demo" revision={revision}
      api={api as never} t={t} onChanged={() => { setRevision(value => value + 1) }} />
    <ProjectRoleAssignmentsPanel projectId="project-demo" revision={revision}
      api={api as never} t={t} onChanged={() => { setRevision(value => value + 1) }} />
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
