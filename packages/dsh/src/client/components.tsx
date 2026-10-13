import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react'
import {
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconWarningOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  LearningKind,
  UiAsset,
  UiCreateOrganizationRequest,
  UiHomeDetail,
  UiHomeSummary,
  UiLearningSchedule,
  UiMemoryUseOutcomes,
  UiOverview,
} from '../ui-contract.js'
import { BIZAGENT_SAMPLE_ORGANIZATION_ID } from '../ui-contract.js'
import type { BizAgentUiPort, UiSharedKnowledgeReviews } from './api.js'
import type { BizAgentUiController } from './controller.js'
import { ProjectsDashboard } from './projects.js'
import { HumanInboxDashboard } from './human-inbox.js'
import { SampleGuide } from './sample-guide.js'

export interface BizAgentUiFace {
  controller: BizAgentUiController
  api: BizAgentUiPort
  openAgentSession: (input: { homeAddress: string } | { projectId: string }) => Promise<void>
}

type LauncherProps = PropsRuntime<'sidebar.footer.action'>
  & InjectFace<BizAgentUiFace>
  & PropsLocale<'bizagent'>

type DashboardProps = PropsRuntime<'shell.overlay'>
  & InjectFace<BizAgentUiFace>
  & PropsLocale<'bizagent'>

const KINDS: LearningKind[] = ['memory', 'insight', 'knowledge', 'method']
const STATUSES = ['active', 'candidate', 'superseded', 'retired'] as const
const HOME_TYPES = ['personal', 'line', 'business', 'role', 'capability'] as const
type DashboardView = 'organization' | 'learning' | 'projects' | 'humanInbox'

function BizAgentMark() {
  return (
    <svg className="ba-mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path className="ba-mark-base" d="M6 41 32 27 58 41 32 56Z" />
      <path className="ba-mark-middle" d="M6 29 32 15 58 29 32 44Z" />
      <path className="ba-mark-top" d="M6 17 32 3 58 17 32 32Z" />
    </svg>
  )
}

export function BizAgentLauncher({ wide, controller, api, t }: LauncherProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [overview, setOverview] = useState<UiOverview>()
  const currentOrganization = overview?.organization

  useEffect(() => {
    const abort = new AbortController()
    void api.overview(abort.signal).then(setOverview).catch(() => undefined)
    return () => { abort.abort() }
  }, [api, snapshot.revision])

  return (
    <Tooltip label={t('launcher.aria')} delayMs={500} disabled={wide}>
      <button
        type="button"
        className="ba-launcher"
        data-rail={wide ? 'false' : 'true'}
        aria-label={t('launcher.aria')}
        aria-pressed={snapshot.open}
        onClick={() => { controller.toggle() }}
      >
        <BizAgentMark />
        {wide ? (
          <span className="ba-launcher-copy">
            <span>{t('launcher.label')}</span>
            <small>{currentOrganization?.name ?? t('launcher.hint')}</small>
          </span>
        ) : null}
      </button>
    </Tooltip>
  )
}

