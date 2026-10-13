import type { CreateOrganizationInput } from './home-store.js'
import { BIZAGENT_SAMPLE_ORGANIZATION_ID } from './ui-contract.js'

/** A small growth team with real data to work on, so every BizAgent loop can be tried in minutes. */
export const SAMPLE_ORGANIZATION: Omit<CreateOrganizationInput, 'owner'> = {
  id: BIZAGENT_SAMPLE_ORGANIZATION_ID,
  name: 'Sample Shop',
  mission: 'grow repeat purchases with numbers everyone on the team can trust.',
  members: [
    {
      id: 'growth-lead',
      displayName: 'Growth lead',
      roleId: 'growth',
      roleName: 'Growth',
      responsibility: 'Decide where the team spends its effort, run Projects, and sign off on results.',
    },
    {
      id: 'data-analyst',
      displayName: 'Data analyst',
      roleId: 'analytics',
      roleName: 'Analytics',
      responsibility: 'Own metric definitions and compute numbers from the shop data in your workspace.',
    },
  ],
  capabilities: [{
    id: 'metrics',
    displayName: 'Metric definitions',
    responsibility: 'Keep the agreed definitions of GMV, retention, and other shared metrics.',
  }],
}

/** Files placed in sample Home directories. Existing files are never overwritten. */
export const SAMPLE_FILES: ReadonlyArray<{ home: string; path: string; content: string }> = [
  {
    home: 'personal:data-analyst',
    path: 'orders.csv',
    content: [
      'order_id,status,amount',
      'A1,paid,120.50',
      'A2,cancelled,80.00',
      'A3,paid,45.25',
      'A4,refunded,60.00',
      'A5,paid,200.00',
      'A6,shipped,34.75',
      '',
    ].join('\n'),
  },
]
