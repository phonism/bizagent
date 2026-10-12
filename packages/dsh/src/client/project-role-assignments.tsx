import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UiProjectRoleAssignmentAccess } from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'

type T = PropsLocale<'bizagent'>['t']
const freshKey = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

export function ProjectRoleAssignmentsPanel({ projectId, revision, api, t, onChanged }: {
  projectId: string; revision: number; api: BizAgentUiPort; t: T; onChanged: () => void
}) {
  const [access, setAccess] = useState<UiProjectRoleAssignmentAccess>()
  const [roleHome, setRoleHome] = useState('')
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')
  const [candidates, setCandidates] = useState<Array<{ id: string; label: string }>>()
  const [requestId, setRequestId] = useState(freshKey)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!api.projectRoleAssignmentsAccess) { setAccess(undefined); return }
    const abort = new AbortController()
    setAccess(undefined)
    setCandidates(undefined)
    setRoleHome('')
    setTarget('')
    setEditing(false)
    void api.projectRoleAssignmentsAccess(projectId, undefined, abort.signal)
      .then(next => { if (!abort.signal.aborted) setAccess(next) })
      .catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { abort.abort() }
  }, [api, projectId, revision])
  const selectedRole = roleHome || access?.roles[0]?.roleHome || ''
  useEffect(() => {
    if (!access?.canManage || !editing || !selectedRole || !api.projectRoleAssignmentsAccess) {
      setCandidates(undefined)
      return
    }
    const abort = new AbortController()
    setCandidates(undefined)
    void api.projectRoleAssignmentsAccess(projectId, selectedRole, abort.signal)
      .then(next => {
        if (!abort.signal.aborted && next?.projectRevision === access.projectRevision) {
          setCandidates(next.candidates)
        }
      })
      .catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { abort.abort() }
  }, [api, projectId, selectedRole, access?.projectRevision, access?.canManage, editing])
  if (access === undefined) return null
  const save = async (action: 'assign' | 'clear' | 'reject', role: string,
    principal?: string, suggestionId?: string): Promise<void> => {
    if (!access.canManage || !api.decideProjectRoleAsHuman || !reason.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await api.decideProjectRoleAsHuman({ projectId, roleHome: role, action,
        ...(principal === undefined ? {} : { targetPrincipal: principal }),
        ...(suggestionId === undefined ? {} : { suggestionId }),
        expectedProjectRevision: access.projectRevision,
        expectedBindingRevision: access.revision,
        idempotencyKey: suggestionId === undefined ? requestId : `${suggestionId}:${action}`,
        reason: reason.trim() })
      setReason('')
      setRequestId(freshKey())
      setEditing(false)
      onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const pending = access.suggestions.filter(item => item.status === 'pending')
  return <section className="ba-projects-section ba-projects-human-review">
    <h5>{t('projects.roleAssignments')}</h5>
    <p>{t('projects.roleAssignmentsHint')}</p>
    {access.bindings.length === 0 ? <p>{t('projects.noRoleBindings')}</p> : <ul>
      {access.bindings.map(item => <li key={item.roleHome}>
        <code>{item.roleHome}</code> → {item.principal}
      </li>)}
    </ul>}
    {pending.length > 0 ? <ul>{pending.map(item => <li key={item.id}>
      <strong>{t('projects.roleSuggested')}: <code>{item.roleHome}</code> → {item.proposedPrincipal}</strong>
      <p>{item.reason}</p>
      {access.canManage && api.decideProjectRoleAsHuman ? <div>
        <button type="button" className="ba-button" disabled={busy || !reason.trim()}
          onClick={() => { void save('assign', item.roleHome, item.proposedPrincipal, item.id) }}>
          {t('projects.roleConfirm')}
        </button>
        <button type="button" className="ba-button" disabled={busy || !reason.trim()}
          onClick={() => { void save('reject', item.roleHome, undefined, item.id) }}>
          {t('projects.roleReject')}
        </button>
      </div> : null}
    </li>)}</ul> : null}
    {access.canManage && api.decideProjectRoleAsHuman ? <>
      <label>{t('projects.roleDecisionReason')}
        <input value={reason} maxLength={2000} onChange={event => {
          setReason(event.target.value); setRequestId(freshKey())
        }} /></label>
      {access.roles.length > 0 ? <>
        <button type="button" className="ba-button" onClick={() => { setEditing(value => !value) }}>
          {editing ? t('projects.roleCloseEditor') : t('projects.roleEdit')}
        </button>
        {editing ? <div>
          <label>{t('projects.roleHome')}
            <select value={selectedRole} onChange={event => {
              setRoleHome(event.target.value); setTarget(''); setRequestId(freshKey())
            }}>
              {access.roles.map(item => <option key={item.roleHome} value={item.roleHome}>
                {item.roleHome} · {item.responsibility}
              </option>)}
            </select></label>
          <label>{t('projects.rolePrincipal')}
            <select value={target} onChange={event => {
              setTarget(event.target.value); setRequestId(freshKey())
            }}>
              <option value="">{t('projects.roleVacant')}</option>
              {(candidates ?? []).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select></label>
          <button type="button" className="ba-button" data-variant="primary"
            disabled={busy || !reason.trim() || (target !== '' && candidates === undefined)
              || (target === '' && !access.bindings.some(item => item.roleHome === selectedRole))}
            onClick={() => { void save(target ? 'assign' : 'clear', selectedRole, target || undefined) }}>
            {t('projects.roleSave')}
          </button>
        </div> : null}
      </> : null}
    </> : null}
    {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
  </section>
}
