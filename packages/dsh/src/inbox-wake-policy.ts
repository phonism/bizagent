import { z } from 'zod'
import { nextCronAt } from './cron.js'

export const InboxWakePolicySchema = z.object({
  policy: z.enum(['immediate', 'batch', 'scheduled', 'carried']),
  batchMinutes: z.number().int().min(1).max(44_640).optional(),
  cron: z.string().min(1).max(256).optional(),
})

export type InboxWakePolicy = z.infer<typeof InboxWakePolicySchema>
export const DEFAULT_INBOX_WAKE_POLICY: InboxWakePolicy = { policy: 'batch', batchMinutes: 15 }

/** Freeze the effective recipient schedule at delivery time. */
export function inboxWakeSchedule(policy: InboxWakePolicy, priority: 'normal' | 'urgent',
  sentAt: string, timeZone = 'UTC'): { wakePolicy: InboxWakePolicy['policy']; wakeAt?: string } {
  const at = Date.parse(sentAt)
  if (!Number.isSafeInteger(at)) throw new Error('invalid Inbox delivery time')
  if (priority === 'urgent' || policy.policy === 'immediate') {
    return { wakePolicy: 'immediate', wakeAt: new Date(at).toISOString() }
  }
  if (policy.policy === 'carried') return { wakePolicy: 'carried' }
  if (policy.policy === 'scheduled' && policy.cron) {
    try {
      return { wakePolicy: 'scheduled', wakeAt: new Date(nextCronAt(policy.cron, at, timeZone)).toISOString() }
    } catch { /* An invalid cron falls back to batch delivery. */ }
  }
  const minutes = policy.batchMinutes ?? 15
  return { wakePolicy: 'batch', wakeAt: new Date(at + minutes * 60_000).toISOString() }
}
