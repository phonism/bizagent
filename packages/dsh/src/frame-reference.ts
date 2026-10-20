/** A selected composer reference; only user-authored, admitted messages are resolved. */
export function frameReference(address: string): string {
  return `[BIZAGENT_FRAME_REQUEST:${address}]`
}

export function selectedFrameAddresses(text: string): string[] {
  return [...new Set([...text.matchAll(/^\[BIZAGENT_FRAME_REQUEST:((?:business|role|capability):[a-z0-9][a-z0-9._/-]*)\]/gm)]
    .map(match => match[1]!))].slice(0, 8)
}

export function removeFrameReferences(text: string): string {
  return text.replace(/\n?^\[BIZAGENT_FRAME_REQUEST:(?:business|role|capability):[a-z0-9][a-z0-9._/-]*\]/gm, '')
}
