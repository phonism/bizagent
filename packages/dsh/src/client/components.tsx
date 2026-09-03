import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react'
import {
  IconCheckOutline16,
  IconCloseOutline16,
  IconDataOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconWarningOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  LearningKind,
  UiAsset,
  UiCreateOrganizationRequest,
  UiHomeDetail,
  UiHomeSummary,
  UiOverview,
} from '../ui-contract.js'
import type { BizAgentUiPort } from './api.js'
import type { BizAgentUiController } from './controller.js'

export interface BizAgentUiFace {
  controller: BizAgentUiController
  api: BizAgentUiPort
}

type LauncherProps = PropsRuntime<'sidebar.footer.action'>
  & InjectFace<BizAgentUiFace>
  & PropsLocale<'bizagent'>

type DashboardProps = PropsRuntime<'shell.overlay'>
  & InjectFace<BizAgentUiFace>
  & PropsLocale<'bizagent'>

const KINDS: LearningKind[] = ['memory', 'insight', 'knowledge', 'method']
const STATUSES = ['active', 'candidate', 'superseded', 'retired'] as const
const HOME_TYPES = ['personal', 'business', 'role', 'capability'] as const
type DashboardView = 'organization' | 'learning'

export function BizAgentLauncher({ wide, controller, t }: LauncherProps) {
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot).open
  return (
    <Tooltip label={t('launcher.aria')} delayMs={500} disabled={wide}>
      <button
        type="button"
        className="ba-launcher"
        data-rail={wide ? 'false' : 'true'}
        aria-label={t('launcher.aria')}
        aria-pressed={open}
        onClick={() => { controller.toggle() }}
      >
        <IconDataOutline16 size={wide ? 16 : 18} />
        {wide ? <span>{t('launcher.label')}</span> : null}
      </button>
    </Tooltip>
  )
}

export function BizAgentDashboard({ controller, api, t }: DashboardProps) {
  const open = useSyncExternalStore(controller.subscribe, controller.getSnapshot).open
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
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (createOpen) setCreateOpen(false)
        else controller.close()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [controller, createOpen, open])

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
          <span className="ba-brand-sigil" aria-hidden="true" />
          <div className="ba-title-wrap">
            <p className="ba-eyebrow">{t('dashboard.eyebrow')}</p>
            <h2 className="ba-title" id="ba-dashboard-title">{t('dashboard.title')}</h2>
            <p className="ba-subtitle">{t('dashboard.subtitle')}</p>
          </div>
          {overview?.organization !== undefined ? (
            <nav className="ba-view-tabs" aria-label={t('nav.aria')}>
              <button type="button" data-active={view === 'organization' ? 'true' : 'false'} onClick={() => { setView('organization') }}>
                {t('nav.organization')}
              </button>
              <button type="button" data-active={view === 'learning' ? 'true' : 'false'} onClick={() => { setView('learning') }}>
                {t('nav.learning')}
              </button>
            </nav>
          ) : null}
          <div className="ba-top-actions">
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
                <IconRefreshOutline16 size={16} />
              </button>
            </Tooltip>
            <Tooltip label={t('dashboard.close')} delayMs={400}>
              <button
                type="button"
                className="ba-icon-button"
                aria-label={t('dashboard.close')}
                onClick={() => { controller.close() }}
              >
                <IconCloseOutline16 size={16} />
              </button>
            </Tooltip>
          </div>
        </header>

        {loading ? <LoadingState label={t('dashboard.loading')} /> : error !== undefined && overview === undefined ? (
          <FailureState message={t('dashboard.failed', { message: error })} retry={() => { void refresh() }} retryLabel={t('dashboard.retry')} />
        ) : overview !== undefined && overview.organization === undefined ? (
          <OrganizationSetup api={api} onCreated={onOrganizationCreated} t={t} />
        ) : view === 'organization' && overview?.organization !== undefined ? (
          <OrganizationOverview
            overview={overview}
            onOpenHome={(address) => {
              void selectHome(address).then(() => { setView('learning') })
            }}
            onOpenLearning={() => { setView('learning') }}
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
                  detail={detail}
                  selectedAsset={selectedAsset}
                  onSelectAsset={(id) => { setSelectedAsset(current => current === id ? undefined : id) }}
                  t={t}
                />
              )}
            </main>
            <ProposalInbox
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

