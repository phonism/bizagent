import { userInfo } from 'node:os'

const USER_ID = /^[a-zA-Z0-9._-]{1,100}$/

/** Whether a string can name a local human (Home owner or reviewer). */
export function isLocalUserId(value: string): boolean {
  return USER_ID.test(value)
}

/**
 * The person who owns Homes created by a local host: $BIZAGENT_LOCAL_HUMAN_ID when set,
 * otherwise the operating system user name reduced to the allowed characters.
 */
export function localOwnerId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['BIZAGENT_LOCAL_HUMAN_ID']?.trim()
  if (configured) {
    if (!isLocalUserId(configured)) throw new TypeError('BIZAGENT_LOCAL_HUMAN_ID must use 1-100 letters, numbers, dots, underscores, or hyphens')
    return configured
  }
  let name = ''
  try { name = userInfo().username } catch { /* Some containers have no passwd entry. */ }
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 100)
  return cleaned || 'local'
}
