import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function makeTempDir(prefix) {
  const canonicalTempDir = await realpath(tmpdir())
  return mkdtemp(join(canonicalTempDir, prefix))
}