function OrganizationSetup({ api, onCreated, t }: {
  api: BizAgentUiPort
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

  const submit = async (): Promise<void> => {
    if (!validBasics || !validMembers || !validCapabilities || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onCreated(await api.createOrganization({
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
      }))
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
          {[t('setup.step.identity'), t('setup.step.team'), t('setup.step.capabilities')].map((label, index) => (
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
        else if (step === 2) void submit()
      }}>
        {step === 0 ? (
          <div className="ba-setup-stage">
            <p className="ba-stage-number">01 / 03</p>
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
            <p className="ba-stage-number">02 / 03</p>
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
              <IconPlusOutline16 size={14} /> {t('setup.member.add')}
            </button>
          </div>
        ) : (
          <div className="ba-setup-stage">
            <p className="ba-stage-number">03 / 03</p>
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
              <IconPlusOutline16 size={14} /> {t('setup.capability.add')}
            </button>
            <div className="ba-setup-summary">
              <span className="ba-home-type-dot" data-type="business" />
              <strong>{name}</strong>
              <span>{t('setup.summary', { members: members.length, capabilities: capabilities.length, homes: 1 + members.length * 2 + capabilities.length })}</span>
            </div>
            {error !== undefined ? <p className="ba-inline-error" role="alert">{t('setup.failed', { message: error })}</p> : null}
          </div>
        )}
        <footer className="ba-setup-actions">
          {step > 0 ? <button type="button" className="ba-button" onClick={() => { setStep(current => current - 1) }}>{t('setup.back')}</button> : <span />}
          {step < 2 ? (
            <button type="submit" className="ba-button" data-variant="primary" disabled={step === 0 ? !validBasics : !validMembers}>
              {t('setup.continue')}
            </button>
          ) : (
            <button type="submit" className="ba-button" data-variant="primary" disabled={!validCapabilities || busy}>
              {busy ? t('setup.creating') : t('setup.create')}
            </button>
          )}
        </footer>
      </form>
    </main>
  )
}

function OrganizationOverview({ overview, onOpenHome, onOpenLearning, t }: {
  overview: UiOverview
  onOpenHome: (address: string) => void
  onOpenLearning: () => void
  t: DashboardProps['t']
}) {
  const organization = overview.organization
  if (organization === undefined) return null
  const homeByAddress = new Map(overview.homes.map(home => [home.address, home]))
  const business = homeByAddress.get(organization.businessHome)
  const assigned = new Set([
    organization.businessHome,
    ...organization.members.flatMap(member => [member.personalHome, member.roleHome]),
    ...organization.capabilityHomes,
  ])
  const unassigned = overview.homes.filter(home => !assigned.has(home.address))

  return (
    <main className="ba-org-shell">
      <header className="ba-org-hero">
        <div>
          <p className="ba-org-kicker">{t('organization.kicker')}</p>
          <h3>{organization.name}</h3>
          <p>{organization.mission}</p>
          <div className="ba-org-metrics">
            <span><strong>{organization.members.length}</strong>{t('organization.members')}</span>
            <span><strong>{organization.capabilityHomes.length}</strong>{t('organization.capabilities')}</span>
            <span><strong>{overview.totals.activeAssets}</strong>{t('organization.learning')}</span>
          </div>
        </div>
        <button type="button" className="ba-button" data-variant="primary" onClick={onOpenLearning}>{t('organization.openLearning')}</button>
      </header>

      <section className="ba-org-map" aria-label={t('organization.map')}>
        <div className="ba-business-node">
          <span className="ba-node-marker" data-type="business" />
          <div><small>{t('type.business')}</small><strong>{business?.displayName ?? organization.name}</strong><code>{organization.businessHome}</code></div>
        </div>
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
      {unassigned.length > 0 ? <p className="ba-unassigned">{t('organization.unassigned', { count: unassigned.length })}</p> : null}
    </main>
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
        <IconPlusOutline16 size={14} />
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

function HomeWorkspace({ detail, selectedAsset, onSelectAsset, t }: {
  detail: UiHomeDetail
  selectedAsset: string | undefined
  onSelectAsset: (id: string) => void
  t: DashboardProps['t']
}) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | LearningKind>('all')
  const [status, setStatus] = useState<'all' | UiAsset['status']>('all')
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

      <MemoryStrata detail={detail} t={t} />

      <section className="ba-ledger">
        <div className="ba-ledger-head">
          <div className="ba-ledger-title">
            <h3>{t('assets.title')}</h3>
            <span className="ba-ledger-count">{t('assets.count', { count: filtered.length })}</span>
          </div>
          <div className="ba-filters">
            <label className="ba-search-wrap">
              <span className="ba-search-icon"><IconSearchOutline16 size={14} /></span>
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
                asset={asset}
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

function AssetRow({ asset, open, onToggle, t }: {
  asset: UiAsset
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
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          <p className="ba-detail-copy">{asset.body}</p>
          <div className="ba-evidence">
            <h4>{t('asset.evidenceTitle')} · {t('asset.evidence', { count: asset.sourceRefs.length })} · {t('asset.receipts', { count: asset.receiptCount })}</h4>
            {asset.sourceRefs.map((ref, index) => <code key={`${ref.type}-${String(index)}`}>{compactEvidence(ref)}</code>)}
          </div>
        </div>
      ) : null}
    </li>
  )
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
    </aside>
  )
}

function ProposalDecision({ proposal, ownerAddress, api, onDecision, t }: {
  proposal: UiHomeDetail['proposals'][number]
  ownerAddress: string
  api: BizAgentUiPort
  onDecision: (detail: UiHomeDetail) => Promise<void>
  t: DashboardProps['t']
}) {
  const [kind, setKind] = useState<LearningKind>(proposal.proposedKind === 'identity' ? 'memory' : proposal.proposedKind)
  const [decision, setDecision] = useState('')
  const [busy, setBusy] = useState<'accept' | 'reject'>()
  const [error, setError] = useState<string>()

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
        ...(action === 'accept' ? { kind } : {}),
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
      <label>
        <span className="ba-field-label">{t('proposal.kind')}</span>
        <select className="ba-select" value={kind} onChange={(event) => { setKind(event.target.value as LearningKind) }}>
          {KINDS.map(value => <option value={value} key={value}>{t(`kind.${value}` as 'kind.memory')}</option>)}
        </select>
      </label>
      <label>
        <span className="ba-field-label">{t('proposal.decision')}</span>
        <textarea
          className="ba-textarea"
          value={decision}
          placeholder={t('proposal.decisionPlaceholder')}
          onChange={(event) => { setDecision(event.target.value) }}
        />
      </label>
      {error !== undefined ? <p className="ba-inline-error" role="alert">{t('proposal.failed', { message: error })}</p> : null}
      <div className="ba-proposal-actions">
        <button type="button" className="ba-button" data-variant="danger" disabled={!decision.trim() || busy !== undefined} onClick={() => { void decide('reject') }}>
          <IconWarningOutline16 size={14} /> {t('proposal.reject')}
        </button>
        <button type="button" className="ba-button" data-variant="primary" disabled={!decision.trim() || busy !== undefined} onClick={() => { void decide('accept') }}>
          <IconCheckOutline16 size={14} /> {t('proposal.accept')}
        </button>
      </div>
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
        <IconWarningOutline16 size={22} />
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
