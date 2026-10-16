/**
 * The name to show for a Home. BizAgent creates the person's default Home with its address as its
 * name; a personal Home nobody has named is the person's own and shows as such.
 */
export function homeName(home: { address: string; displayName: string; scope?: 'personal' | 'organization' | undefined },
  t: (key: 'session.personal') => string): string {
  return home.scope === 'personal' && home.displayName === home.address ? t('session.personal') : home.displayName
}
