import {
  BIZAGENT_UI_API,
  type UiApiError,
  type UiCreateHomeRequest,
  type UiHomeDetail,
  type UiOverview,
  type UiProposalDecisionRequest,
} from '../ui-contract.js'

export interface BizAgentUiPort {
  overview(signal?: AbortSignal): Promise<UiOverview>
  home(address: string, signal?: AbortSignal): Promise<UiHomeDetail>
  createHome(request: UiCreateHomeRequest, signal?: AbortSignal): Promise<UiHomeDetail>
  decideProposal(request: UiProposalDecisionRequest, signal?: AbortSignal): Promise<UiHomeDetail>
}

export class BizAgentUiHttpPort implements BizAgentUiPort {
  overview(signal?: AbortSignal): Promise<UiOverview> {
    return request(`${BIZAGENT_UI_API}/overview`, signal === undefined ? {} : { signal })
  }

  home(address: string, signal?: AbortSignal): Promise<UiHomeDetail> {
    return request(`${BIZAGENT_UI_API}/home?address=${encodeURIComponent(address)}`, signal === undefined ? {} : { signal })
  }

  createHome(input: UiCreateHomeRequest, signal?: AbortSignal): Promise<UiHomeDetail> {
    return request(`${BIZAGENT_UI_API}/homes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  decideProposal(input: UiProposalDecisionRequest, signal?: AbortSignal): Promise<UiHomeDetail> {
    return request(`${BIZAGENT_UI_API}/proposals/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    })
  }
}

async function request<T>(input: string, init: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    cache: 'no-store',
    credentials: 'same-origin',
  })
  const value = await response.json() as T | UiApiError
  if (!response.ok) {
    const failure = value as UiApiError
    throw new Error(failure.error?.message || `BizAgent UI request failed (${String(response.status)})`)
  }
  return value as T
}