export function BizAgentDashboard({ controller, api, openAgentSession, t, useSessions, useWorkspaces }: DashboardProps) {
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot).open
  // The Session shown in the main view is the one the main view retains (as DSH itself derives it).
  const currentSessionId = useSessions(state => mainViewSession(state.byId)?.id)
  const currentCwd = useSessions(state => mainViewSession(state.byId)?.cwd)
  const workspaces = useWorkspaces(state => state.items)
  const currentWorkspace = useMemo(
    () => currentDshWorkspace(workspaces, currentSessionId, currentCwd),
    [currentCwd, currentSessionId, workspaces],
  )
  const dialogRef = useRef<HTMLElement>(null)
  const [overview, setOverview] = useState<UiOverview>()
  const [detail, setDetail] = useState<UiHomeDetail>()
  const [selectedAddress, setSelectedAddress] = useState<string>()
  const [selectedAsset, setSelectedAsset] = useState<string>()
  const [selectedProposal, setSelectedProposal] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const [createOpen, setCreateOpen] = useState(false)
  const [localHumanStatus, setLocalHumanStatus] = useState<'hidden' | 'needed' | 'ready'>('hidden')
  const [localHumanTokenInput, setLocalHumanTokenInput] = useState('')
  const [localHumanError, setLocalHumanError] = useState(false)
  const [localHumanBusy, setLocalHumanBusy] = useState(false)
  const [localHumanEpoch, setLocalHumanEpoch] = useState(0)
  const [view, setView] = useState<DashboardView>('organization')

  const load = async (preferred?: string, signal?: AbortSignal): Promise<void> => {
    const nextOverview = await api.overview(signal)
    const address = nextOverview.homes.some(home => home.address === preferred)
      ? preferred
      : nextOverview.organization?.businessHome ?? nextOverview.homes[0]?.address
    const nextDetail = address === undefined ? undefined : await api.home(address, signal)
    setOverview(nextOverview)
    setSelectedAddress(address)
    setDetail(nextDetail)
    setSelectedAsset(undefined)
    if (selectedProposal !== undefined
      && !nextDetail?.proposals.some(proposal => proposal.id === selectedProposal && proposal.status === 'pending')) {
      setSelectedProposal(undefined)
    }
  }

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    setLoading(true)
    setError(undefined)
    void load(selectedAddress, abort.signal)
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(errorMessage(cause))
      })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { abort.abort() }
  }, [open])

  useEffect(() => {
    if (!open || api.localHumanStatus === undefined) return
    const abort = new AbortController()
    void api.localHumanStatus(abort.signal).then(status => {
      if (abort.signal.aborted) return
      // Signed in through DSH's own login: nothing to show or clear.
      setLocalHumanStatus(!status.available || (status.authenticated && status.viaToken === false) ? 'hidden'
        : status.authenticated ? 'ready' : 'needed')
    }).catch(() => { if (!abort.signal.aborted) setLocalHumanStatus('hidden') })
    return () => { abort.abort() }
  }, [api, open])

  const submitLocalHumanToken = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (api.setLocalHumanToken === undefined || localHumanBusy) return
    setLocalHumanBusy(true)
    setLocalHumanError(false)
    try {
      const accepted = await api.setLocalHumanToken(localHumanTokenInput.trim())
      if (!accepted) { setLocalHumanError(true); return }
      setLocalHumanTokenInput('')
      setLocalHumanStatus('ready')
      setLocalHumanEpoch(value => value + 1)
    } catch { setLocalHumanError(true) }
    finally { setLocalHumanBusy(false) }
  }

  const clearLocalHumanToken = async (): Promise<void> => {
    await api.setLocalHumanToken?.(undefined)
    setLocalHumanStatus('needed')
    setLocalHumanEpoch(value => value + 1)
  }

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (dialogRef.current?.querySelector('.ba-modal-layer')) setCreateOpen(false)
        else controller.close()
      }
      if (event.key === 'Tab') {
        const dialog = dialogRef.current
        if (dialog === null) return
        const scope = dialog.querySelector('.ba-modal-layer') ?? dialog
        const controls = [...scope.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex="0"]')]
          .filter(element => !element.hasAttribute('disabled') && element.getClientRects().length > 0)
        const first = controls[0]
        const last = controls.at(-1)
        if (first === undefined || last === undefined) { event.preventDefault(); return }
        if (event.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement) || document.activeElement === dialog)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previousFocus?.focus()
      document.body.style.overflow = previousOverflow
    }
  }, [controller, open])

  if (!open) return null

  const selectHome = async (address: string): Promise<void> => {
    if (address === selectedAddress && detail !== undefined) return
    setSelectedAddress(address)
    setSelectedAsset(undefined)
    setSelectedProposal(undefined)
    setError(undefined)
    try {
      setDetail(await api.home(address))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    setError(undefined)
    try {
      await load(selectedAddress)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setRefreshing(false)
    }
  }

  const onCreated = async (created: UiHomeDetail): Promise<void> => {
    const nextOverview = await api.overview()
    setOverview(nextOverview)
    setSelectedAddress(created.home.address)
    setDetail(created)
    setSelectedAsset(undefined)
    setSelectedProposal(undefined)
    setCreateOpen(false)
  }

  const onDecision = async (updated: UiHomeDetail): Promise<void> => {
    setDetail(updated)
    setOverview(await api.overview())
    setSelectedProposal(undefined)
  }


  const onOrganizationCreated = async (nextOverview: UiOverview): Promise<void> => {
    const address = nextOverview.organization?.businessHome
    setOverview(nextOverview)
    setView('organization')
    if (address !== undefined) {
      setSelectedAddress(address)
      setDetail(await api.home(address))
    }
  }

  return (
    <div className="ba-overlay" onPointerDown={(event) => {
      if (event.target === event.currentTarget) controller.close()
    }}>
      <section
        ref={dialogRef}
        className="ba-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ba-dashboard-title"
        tabIndex={-1}
      >
        <header className="ba-topbar">
          <span className="ba-brand-sigil"><BizAgentMark /></span>
          <div className="ba-title-wrap">
            <h2 className="ba-title" id="ba-dashboard-title">{t('dashboard.title')}</h2>
            <p className="ba-subtitle">{t('dashboard.subtitle')}</p>
          </div>
          <nav className="ba-view-tabs" aria-label={t('nav.aria')}>
            {overview?.organization !== undefined ? (
              <>
              <button type="button" data-active={view === 'organization' ? 'true' : 'false'} onClick={() => { setView('organization') }}>
                {t('nav.organization')}
              </button>
              <button type="button" data-active={view === 'learning' ? 'true' : 'false'} onClick={() => { setView('learning') }}>
                {t('nav.learning')}
              </button>
              <button type="button" data-active={view === 'projects' ? 'true' : 'false'} onClick={() => { setView('projects') }}>
                {t('nav.projects')}
              </button>
              </>
            ) : null}
            <button type="button" data-active={view === 'humanInbox' ? 'true' : 'false'} onClick={() => { setView('humanInbox') }}>
              {t('nav.humanInbox')}
            </button>
          </nav>
          <div className="ba-top-actions">
            {overview !== undefined && currentWorkspace !== undefined ? (
              <span className="ba-current-location">
                <strong>{currentWorkspace.title}</strong>
                <span>/</span>
                <code>{samePath(overview.organizationLocation?.workspacePath, currentWorkspace.path)
                  // A Home's own Workspace lies inside the organization directory.
                  || (overview.organizationLocation !== undefined
                    && pathContains(overview.organizationLocation.organizationRoot, currentWorkspace.path))
                  ? `bizagent/${overview.organization?.id ?? ''}` : t('workspace.noOrganization')}</code>
              </span>
            ) : null}
            {overview !== undefined ? (
              <span className="ba-health" data-ok={overview.health.ok ? 'true' : 'false'}>
                <span className="ba-health-dot" aria-hidden="true" />
                {overview.health.ok ? t('health.ok') : t('health.issue', { count: overview.health.issues.length })}
              </span>
            ) : null}
            <Tooltip label={t('dashboard.refresh')} delayMs={400}>
              <button
                type="button"
                className="ba-icon-button"
                aria-label={t('dashboard.refresh')}
                disabled={refreshing || loading}
                onClick={() => { void refresh() }}
              >
                <IconRefreshOutlineRegular size={16} />
              </button>
            </Tooltip>
            <Tooltip label={t('dashboard.close')} delayMs={400}>
              <button
                type="button"
                className="ba-icon-button"
                aria-label={t('dashboard.close')}
                onClick={() => { controller.close() }}
              >
                <IconCloseOutlineRegular size={16} />
              </button>
            </Tooltip>
          </div>
        </header>

        {localHumanStatus !== 'hidden' ? (
          <div className="ba-local-human-auth">
            {localHumanStatus === 'ready' ? (
              <>
                <span>{t('localHuman.ready')}</span>
                <button type="button" onClick={() => { void clearLocalHumanToken() }}>{t('localHuman.clear')}</button>
              </>
            ) : (
              <form onSubmit={(event) => { void submitLocalHumanToken(event) }}>
                <label htmlFor="ba-local-human-token">{t('localHuman.label')}</label>
                <input id="ba-local-human-token" type="password" autoComplete="off"
                  value={localHumanTokenInput} onChange={event => { setLocalHumanTokenInput(event.target.value) }} />
                <button type="submit" disabled={localHumanBusy || localHumanTokenInput.trim().length === 0}>
                  {t('localHuman.connect')}
                </button>
                {localHumanError ? <span role="alert">{t('localHuman.invalid')}</span> : null}
                <small>{t('localHuman.hint')}</small>
              </form>
            )}
          </div>
        ) : null}

        {loading ? <LoadingState label={t('dashboard.loading')} /> : error !== undefined && overview === undefined ? (
          <FailureState message={t('dashboard.failed', { message: error })} retry={() => { void refresh() }} retryLabel={t('dashboard.retry')} />
        ) : view === 'humanInbox' ? (
          <HumanInboxDashboard key={localHumanEpoch} api={api} t={t} />
        ) : view === 'projects' && overview !== undefined ? (
          <ProjectsDashboard key={`${currentSessionId ?? 'none'}:${localHumanEpoch}`} api={api}
            sessionId={currentSessionId} onOpenMain={projectId => openAgentSession({ projectId })} t={t} />
        ) : overview !== undefined && overview.organization === undefined ? (
          <OrganizationSetup
            api={api}
            workspaces={workspaces}
            currentWorkspacePath={currentWorkspace?.path}
            onCreated={onOrganizationCreated}
            t={t}
          />
        ) : view === 'organization' && overview?.organization !== undefined ? (
          <OrganizationOverview
            overview={overview}
            currentWorkspacePath={currentWorkspace?.path}
            onOpenHome={(address) => {
              void selectHome(address).then(() => { setView('learning') })
            }}
            onOpenLearning={() => { setView('learning') }}
            onOpenChat={homeAddress => openAgentSession({ homeAddress })}
            onOpenProjects={() => { setView('projects') }}
            t={t}
          />
        ) : (
          <div className="ba-body">
            <HomeDirectory
              homes={overview?.homes ?? []}
              selected={selectedAddress}
              onSelect={(address) => { void selectHome(address) }}
              onCreate={() => { setCreateOpen(true) }}
              t={t}
            />
            <main className="ba-workspace">
              {error !== undefined ? <p className="ba-inline-error" role="alert">{t('dashboard.failed', { message: error })}</p> : null}
              {detail === undefined ? (
                <EmptyState title={t('directory.empty')} hint="" />
              ) : (
                <HomeWorkspace
                  api={api}
                  detail={detail}
                  sessionId={currentSessionId}
                  selectedAsset={selectedAsset}
                  onSelectAsset={(id) => { setSelectedAsset(current => current === id ? undefined : id) }}
                  onOpenPrincipal={homeAddress => openAgentSession({ homeAddress })}
                  t={t}
                />
              )}
            </main>
            <ProposalInbox key={localHumanEpoch}
              detail={detail}
              selected={selectedProposal}
              onSelect={setSelectedProposal}
              onDecision={onDecision}
              api={api}
              t={t}
            />
          </div>
        )}

        {createOpen ? (
          <CreateHomeDialog
            api={api}
            onCancel={() => { setCreateOpen(false) }}
            onCreated={onCreated}
            t={t}
          />
        ) : null}
      </section>
    </div>
  )
}

type MemberDraft = UiCreateOrganizationRequest['members'][number]
type CapabilityDraft = UiCreateOrganizationRequest['capabilities'][number]

