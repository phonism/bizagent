/** Refuse files written by a newer BizAgent with a message that says so, instead of a schema error. */
export function assertKnownFormat(raw: unknown, latest: number, file: string): void {
  const version = raw !== null && typeof raw === 'object' ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined
  if (typeof version === 'number' && version > latest) {
    throw new Error(`${file} uses format ${version}, written by a newer BizAgent; upgrade BizAgent to read it`)
  }
}
