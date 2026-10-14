import { parseHomeAddress, type AgentHome, type AssetStatus, type ContextBudget, type HomeAddress,
  type Organization, type StoredAsset } from './domain.js'
import type { InboxWakePolicy } from './inbox-wake-policy.js'
import type { AssetSearchInput, CreateAssetInput, CreateHomeInput, DoctorReport, HomeStore,
  UpdateAssetInput } from './home-store.js'

/**
 * Every Home this host can see: the person's own Homes in the data root (the personal space), and
 * the active organization's Homes under `<data root>/orgs/<id>`. Each Home stays in the folder of
 * the store that holds it. When both hold the same address, the organization's Home wins and the
 * personal one is reported by `doctor`.
 */
export class HomeSpace {
  constructor(readonly personal: HomeStore, readonly organizationStore?: HomeStore) {}

  /** Where organization-wide records live: the organization root, or the personal space without one. */
  get root(): string { return (this.organizationStore ?? this.personal).root }

  get personalRoot(): string { return this.personal.root }

  get organizationRoot(): string | undefined { return this.organizationStore?.root }

  async initialize(): Promise<void> {
    await this.personal.initialize()
    await this.organizationStore?.initialize()
  }

  async reload(): Promise<void> {
    await this.personal.reload()
    await this.organizationStore?.reload()
  }

  /** The same personal space with another organization (or none) beside it. */
  withOrganization(organizationStore: HomeStore | undefined): HomeSpace {
    return new HomeSpace(this.personal, organizationStore)
  }

  /** The root of the store that holds this Home; its snapshots and records belong there. */
  rootFor(address: string): string { return this.storeFor(address).root }

  /** A Home from the personal space, outside any organization. */
  isPersonalHome(address: string): boolean {
    return this.findStore(address) === this.personal
  }

  listHomes(): AgentHome[] {
    const organizationHomes = this.organizationStore?.listHomes() ?? []
    const shadowed = new Set(organizationHomes.map(home => home.address))
    return [...organizationHomes, ...this.personal.listHomes().filter(home => !shadowed.has(home.address))]
      .sort((a, b) => a.address.localeCompare(b.address))
  }

  hasHome(address: string): boolean { return this.findStore(address) !== undefined }

  getHome(address: string): AgentHome { return this.storeFor(address).getHome(address) }

  findHome(address: string): AgentHome | undefined { return this.findStore(address)?.findHome(address) }

  homeWorkspacePath(address: string): string { return this.storeFor(address).homeWorkspacePath(address) }

  readInboxWakePolicy(address: string): Promise<InboxWakePolicy> {
    return this.storeFor(address).readInboxWakePolicy(address)
  }

  getIdentity(address: string): string { return this.storeFor(address).getIdentity(address) }

  /** The active organization; before organizations had their own folder it could sit in the data root itself. */
  getOrganization(): Organization | undefined {
    return (this.organizationStore ?? this.personal).getOrganization()
  }

  /** New Homes join the active organization unless the personal space is asked for. */
  async createHome(input: CreateHomeInput, target: 'organization' | 'personal' = 'organization'): Promise<AgentHome> {
    const store = target === 'personal' ? this.personal : this.organizationStore ?? this.personal
    const other = store === this.personal ? this.organizationStore : this.personal
    if (other?.hasHome(input.address)) {
      throw new Error(`Agent Home already exists outside this ${target === 'personal' ? 'personal space' : 'organization'}: ${input.address}`)
    }
    return store.createHome(input)
  }

  listAssets(address: string, status?: AssetStatus): StoredAsset[] {
    return this.storeFor(address).listAssets(address, status)
  }

  searchAssets(address: string, input: AssetSearchInput = {}): StoredAsset[] {
    return this.storeFor(address).searchAssets(address, input)
  }

  readAsset(address: string, id: string): StoredAsset { return this.storeFor(address).readAsset(address, id) }

  findAssetByProposalId(address: string, proposalId: string): StoredAsset | undefined {
    return this.storeFor(address).findAssetByProposalId(address, proposalId)
  }

  createAsset(input: CreateAssetInput): Promise<StoredAsset> {
    return this.storeFor(input.ownerAddress).createAsset(input)
  }

  updateAsset(address: string, id: string, input: UpdateAssetInput): Promise<StoredAsset> {
    return this.storeFor(address).updateAsset(address, id, input)
  }

  contextFor(address: string, budget: ContextBudget, episodeCount = 0): string {
    return this.storeFor(address).contextFor(address, budget, episodeCount)
  }

  contextForFrame(address: string, budget: ContextBudget): string {
    return this.storeFor(address).contextForFrame(address, budget)
  }

  async doctor(): Promise<DoctorReport> {
    const personal = await this.personal.doctor()
    if (this.organizationStore === undefined) return personal
    const organization = await this.organizationStore.doctor()
    const shadowed = this.personal.listHomes()
      .filter(home => this.organizationStore!.hasHome(home.address))
      .map(home => `personal Home ${home.address} is hidden by the organization Home with the same address`)
    const issues = [...organization.issues, ...personal.issues.map(issue => `personal space: ${issue}`), ...shadowed]
    return {
      ok: issues.length === 0,
      root: organization.root,
      homeCount: this.listHomes().length,
      assetCount: organization.assetCount + personal.assetCount,
      issues,
    }
  }

  private findStore(address: string): HomeStore | undefined {
    let parsed: HomeAddress
    try { parsed = parseHomeAddress(address) } catch { return undefined }
    if (this.organizationStore?.hasHome(parsed)) return this.organizationStore
    return this.personal.hasHome(parsed) ? this.personal : undefined
  }

  /** Throws the store's own unknown-Home error when no store holds the address. */
  private storeFor(address: string): HomeStore {
    return this.findStore(address) ?? this.organizationStore ?? this.personal
  }
}