function OrganizationSetup({ api, workspaces, currentWorkspacePath, onCreated, t }: {
  api: BizAgentUiPort
  workspaces: readonly WorkspaceView[]
  currentWorkspacePath: string | undefined
  onCreated: (overview: UiOverview) => Promise<void>
  t: DashboardProps['t']
}) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [mission, setMission] = useState('')
  const [members, setMembers] = useState<MemberDraft[]>(() => teamTemplate('product', t).members)
  const [capabilities, setCapabilities] = useState<CapabilityDraft[]>(() => teamTemplate('product', t).capabilities)
  const [template, setTemplate] = useState('product')
  const [organizationWorkspace, setOrganizationWorkspace] = useState(currentWorkspacePath ?? workspaces[0]?.path ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const validBasics = Boolean(name.trim() && mission.trim() && safeId(id))
  const validMembers = new Set(members.map(member => member.id)).size === members.length
    && members.length > 0 && members.every(member => (
    safeId(member.id) && safeId(member.roleId)
      && member.displayName.trim() && member.roleName.trim() && member.responsibility.trim()
  ))
  const validCapabilities = new Set(capabilities.map(capability => capability.id)).size === capabilities.length
    && capabilities.every(capability => (
    safeId(capability.id) && capability.displayName.trim() && capability.responsibility.trim()
  ))

  const chooseTemplate = (next: string): void => {
    const draft = teamTemplate(next, t)
    setTemplate(next)
    setMembers(draft.members)
    setCapabilities(draft.capabilities)
  }

  const updateMember = (index: number, patch: Partial<MemberDraft>): void => {
    setMembers(current => current.map((member, position) => position === index ? { ...member, ...patch } : member))
  }

  const updateCapability = (index: number, patch: Partial<CapabilityDraft>): void => {
    setCapabilities(current => current.map((capability, position) => position === index ? { ...capability, ...patch } : capability))
  }

  const createSample = async (): Promise<void> => {
    if (api.createSampleOrganization === undefined || organizationWorkspace === '' || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onCreated(await api.createSampleOrganization(organizationWorkspace))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!validBasics || !validMembers || !validCapabilities || organizationWorkspace === '' || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const nextOverview = await api.createOrganization({
        workspacePath: organizationWorkspace,
        id,
        name: name.trim(),
        mission: mission.trim(),
        members: members.map(member => ({
          ...member,
          displayName: member.displayName.trim(),
          roleName: member.roleName.trim(),
          responsibility: member.responsibility.trim(),
          roleId: member.roleId,
        })),
        capabilities: capabilities.map(capability => ({
          ...capability,
          displayName: capability.displayName.trim(),
          responsibility: capability.responsibility.trim(),
        })),
      })
      await onCreated(nextOverview)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="ba-setup-shell">
      <aside className="ba-setup-rail">
        <span className="ba-setup-kicker">{t('setup.kicker')}</span>
        <h3>{t('setup.title')}</h3>
        <p>{t('setup.subtitle')}</p>
        <ol className="ba-steps">
          {[t('setup.step.identity'), t('setup.step.team'), t('setup.step.capabilities'), t('setup.step.directory')].map((label, index) => (
            <li data-active={step === index ? 'true' : 'false'} data-done={step > index ? 'true' : 'false'} key={label}>
              <span>{step > index ? '✓' : index + 1}</span>{label}
            </li>
          ))}
        </ol>
      </aside>
      <form className="ba-setup-content" onSubmit={(event) => {
        event.preventDefault()
        if (step === 0 && validBasics) setStep(1)
        else if (step === 1 && validMembers) setStep(2)
        else if (step === 2 && validCapabilities) setStep(3)
        else if (step === 3) void submit()
      }}>
        {step === 0 ? (
          <div className="ba-setup-stage">
            {api.createSampleOrganization !== undefined ? (
              <div className="ba-sample-offer">
                <div>
                  <strong>{t('setup.sample.title')}</strong>
                  <p>{t('setup.sample.body')}</p>
                </div>
                <button type="button" className="ba-button" data-variant="primary"
                  disabled={busy || organizationWorkspace === ''} onClick={() => { void createSample() }}>
                  {t('setup.sample.action')}
                </button>
                {error !== undefined ? <p className="ba-inline-error" role="alert">{t('setup.failed', { message: error })}</p> : null}
              </div>
            ) : null}
            <p className="ba-stage-number">01 / 04</p>
            <h3>{t('setup.identity.title')}</h3>
            <p className="ba-stage-lead">{t('setup.identity.lead')}</p>
            <div className="ba-setup-grid">
              <label className="ba-form-field">
                <span className="ba-field-label">{t('setup.name')}</span>
                <input className="ba-input" autoFocus value={name} placeholder={t('setup.name.placeholder')} onChange={(event) => {
                  const next = event.target.value
                  setName(next)
                  if (!idTouched) setId(safeSlug(next))
                }} />
              </label>
              <label className="ba-form-field">
                <span className="ba-field-label">{t('setup.id')}</span>
                <input className="ba-input" value={id} placeholder="acme-labs" onChange={(event) => {
                  setIdTouched(true)
                  setId(safeSlug(event.target.value))
                }} />
              </label>
              <label className="ba-form-field" data-wide="true">
                <span className="ba-field-label">{t('setup.mission')}</span>
                <textarea className="ba-textarea ba-mission-input" value={mission} placeholder={t('setup.mission.placeholder')} onChange={(event) => { setMission(event.target.value) }} />
              </label>
            </div>
          </div>
        ) : step === 1 ? (
          <div className="ba-setup-stage">
            <p className="ba-stage-number">02 / 04</p>
            <h3>{t('setup.team.title')}</h3>
            <p className="ba-stage-lead">{t('setup.team.lead')}</p>
            <div className="ba-template-row">
              {['product', 'growth', 'compact'].map(value => (
                <button type="button" data-active={template === value ? 'true' : 'false'} onClick={() => { chooseTemplate(value) }} key={value}>
                  {t(`setup.template.${value}` as 'setup.template.product')}
                </button>
              ))}
            </div>
            <div className="ba-draft-list">
              {members.map((member, index) => (
                <article className="ba-member-draft" key={index}>
                  <span className="ba-node-marker" data-type="personal">{index + 1}</span>
                  <label><span>{t('setup.member.name')}</span><input value={member.displayName} onChange={(event) => { updateMember(index, { displayName: event.target.value }) }} /></label>
                  <label><span>{t('setup.member.role')}</span><input value={member.roleName} onChange={(event) => { updateMember(index, { roleName: event.target.value }) }} /></label>
                  <label className="ba-draft-wide"><span>{t('setup.member.responsibility')}</span><input value={member.responsibility} onChange={(event) => { updateMember(index, { responsibility: event.target.value }) }} /></label>
                  <button type="button" className="ba-draft-remove" aria-label={t('setup.remove')} disabled={members.length === 1} onClick={() => { setMembers(current => current.filter((_, position) => position !== index)) }}>×</button>
                </article>
              ))}
            </div>
            <button type="button" className="ba-add-row" onClick={() => { setMembers(current => [...current, emptyMember(current.length + 1, t)]) }}>
              <IconPlusOutlineRegular size={14} /> {t('setup.member.add')}
            </button>
          </div>
        ) : step === 2 ? (
          <div className="ba-setup-stage">
            <p className="ba-stage-number">03 / 04</p>
            <h3>{t('setup.capabilities.title')}</h3>
            <p className="ba-stage-lead">{t('setup.capabilities.lead')}</p>
            <div className="ba-capability-drafts">
              {capabilities.map((capability, index) => (
                <article className="ba-capability-draft" key={index}>
                  <span className="ba-node-marker" data-type="capability" />
                  <label><span>{t('setup.capability.name')}</span><input value={capability.displayName} onChange={(event) => { updateCapability(index, { displayName: event.target.value }) }} /></label>
                  <label><span>{t('setup.capability.responsibility')}</span><input value={capability.responsibility} onChange={(event) => { updateCapability(index, { responsibility: event.target.value }) }} /></label>
                  <button type="button" className="ba-draft-remove" aria-label={t('setup.remove')} onClick={() => { setCapabilities(current => current.filter((_, position) => position !== index)) }}>×</button>
                </article>
              ))}
            </div>
            <button type="button" className="ba-add-row" onClick={() => { setCapabilities(current => [...current, emptyCapability(current.length + 1, t)]) }}>
              <IconPlusOutlineRegular size={14} /> {t('setup.capability.add')}
            </button>
            <div className="ba-setup-summary">
              <span className="ba-home-type-dot" data-type="business" />
              <strong>{name}</strong>
              <span>{t('setup.summary', { members: members.length, capabilities: capabilities.length, homes: 1 + members.length * 2 + capabilities.length })}</span>
            </div>
            {error !== undefined ? <p className="ba-inline-error" role="alert">{t('setup.failed', { message: error })}</p> : null}
          </div>
        ) : (
          <div className="ba-setup-stage">
            <p className="ba-stage-number">04 / 04</p>
            <h3>{t('setup.directory.title')}</h3>
            <p className="ba-stage-lead">{t('setup.directory.lead')}</p>
            {workspaces.length === 0 ? (
              <div className="ba-location-empty">{t('setup.directory.empty')}</div>
            ) : (
              <div className="ba-setup-location">
                <label className="ba-form-field">
                  <span className="ba-field-label">{t('workspace.name')}</span>
                  <select className="ba-select" value={organizationWorkspace} onChange={(event) => { setOrganizationWorkspace(event.target.value) }}>
                    {workspaces.map(workspace => <option value={workspace.path} key={workspace.workspaceId}>{workspace.title}</option>)}
                  </select>
                  <code>{organizationWorkspace}</code>
                </label>
                <OrganizationPathTree workspacePath={organizationWorkspace} organizationId={id} t={t} />
              </div>
            )}
            <p className="ba-location-note">{t('setup.directory.note')}</p>
            {error !== undefined ? <p className="ba-inline-error" role="alert">{t('setup.failed', { message: error })}</p> : null}
          </div>
        )}
        <footer className="ba-setup-actions">
          {step > 0 ? <button type="button" className="ba-button" onClick={() => { setStep(current => current - 1) }}>{t('setup.back')}</button> : <span />}
          {step < 3 ? (
            <button type="submit" className="ba-button" data-variant="primary" disabled={step === 0 ? !validBasics : step === 1 ? !validMembers : !validCapabilities}>
              {t('setup.continue')}
            </button>
          ) : (
            <button type="submit" className="ba-button" data-variant="primary" disabled={organizationWorkspace === '' || busy}>
              {busy ? t('setup.creating') : t('setup.create')}
            </button>
          )}
        </footer>
      </form>
    </main>
  )
}

function OrganizationOverview({ overview, currentWorkspacePath, onOpenHome, onOpenLearning, onOpenChat,
  onOpenProjects, t }: {
  overview: UiOverview
  currentWorkspacePath: string | undefined
  onOpenHome: (address: string) => void
  onOpenLearning: () => void
  onOpenChat: (homeAddress: string) => Promise<void>
  onOpenProjects: () => void
  t: DashboardProps['t']
}) {
  const organization = overview.organization
  if (organization === undefined) return null
  const homeByAddress = new Map(overview.homes.map(home => [home.address, home]))
  const line = organization.lineHome === undefined ? undefined : homeByAddress.get(organization.lineHome)
  const business = homeByAddress.get(organization.businessHome)
  const assigned = new Set([
    ...(organization.lineHome === undefined ? [] : [organization.lineHome]),
    organization.businessHome,
    ...organization.members.flatMap(member => [member.personalHome, member.roleHome]),
    ...organization.capabilityHomes,
  ])
  const unassigned = overview.homes.filter(home => !assigned.has(home.address))

  return (
    <main className="ba-org-shell">
      <header className="ba-org-hero">
        <div className="ba-org-intro">
          <p className="ba-org-kicker">{t('organization.kicker')}</p>
          <h3>{organization.name}</h3>
          <p>{organization.mission}</p>
          <div className="ba-org-metrics">
            <span><strong>{organization.members.length}</strong>{t('organization.members')}</span>
            <span><strong>{organization.capabilityHomes.length}</strong>{t('organization.capabilities')}</span>
            <span><strong>{overview.totals.activeAssets}</strong>{t('organization.learning')}</span>
          </div>
          <button type="button" className="ba-button ba-hero-action" onClick={onOpenLearning}>
            {t('organization.openLearning')}
          </button>
        </div>
        <div className="ba-org-art" aria-hidden="true"><BizAgentMark /></div>
      </header>

      {organization.id === BIZAGENT_SAMPLE_ORGANIZATION_ID
        ? <SampleGuide onOpenChat={onOpenChat} onOpenProjects={onOpenProjects} t={t} /> : null}

      <section className="ba-org-map" aria-label={t('organization.map')}>
        {organization.lineHome !== undefined ? <>
          <button type="button" className="ba-business-node ba-line-node"
            onClick={() => { onOpenHome(organization.lineHome!) }}>
            <span className="ba-node-marker" data-type="line" />
            <div><small>{t('type.line')}</small>
              <strong>{line?.displayName ?? organization.lineHome}</strong>
              <code>{organization.lineHome}</code></div>
          </button>
          <span className="ba-map-trunk" aria-hidden="true" />
        </> : null}
        <button type="button" className="ba-business-node" onClick={() => { onOpenHome(organization.businessHome) }}>
          <span className="ba-node-marker" data-type="business" />
          <div><small>{t('type.business')}</small><strong>{business?.displayName ?? organization.name}</strong><code>{organization.businessHome}</code></div>
        </button>
        <span className="ba-map-trunk" aria-hidden="true" />
        <div className="ba-member-nodes">
          {organization.members.map((member) => {
            const personal = homeByAddress.get(member.personalHome)
            const role = homeByAddress.get(member.roleHome)
            return (
              <button type="button" className="ba-org-member" onClick={() => { onOpenHome(member.personalHome) }} key={member.personalHome}>
                <span className="ba-node-marker" data-type="personal">{initials(personal?.displayName ?? member.personalHome)}</span>
                <span className="ba-org-member-copy">
                  <strong>{personal?.displayName ?? member.personalHome}</strong>
                  <span>{role?.displayName ?? member.roleHome}</span>
                  <code>{member.personalHome}</code>
                </span>
                <span className="ba-role-ribbon"><i className="ba-node-marker" data-type="role" />{t('organization.roleHome')}</span>
              </button>
            )
          })}
        </div>
        {organization.capabilityHomes.length > 0 ? (
          <div className="ba-capability-rail">
            <span className="ba-capability-label">{t('organization.capabilityRail')}</span>
            {organization.capabilityHomes.map((address) => (
              <button type="button" onClick={() => { onOpenHome(address) }} key={address}>
                <span className="ba-node-marker" data-type="capability" />
                <span><strong>{homeByAddress.get(address)?.displayName ?? address}</strong><code>{address}</code></span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="ba-org-next">
        <div><span>1</span><p><strong>{t('organization.next.select')}</strong>{t('organization.next.selectHint')}</p></div>
        <div><span>2</span><p><strong>{t('organization.next.work')}</strong>{t('organization.next.workHint')}</p></div>
        <div><span>3</span><p><strong>{t('organization.next.learn')}</strong>{t('organization.next.learnHint')}</p></div>
      </section>
      <OrganizationDirectory overview={overview} currentWorkspacePath={currentWorkspacePath} t={t} />
      {unassigned.length > 0 ? <p className="ba-unassigned">{t('organization.unassigned', { count: unassigned.length })}</p> : null}
    </main>
  )
}

function OrganizationDirectory({ overview, currentWorkspacePath, t }: {
  overview: UiOverview
  currentWorkspacePath: string | undefined
  t: DashboardProps['t']
}) {
  const location = overview.organizationLocation

  return (
    <section className="ba-organization-location" aria-labelledby="ba-organization-location-title">
      <div className="ba-location-heading">
        <div>
          <p className="ba-org-kicker">{t('location.kicker')}</p>
          <h4 id="ba-organization-location-title">{t('location.title')}</h4>
        </div>
        <p>{t('location.subtitle')}</p>
      </div>
      {location === undefined ? (
        <div className="ba-location-empty">{t('location.legacy', { path: overview.homeRoot })}</div>
      ) : (
        <div className="ba-location-content" data-current={samePath(location.workspacePath, currentWorkspacePath) ? 'true' : 'false'}>
          <OrganizationPathTree workspacePath={location.workspacePath} organizationId={location.organizationId} t={t} />
          <div className="ba-location-facts">
            <span>{samePath(location.workspacePath, currentWorkspacePath) ? t('location.current') : t('location.otherWorkspace')}</span>
            <code>{location.organizationRoot}</code>
          </div>
        </div>
      )}
    </section>
  )
}

function OrganizationPathTree({ workspacePath, organizationId, t }: {
  workspacePath: string
  organizationId: string
  t: DashboardProps['t']
}) {
  return (
    <div className="ba-path-tree" aria-label={t('location.tree')}>
      <div data-level="0"><span className="ba-folder-mark" /> <strong>{workspaceName(workspacePath)}</strong><small>{t('location.workspace')}</small></div>
      <div data-level="1"><span className="ba-folder-mark" /> <strong>bizagent</strong><small>{t('location.container')}</small></div>
      <div data-level="2"><span className="ba-folder-mark" data-active="true" /> <strong>{organizationId || 'organization-id'}</strong><small>{t('location.organization')}</small></div>
    </div>
  )
}

function HomeDirectory({ homes, selected, onSelect, onCreate, t }: {
  homes: UiHomeSummary[]
  selected: string | undefined
  onSelect: (address: string) => void
  onCreate: () => void
  t: DashboardProps['t']
}) {
  return (
    <aside className="ba-directory">
      <div className="ba-pane-head">
        <h3 className="ba-pane-title">{t('directory.title')}</h3>
        <span className="ba-pane-meta">{t('directory.count', { count: homes.length })}</span>
      </div>
      <button type="button" className="ba-create-button" onClick={onCreate}>
        <IconPlusOutlineRegular size={14} />
        {t('directory.create')}
      </button>
      {homes.length === 0 ? <EmptyState title={t('directory.empty')} hint="" /> : (
        <ul className="ba-home-list">
          {homes.map(home => (
            <li key={home.address}>
              <button
                type="button"
                className="ba-home-button"
                data-active={home.address === selected ? 'true' : 'false'}
                onClick={() => { onSelect(home.address) }}
              >
                <span className="ba-home-type-dot" data-type={home.type} aria-hidden="true" />
                <span className="ba-home-copy">
                  <span className="ba-home-name">{home.displayName}</span>
                  <span className="ba-home-address">{home.address} · r{home.revision}</span>
                </span>
                {home.incomingPending > 0 ? <span className="ba-home-badge">{home.incomingPending}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

function HomeWorkspace({ api, detail, sessionId, selectedAsset, onSelectAsset, onOpenPrincipal, t }: {
  api: BizAgentUiPort
  detail: UiHomeDetail
  sessionId: string | undefined
  selectedAsset: string | undefined
  onSelectAsset: (id: string) => void
  onOpenPrincipal: (homeAddress: string) => Promise<void>
  t: DashboardProps['t']
}) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | LearningKind>('all')
  const [status, setStatus] = useState<'all' | UiAsset['status']>('all')
  const [openError, setOpenError] = useState<string>()
  const summary = detail.home
  const incoming = detail.proposals.filter(proposal => proposal.toAddress === summary.address && proposal.status === 'pending').length
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return detail.assets.filter(asset => kind === 'all' || asset.kind === kind)
      .filter(asset => status === 'all' || asset.status === status)
      .filter((asset) => {
        if (!needle) return true
        return [asset.id, asset.description, asset.body, asset.tags.join(' ')]
          .join('\n').toLocaleLowerCase().includes(needle)
      })
  }, [detail.assets, kind, query, status])

  return (
    <>
      <section className="ba-home-hero">
        <div>
          <div className="ba-type-label">
            <span className="ba-home-type-dot" data-type={summary.type} aria-hidden="true" />
            {t(`type.${summary.type}` as 'type.personal')}
            <span>·</span>
            {t('home.revision', { revision: summary.revision })}
          </div>
          <h3 className="ba-home-heading">{summary.displayName}</h3>
          <div className="ba-address-line">{summary.address}</div>
          <button type="button" className="ba-button" onClick={() => {
            void onOpenPrincipal(summary.address).catch(cause => { setOpenError(errorMessage(cause)) })
          }}>{t('home.openPrincipal')}</button>
          {openError ? <p className="ba-inline-error" role="alert">{openError}</p> : null}
          <div className="ba-home-stats">
            <span>{t('home.episodes', { count: detail.episodes })}</span>
            <span>{t('home.activeAssets', { count: detail.assets.filter(asset => asset.status === 'active').length })}</span>
            <span>{t('home.incoming', { count: incoming })}</span>
          </div>
        </div>
        <blockquote className="ba-identity">
          <span className="ba-identity-label">{t('home.identity')}</span>
          <p className="ba-identity-body">{detail.identity || t('home.identityEmpty')}</p>
        </blockquote>
      </section>

      <LearningSchedulePanel key={`schedule:${summary.address}`} api={api} home={summary.address} t={t} />

      <MemoryStrata detail={detail} t={t} />

      <WorklogPanel key={`worklog:${summary.address}`} detail={detail} t={t} />

      <section className="ba-ledger">
        <div className="ba-ledger-head">
          <div className="ba-ledger-title">
            <h3>{t('assets.title')}</h3>
            <span className="ba-ledger-count">{t('assets.count', { count: filtered.length })}</span>
          </div>
          <div className="ba-filters">
            <label className="ba-search-wrap">
              <span className="ba-search-icon"><IconSearchOutlineRegular size={14} /></span>
              <input
                className="ba-input"
                value={query}
                aria-label={t('assets.search')}
                placeholder={t('assets.search')}
                onChange={(event) => { setQuery(event.target.value) }}
              />
            </label>
            <select className="ba-select" value={kind} aria-label={t('assets.allKinds')} onChange={(event) => { setKind(event.target.value as typeof kind) }}>
              <option value="all">{t('assets.allKinds')}</option>
              {KINDS.map(value => <option value={value} key={value}>{t(`kind.${value}` as 'kind.memory')}</option>)}
            </select>
            <select className="ba-select" value={status} aria-label={t('assets.allStatuses')} onChange={(event) => { setStatus(event.target.value as typeof status) }}>
              <option value="all">{t('assets.allStatuses')}</option>
              {STATUSES.map(value => <option value={value} key={value}>{t(`status.${value}` as 'status.active')}</option>)}
            </select>
          </div>
        </div>
        {filtered.length === 0 ? <EmptyState title={t('assets.empty')} hint={t('assets.emptyHint')} /> : (
          <ul className="ba-asset-list">
            {filtered.map(asset => (
              <AssetRow
                api={api}
                asset={asset}
                sessionId={sessionId}
                open={selectedAsset === asset.id}
                onToggle={() => { onSelectAsset(asset.id) }}
                t={t}
                key={asset.id}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function LearningSchedulePanel({ api, home, t }: {
  api: BizAgentUiPort; home: string; t: DashboardProps['t']
}) {
  const [status, setStatus] = useState<UiLearningSchedule>()
  const [enabled, setEnabled] = useState(false)
  const [cron, setCron] = useState('')
  const [dailyRuns, setDailyRuns] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const adopt = (value: UiLearningSchedule): void => {
    setStatus(value)
    setEnabled(value.hostEnabled && value.configured && (value.policy?.enabled ?? true))
    setCron(value.schedule?.cron ?? '')
    setDailyRuns(value.schedule?.dailyRuns ?? 1)
    setError(undefined)
  }
  const refresh = async (signal?: AbortSignal): Promise<void> => {
    adopt(await api.learningSchedule(home, signal))
  }
  useEffect(() => {
    const abort = new AbortController()
    void refresh(abort.signal).catch(cause => { if (!abort.signal.aborted) setError(errorMessage(cause)) })
    return () => { abort.abort() }
  }, [api, home])
  const save = async (): Promise<void> => {
    if (!status) return
    setBusy(true)
    setError(undefined)
    try {
      const updated = await api.configureLearningSchedule(home, status.policy?.revision ?? 0,
        enabled, cron, dailyRuns)
      adopt(updated)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  const available = status?.hostEnabled && status.configured
  const latest = status?.recentLaunches[0]
  // Scheduling is a host setting; without it there is nothing for the person to do here.
  if (!available && error === undefined) return null
  return <section className="ba-ledger ba-learning-schedule">
    <div className="ba-ledger-head"><div className="ba-ledger-title"><h3>{t('learningSchedule.title')}</h3></div>
      <button type="button" disabled={busy} onClick={() => { void refresh().catch(cause => setError(errorMessage(cause))) }}>
        {t('dashboard.refresh')}</button></div>
    <p>{t(status === undefined ? 'dashboard.loading'
      : available ? 'learningSchedule.available' : 'learningSchedule.unavailable')}</p>
    {available && status?.schedule ? <>
      <div className="ba-learning-schedule-fields">
        <label><span>{t('learningSchedule.enabled')}</span>
          <input type="checkbox" checked={enabled} disabled={busy}
            onChange={event => { setEnabled(event.target.checked) }} /></label>
        <label><span>{t('learningSchedule.cron')} ({status.timeZone})</span>
          <input className="ba-input" value={cron} disabled={busy} maxLength={100}
            onChange={event => { setCron(event.target.value) }} /></label>
        <label><span>{t('learningSchedule.dailyRuns')}</span>
          <input className="ba-input" type="number" min={1} max={status.maxDailyRuns ?? 1}
            value={dailyRuns} disabled={busy}
            onChange={event => { setDailyRuns(Number(event.target.value)) }} /></label>
      </div>
      <small>{t('learningSchedule.model')}: {status.schedule.model} · {t('learningSchedule.maxRuns')}: {status.maxDailyRuns}</small>
      <div className="ba-subscription-actions"><button type="button" disabled={busy}
        onClick={() => { void save() }}>{t('learningSchedule.save')}</button></div>
    </> : null}
    {status?.nextDueAt ? <p>{t('learningSchedule.next')}: {new Date(status.nextDueAt).toLocaleString()}
      {status.cursor?.lastOutcome ? ` · ${t('learningSchedule.last')}: ${status.cursor.lastOutcome}` : ''}</p> : null}
    {latest ? <p>{t('learningSchedule.latestRun')}: {latest.status} · {latest.id}</p> : null}
    {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
  </section>
}

function WorklogPanel({ detail, t }: { detail: UiHomeDetail; t: DashboardProps['t'] }) {
  const [openId, setOpenId] = useState<string>()
  return (
    <section className="ba-ledger ba-worklogs">
      <div className="ba-ledger-head">
        <div className="ba-ledger-title">
          <h3>{t('worklogs.title')}</h3>
          <span className="ba-ledger-count">{t('worklogs.count', { count: detail.worklogCount })}</span>
        </div>
        <p className="ba-worklog-note">{t('worklogs.note')}</p>
      </div>
      {detail.worklogs.length === 0 ? <p className="ba-worklog-empty">{t('worklogs.empty')}</p> : (
        <ul className="ba-asset-list">
          {detail.worklogs.map(item => {
            const open = openId === item.id
            return (
              <li className="ba-asset-item" key={item.id}>
                <button type="button" className="ba-asset-row ba-worklog-row" aria-expanded={open}
                  onClick={() => { setOpenId(open ? undefined : item.id) }}>
                  <span className="ba-kind-chip ba-worklog-status" data-status={item.status}>
                    {t(`worklogs.${item.status}` as 'worklogs.completed')}
                  </span>
                  <span>
                    <span className="ba-asset-description">{item.description}</span>
                    <span className="ba-asset-tags">{formatTime(item.recordedAt)} · {t('worklogs.revision', { revision: item.revision })}
                      {item.origin === 'work-result' ? ` · ${t('worklogs.auto')}`
                        : item.origin === 'session-activity' ? ` · ${t('worklogs.sessionActivity')}` : ''}</span>
                  </span>
                  <span className="ba-asset-metrics">{item.files.length > 0 ? t('worklogs.files', { count: item.files.length }) : ''}</span>
                </button>
                {open ? <div className="ba-asset-detail">
                  <p className="ba-detail-copy">{item.body}</p>
                  <div className="ba-evidence">
                    <h4>{t('worklogs.references')}</h4>
                    <code>{t('worklogs.session')}: {item.sessionId}</code>
                    {item.workId !== undefined ? <code>Work: {item.workId}</code> : null}
                    {item.projectId !== undefined ? <code>Project: {item.projectId}</code> : null}
                    {item.files.map(path => <code key={path}>{path}</code>)}
                  </div>
                </div> : null}
              </li>
            )
          })}
        </ul>
      )}
      {detail.worklogCount > detail.worklogs.length ? (
        <p className="ba-worklog-note">{t('worklogs.more', { count: detail.worklogCount - detail.worklogs.length })}</p>
      ) : null}
    </section>
  )
}

function MemoryStrata({ detail, t }: { detail: UiHomeDetail; t: DashboardProps['t'] }) {
  const counts = {
    episode: detail.episodes,
    memory: detail.assets.filter(asset => asset.kind === 'memory').length,
    insight: detail.assets.filter(asset => asset.kind === 'insight').length,
    knowledge: detail.assets.filter(asset => asset.kind === 'knowledge').length,
    method: detail.assets.filter(asset => asset.kind === 'method').length,
  }
  return (
    <section className="ba-strata">
      <div className="ba-section-heading">
        <h3>{t('strata.title')}</h3>
        <p>{t('strata.subtitle')}</p>
      </div>
      <div className="ba-strata-track">
        {(Object.keys(counts) as Array<keyof typeof counts>).map(kind => (
          <div className="ba-stratum" data-kind={kind} key={kind}>
            <span className="ba-stratum-label">{t(`strata.${kind}` as 'strata.memory')}</span>
            <span className="ba-stratum-count">{counts[kind]}</span>
            <span className="ba-stratum-grains" aria-hidden="true">
              {Array.from({ length: Math.min(counts[kind], 18) }, (_, index) => <i className="ba-grain" key={index} />)}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function AssetRow({ api, asset, sessionId, open, onToggle, t }: {
  api: BizAgentUiPort
  asset: UiAsset
  sessionId: string | undefined
  open: boolean
  onToggle: () => void
  t: DashboardProps['t']
}) {
  return (
    <li className="ba-asset-item">
      <button type="button" className="ba-asset-row" aria-expanded={open} onClick={onToggle}>
        <span className="ba-kind-chip" data-kind={asset.kind}>{t(`kind.${asset.kind}` as 'kind.memory')}</span>
        <span>
          <span className="ba-asset-description">{asset.description}</span>
          <span className="ba-asset-tags">{asset.tags.map(tag => <span className="ba-tag" key={tag}>{tag}</span>)}</span>
        </span>
        <span className="ba-asset-metrics">
          <span>{t('asset.confidence', { value: asset.confidence.toFixed(2) })}</span>
          <span className="ba-fitness" data-negative={asset.fitness < 0 ? 'true' : 'false'}>{formatSigned(asset.fitness)}</span>
        </span>
      </button>
      {open ? (
        <div className="ba-asset-detail">
          <div className="ba-detail-toolbar">
            <span className="ba-detail-revision">
              {t('asset.revision', { revision: asset.revision })} · {formatTime(asset.updatedAt)} · {t(`status.${asset.status}` as 'status.active')}
            </span>
            <button type="button" className="ba-icon-button" aria-label={t('asset.close')} onClick={onToggle}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </div>
          <p className="ba-detail-copy">{asset.body}</p>
          <div className="ba-evidence">
            <h4>{t('asset.evidenceTitle')} · {t('asset.evidence', { count: asset.sourceRefs.length })} · {t('asset.receipts', { count: asset.receiptCount })}</h4>
            {asset.sourceRefs.map((ref, index) => <code key={`${ref.type}-${String(index)}`}>{compactEvidence(ref)}</code>)}
            {asset.proposalApplications?.length ? <>
              <h4>{t('asset.proposalHistory')}</h4>
              {asset.proposalApplications.map(item => <code key={item.proposalId}>
                {item.proposalId} · {t('asset.revision', { revision: item.revision })} · {item.bodySha256.slice(0, 12)}
              </code>)}
            </> : null}
          </div>
          <MemoryUseOutcomesPanel key={`${sessionId ?? 'none'}:${asset.id}`}
            api={api} assetId={asset.id} sessionId={sessionId} t={t} />
        </div>
      ) : null}
    </li>
  )
}

function MemoryUseOutcomesPanel({ api, assetId, sessionId, t }: {
  api: BizAgentUiPort
  assetId: string
  sessionId: string | undefined
  t: DashboardProps['t']
}) {
  const [page, setPage] = useState<UiMemoryUseOutcomes>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    setPage(undefined)
    setError(undefined)
    if (!sessionId) return
    const abort = new AbortController()
    setLoading(true)
    void api.memoryUseOutcomes(sessionId, assetId, undefined, abort.signal)
      .then(setPage)
      .catch(cause => { if (!abort.signal.aborted) setError(errorMessage(cause)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { abort.abort() }
  }, [api, assetId, sessionId])
  const more = async (): Promise<void> => {
    if (!sessionId || !page?.nextBeforeWorkId || loading) return
    setLoading(true)
    setError(undefined)
    try {
      const next = await api.memoryUseOutcomes(sessionId, assetId, page.nextBeforeWorkId)
      setPage({ ...next, outcomes: [...page.outcomes, ...next.outcomes] })
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setLoading(false) }
  }
  return <section className="ba-memory-use">
    <h4>{t('asset.useOutcomes')}</h4>
    <p>{t('asset.useNote')}</p>
    {!sessionId ? <p>{t('asset.useSessionRequired')}</p>
      : error ? <p className="ba-inline-error" role="alert">{t('asset.useUnavailable')}: {error}</p>
        : loading && !page ? <p>{t('dashboard.loading')}</p>
          : page?.outcomes.length === 0 ? <p>{t('asset.useEmpty')}</p> : null}
    {page?.outcomes.map(item => <article className="ba-memory-use-work" key={item.workId}>
      <strong>{item.resultSubject ?? item.workId}</strong>
      <small>{item.completedAt ? formatTime(item.completedAt) : item.workId} · {t('asset.workSource')}: {t(`asset.source.${item.workSourceStatus}`)}</small>
      {item.resultBody ? <p className="ba-detail-copy">{item.resultBody}</p> : null}
      <div className="ba-memory-use-receipts">
        {item.uses.map(use => <span key={use.receiptId}>
          {t(`asset.use.${use.signal}`)} · REV {use.assetRevision ?? '?'} · {t(`asset.source.${use.sourceStatus}`)}
        </span>)}
      </div>
      {item.omittedReceipts > 0 ? <small>{t('asset.useOmitted', { count: item.omittedReceipts })}</small> : null}
    </article>)}
    {page?.nextBeforeWorkId ? <button type="button" disabled={loading} onClick={() => { void more() }}>
      {t('asset.useMore')}</button> : null}
  </section>
}

function ProposalInbox({ detail, selected, onSelect, onDecision, api, t }: {
  detail: UiHomeDetail | undefined
  selected: string | undefined
  onSelect: (id?: string) => void
  onDecision: (detail: UiHomeDetail) => Promise<void>
  api: BizAgentUiPort
  t: DashboardProps['t']
}) {
  const pending = detail?.proposals.filter(proposal => proposal.toAddress === detail.home.address && proposal.status === 'pending') ?? []
  return (
    <aside className="ba-proposals">
      <div className="ba-pane-head">
        <h3 className="ba-pane-title">{t('proposal.title')}</h3>
        <span className="ba-pane-meta">{t('proposal.pending', { count: pending.length })}</span>
      </div>
      {pending.length === 0 ? <EmptyState title={t('proposal.empty')} hint={t('proposal.emptyHint')} /> : (
        <ul className="ba-proposal-list">
          {pending.map(proposal => (
            <li className="ba-proposal-card" key={proposal.id}>
              <button
                type="button"
                className="ba-proposal-summary"
                aria-expanded={selected === proposal.id}
                onClick={() => { onSelect(selected === proposal.id ? undefined : proposal.id) }}
              >
                <span className="ba-proposal-route">{proposal.fromAddress} → {proposal.toAddress}</span>
                <p className="ba-proposal-description">{proposal.description}</p>
                <p className="ba-proposal-body">{proposal.body}</p>
              </button>
              {selected === proposal.id && detail !== undefined ? (
                <ProposalDecision
                  proposal={proposal}
                  targetAsset={detail.assets.find(asset => asset.id === proposal.baseAsset?.id)}
                  ownerAddress={detail.home.address}
                  api={api}
                  onDecision={onDecision}
                  t={t}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <SharedKnowledgeReviewPanel api={api} t={t} />
    </aside>
  )
}

function SharedKnowledgeReviewPanel({ api, t }: { api: BizAgentUiPort; t: DashboardProps['t'] }) {
  const [reviews, setReviews] = useState<UiSharedKnowledgeReviews>()
  const [selected, setSelected] = useState<string>()
  const [decision, setDecision] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const refresh = async (signal?: AbortSignal): Promise<void> => {
    const next = await api.sharedKnowledgeReviews?.(signal)
    if (!signal?.aborted) setReviews(next)
  }
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal).catch(cause => {
      if (!controller.signal.aborted) setError(errorMessage(cause))
    })
    return () => controller.abort()
  }, [api])
  const pending = reviews?.proposals.filter(item => item.proposal.status === 'pending') ?? []
  const item = pending.find(entry => entry.proposal.id === selected)
  const decide = async (action: 'accept' | 'reject'): Promise<void> => {
    if (!item || !decision.trim() || busy || !api.decideSharedKnowledge) return
    setBusy(true)
    setError(undefined)
    try {
      await api.decideSharedKnowledge({ proposalId: item.proposal.id, action, decision: decision.trim() })
      setSelected(undefined)
      setDecision('')
      await refresh()
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  // Shared product-line and platform Knowledge is a team feature; stay out of the way until
  // something actually waits for this person's review.
  if (pending.length === 0 && error === undefined) return null
  return <section className="ba-shared-knowledge-reviews">
    <div className="ba-pane-head"><h3 className="ba-pane-title">{t('sharedKnowledge.title')}</h3>
      <button type="button" disabled={busy} onClick={() => {
        void refresh().catch(cause => setError(errorMessage(cause)))
      }}>{t('dashboard.refresh')}</button></div>
    {pending.length === 0 ? <p>{t('sharedKnowledge.empty')}</p> : <ul className="ba-proposal-list">
      {pending.map(entry => <li className="ba-proposal-card" key={entry.proposal.id}>
        <button type="button" className="ba-proposal-summary"
          aria-expanded={selected === entry.proposal.id}
          onClick={() => { setSelected(entry.proposal.id); setDecision('') }}>
          <strong>{entry.proposal.description}</strong>
          <small>{entry.proposal.target.scope === 'line'
            ? `line:${entry.proposal.target.line}` : 'platform'} · {entry.proposal.fromAddress}</small>
        </button>
      </li>)}
    </ul>}
    {item ? <div className="ba-proposal-form">
      <p className="ba-proposal-current-body">{item.proposal.body}</p>
      <label><span className="ba-field-label">{t('proposal.decision')}</span>
        <textarea className="ba-textarea" value={decision} maxLength={4000}
          placeholder={t('proposal.decisionPlaceholder')}
          onChange={event => setDecision(event.target.value)} /></label>
      <div className="ba-proposal-actions">
        {item.actions.reject ? <button type="button" className="ba-button" data-variant="danger"
          disabled={busy || !decision.trim()} onClick={() => { void decide('reject') }}>
          {t('proposal.reject')}</button> : null}
        {item.actions.accept ? <button type="button" className="ba-button" data-variant="primary"
          disabled={busy || !decision.trim()} onClick={() => { void decide('accept') }}>
          {t('proposal.accept')}</button> : null}
      </div>
    </div> : null}
    {error ? <p className="ba-inline-error" role="alert">{error}</p> : null}
  </section>
}

function ProposalDecision({ proposal, targetAsset, ownerAddress, api, onDecision, t }: {
  proposal: UiHomeDetail['proposals'][number]
  targetAsset: UiHomeDetail['assets'][number] | undefined
  ownerAddress: string
  api: BizAgentUiPort
  onDecision: (detail: UiHomeDetail) => Promise<void>
  t: DashboardProps['t']
}) {
  const [decision, setDecision] = useState('')
  const [busy, setBusy] = useState<'accept' | 'reject'>()
  const [error, setError] = useState<string>()
  const [reviewActions, setReviewActions] = useState({ accept: false, reject: false })
  useEffect(() => {
    const controller = new AbortController()
    void api.proposalReviewActions?.(ownerAddress, proposal.id, controller.signal).then(actions => {
      if (!controller.signal.aborted) setReviewActions(actions)
    })
    return () => controller.abort()
  }, [api, ownerAddress, proposal.id])
  const targetChanged = proposal.baseAsset !== undefined && (!targetAsset
    || targetAsset.revision !== proposal.baseAsset.revision || targetAsset.status !== 'active')

  const decide = async (action: 'accept' | 'reject'): Promise<void> => {
    if (!decision.trim() || busy !== undefined) return
    setBusy(action)
    setError(undefined)
    try {
      const updated = await api.decideProposal({
        ownerAddress,
        proposalId: proposal.id,
        action,
        decision: decision.trim(),
      })
      await onDecision(updated)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="ba-proposal-form">
      {proposal.baseAsset ? (
        <div className="ba-proposal-target">
          <strong>{t('proposal.replaceTarget', { id: proposal.baseAsset.id,
            revision: proposal.baseAsset.revision })}</strong>
          {targetAsset ? <>
            <p>{t('proposal.currentVersion', { revision: targetAsset.revision })}</p>
            <p className="ba-proposal-current-body">{targetAsset.body}</p>
          </> : <p>{t('proposal.targetMissing')}</p>}
          {targetChanged ? <p role="alert">{t('proposal.targetChanged')}</p> : null}
        </div>
      ) : null}
      <div className="ba-proposal-target">
        <strong>{t('proposal.proposedBody')}</strong>
        <p className="ba-proposal-current-body">{proposal.body}</p>
      </div>
      {!reviewActions.accept && !reviewActions.reject ? <p>{t('proposal.reviewUnavailable')}</p> : <label>
        <span className="ba-field-label">{t('proposal.decision')}</span>
        <textarea
          className="ba-textarea"
          value={decision}
          placeholder={t('proposal.decisionPlaceholder')}
          onChange={(event) => { setDecision(event.target.value) }}
        />
      </label>}
      {error !== undefined ? <p className="ba-inline-error" role="alert">{t('proposal.failed', { message: error })}</p> : null}
      {reviewActions.accept || reviewActions.reject ? <div className="ba-proposal-actions">
        {reviewActions.reject ? <button type="button" className="ba-button" data-variant="danger" disabled={!decision.trim() || busy !== undefined} onClick={() => { void decide('reject') }}>
          <IconWarningOutlineRegular size={14} /> {t('proposal.reject')}
        </button> : null}
        {reviewActions.accept ? <button type="button" className="ba-button" data-variant="primary" disabled={!decision.trim() || busy !== undefined || targetChanged} onClick={() => { void decide('accept') }}>
          <IconCheckOutlineRegular size={14} /> {t('proposal.accept')}
        </button> : null}
      </div> : null}
    </div>
  )
}

function CreateHomeDialog({ api, onCancel, onCreated, t }: {
  api: BizAgentUiPort
  onCancel: () => void
  onCreated: (detail: UiHomeDetail) => Promise<void>
  t: DashboardProps['t']
}) {
  const [type, setType] = useState<typeof HOME_TYPES[number]>('personal')
  const [id, setId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [identity, setIdentity] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const cleanId = id.trim().toLowerCase().replace(/\s+/g, '-')
  const address = `${type}:${cleanId}`
  const valid = /^[a-z0-9][a-z0-9._/-]*$/i.test(cleanId)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const created = await api.createHome({
        address,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(identity.trim() ? { identity: identity.trim() } : {}),
      })
      await onCreated(created)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ba-modal-layer" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <form className="ba-form-card" onSubmit={(event) => { void submit(event) }}>
        <h3>{t('create.title')}</h3>
        <p className="ba-form-subtitle">{t('create.subtitle')}</p>
        <div className="ba-form-grid">
          <label className="ba-form-field">
            <span className="ba-field-label">{t('create.type')}</span>
            <select className="ba-select" value={type} onChange={(event) => { setType(event.target.value as typeof type) }}>
              {HOME_TYPES.map(value => <option value={value} key={value}>{t(`type.${value}` as 'type.personal')}</option>)}
            </select>
          </label>
          <label className="ba-form-field">
            <span className="ba-field-label">{t('create.id')}</span>
            <input className="ba-input" value={id} placeholder={t('create.idPlaceholder')} onChange={(event) => { setId(event.target.value) }} />
          </label>
          <label className="ba-form-field" data-wide="true">
            <span className="ba-field-label">{t('create.name')}</span>
            <input className="ba-input" value={displayName} placeholder={t('create.namePlaceholder')} onChange={(event) => { setDisplayName(event.target.value) }} />
          </label>
          <label className="ba-form-field" data-wide="true">
            <span className="ba-field-label">{t('create.identity')}</span>
            <textarea className="ba-textarea" value={identity} placeholder={t('create.identityPlaceholder')} onChange={(event) => { setIdentity(event.target.value) }} />
          </label>
        </div>
        <div className="ba-address-preview">{t('create.addressPreview', { address })}</div>
        {error !== undefined ? <p className="ba-inline-error" role="alert">{t('create.failed', { message: error })}</p> : null}
        <div className="ba-form-actions">
          <button type="button" className="ba-button" onClick={onCancel}>{t('create.cancel')}</button>
          <button type="submit" className="ba-button" data-variant="primary" disabled={!valid || busy}>
            {busy ? t('create.creating') : t('create.action')}
          </button>
        </div>
      </form>
    </div>
  )
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="ba-loading">
      <div className="ba-loading-core">
        <span className="ba-loading-strata" aria-hidden="true"><span /><span /><span /></span>
        <span>{label}</span>
      </div>
    </div>
  )
}

function FailureState({ message, retry, retryLabel }: { message: string; retry: () => void; retryLabel: string }) {
  return (
    <div className="ba-loading">
      <div className="ba-loading-core" role="alert">
        <IconWarningOutlineRegular size={22} />
        <span>{message}</span>
        <button type="button" className="ba-button" onClick={retry}>{retryLabel}</button>
      </div>
    </div>
  )
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="ba-empty">
      <div className="ba-empty-mark" aria-hidden="true" />
      <strong>{title}</strong>
      {hint ? <p>{hint}</p> : null}
    </div>
  )
}

function compactEvidence(ref: UiAsset['sourceRefs'][number]): string {
  if (ref.type === 'session-events') return `session:${ref.sessionId} · events ${String(ref.fromSeq)}–${String(ref.toSeq)}`
  if (ref.type === 'worklog') return `worklog:${ref.sessionId} · ${ref.revisionId}`
  if (ref.type === 'tool-result') return `tool:${ref.toolCallId} · session:${ref.sessionId} · event ${String(ref.eventSeq)}`
  if (ref.type === 'asset') return `${ref.ownerAddress}/${ref.assetId}@${String(ref.revision)}`
  if (ref.type === 'user-confirmation') return `confirmation:${ref.sessionId} · event ${String(ref.eventSeq)}`
  return `${ref.type}:${ref.uri} · ${ref.digest.slice(0, 12)}`
}

function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function teamTemplate(value: string, t: DashboardProps['t']): {
  members: MemberDraft[]
  capabilities: CapabilityDraft[]
} {
  const member = (id: string, roleId: string, nameKey: string, roleKey: string, responsibilityKey: string): MemberDraft => ({
    id,
    displayName: t(nameKey as 'setup.seed.productLead.name'),
    roleId,
    roleName: t(roleKey as 'setup.seed.productLead.role'),
    responsibility: t(responsibilityKey as 'setup.seed.productLead.responsibility'),
  })
  const capability = (id: string, nameKey: string, responsibilityKey: string): CapabilityDraft => ({
    id,
    displayName: t(nameKey as 'setup.seed.research.name'),
    responsibility: t(responsibilityKey as 'setup.seed.research.responsibility'),
  })
  if (value === 'growth') {
    return {
      members: [
        member('growth-lead', 'growth-lead', 'setup.seed.growthLead.name', 'setup.seed.growthLead.role', 'setup.seed.growthLead.responsibility'),
        member('content-strategist', 'content-strategist', 'setup.seed.content.name', 'setup.seed.content.role', 'setup.seed.content.responsibility'),
        member('data-analyst', 'data-analyst', 'setup.seed.analyst.name', 'setup.seed.analyst.role', 'setup.seed.analyst.responsibility'),
      ],
      capabilities: [
        capability('experiment-design', 'setup.seed.experiment.name', 'setup.seed.experiment.responsibility'),
        capability('customer-insight', 'setup.seed.customer.name', 'setup.seed.customer.responsibility'),
      ],
    }
  }
  if (value === 'compact') {
    return {
      members: [
        member('founder', 'business-lead', 'setup.seed.founder.name', 'setup.seed.founder.role', 'setup.seed.founder.responsibility'),
        member('coding-agent', 'engineering', 'setup.seed.engineer.name', 'setup.seed.engineer.role', 'setup.seed.engineer.responsibility'),
      ],
      capabilities: [capability('product-delivery', 'setup.seed.delivery.name', 'setup.seed.delivery.responsibility')],
    }
  }
  return {
    members: [
      member('product-lead', 'product-lead', 'setup.seed.productLead.name', 'setup.seed.productLead.role', 'setup.seed.productLead.responsibility'),
      member('coding-agent', 'engineering', 'setup.seed.engineer.name', 'setup.seed.engineer.role', 'setup.seed.engineer.responsibility'),
      member('research-analyst', 'research', 'setup.seed.researcher.name', 'setup.seed.researcher.role', 'setup.seed.researcher.responsibility'),
    ],
    capabilities: [
      capability('research', 'setup.seed.research.name', 'setup.seed.research.responsibility'),
      capability('product-delivery', 'setup.seed.delivery.name', 'setup.seed.delivery.responsibility'),
    ],
  }
}

function emptyMember(index: number, t: DashboardProps['t']): MemberDraft {
  return {
    id: `member-${String(index)}`,
    displayName: t('setup.newMember'),
    roleId: `role-${String(index)}`,
    roleName: t('setup.newRole'),
    responsibility: t('setup.newResponsibility'),
  }
}

function emptyCapability(index: number, t: DashboardProps['t']): CapabilityDraft {
  return {
    id: `capability-${String(index)}`,
    displayName: t('setup.newCapability'),
    responsibility: t('setup.newCapabilityResponsibility'),
  }
}

function mainViewSession<T extends { retainedBy: { mainView?: number } }>(
  byId: Readonly<Record<string, T>>,
): T | undefined {
  return Object.values(byId).find(session => (session.retainedBy.mainView ?? 0) > 0)
}

function currentDshWorkspace(
  workspaces: readonly WorkspaceView[],
  currentSessionId?: string,
  cwd?: string,
): WorkspaceView | undefined {
  if (currentSessionId !== undefined) {
    const owner = workspaces.find(workspace => workspace.sessionIds.some(value => String(value) === currentSessionId))
    if (owner !== undefined) return owner
  }
  if (cwd === undefined) return undefined
  return [...workspaces]
    .filter(workspace => pathContains(workspace.path, cwd))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

function workspaceName(path: string): string {
  const parts = normalizedClientPath(path).split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

function samePath(left?: string, right?: string): boolean {
  if (left === undefined || right === undefined) return false
  return normalizedClientPath(left) === normalizedClientPath(right)
}

function pathContains(root: string, target: string): boolean {
  const normalizedRoot = normalizedClientPath(root)
  const normalizedTarget = normalizedClientPath(target)
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
}

function normalizedClientPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/g, '')
  return /^[A-Z]:\//.test(normalized) ? normalized.toLocaleLowerCase() : normalized
}

function safeSlug(value: string): string {
  return value.trim().toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function safeId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
}

function initials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean)
  if (words.length > 1) return words.slice(0, 2).map(word => word[0]?.toLocaleUpperCase()).join('')
  return [...(words[0] ?? '?')].slice(0, 2).join('').toLocaleUpperCase()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
