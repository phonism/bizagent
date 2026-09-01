import type {
  AgentHome,
  AssetKind,
  AssetStatus,
  EvidenceRef,
  FitnessSignal,
  HomeAddress,
  HomeType,
  MemoryProposal,
} from './domain.js'

export const BIZAGENT_UI_API = '/api/bizagent/v1'

export type LearningKind = Exclude<AssetKind, 'identity'>

export interface UiAssetCounts {
  memory: number
  insight: number
  knowledge: number
  method: number
}

export interface UiHomeSummary {
  address: HomeAddress
  type: HomeType
  displayName: string
  revision: number
  status: AgentHome['status']
  updatedAt: string
  assetCount: number
  activeAssetCount: number
  counts: UiAssetCounts
  incomingPending: number
  outgoingPending: number
  episodes: number
}

export interface UiAsset {
  id: string
  ownerAddress: HomeAddress
  kind: LearningKind
  title?: string
  description: string
  body: string
  tags: string[]
  sourceRefs: EvidenceRef[]
  confidence: number
  fitness: number
  status: AssetStatus
  revision: number
  proposalId?: string
  createdAt: string
  updatedAt: string
  receiptCount: number
  lastSignal?: FitnessSignal
}

export interface UiHomeDetail {
  home: AgentHome
  identity: string
  assets: UiAsset[]
  proposals: MemoryProposal[]
  episodes: number
}

export interface UiOverview {
  generatedAt: string
  homeRoot: string
  homes: UiHomeSummary[]
  proposals: MemoryProposal[]
  totals: {
    homes: number
    assets: number
    activeAssets: number
    pendingProposals: number
    episodes: number
  }
  health: {
    ok: boolean
    issues: string[]
  }
}

export interface UiCreateHomeRequest {
  address: string
  displayName?: string
  owner?: string
  identity?: string
}

export interface UiProposalDecisionRequest {
  ownerAddress: string
  proposalId: string
  action: 'accept' | 'reject'
  decision: string
  kind?: LearningKind
}

export interface UiApiError {
  error: {
    code: string
    message: string
  }
}
