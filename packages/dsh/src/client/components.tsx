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

  const load = async (preferred?: string, signal?: AbortSignal): Promise<void> => {
    const nextOverview = await api.overview(signal)
    const address = nextOverview.homes.some(home => home.address === preferred)
      ? preferred
      : nextOverview.homes[0]?.address
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
