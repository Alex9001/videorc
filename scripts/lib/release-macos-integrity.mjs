import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { requireRelease } from './release-github.mjs'
export async function hashFile(path, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest(encoding)
}
export async function verifyMacosBundleIntegrity({ releaseDir, manifest, artifacts }) {
  const dmg = artifacts.find((artifact) => artifact.label === 'dmg')
  requireRelease(
    dmg &&
      manifest.filename === dmg.objectKey.split('/').at(-1) &&
      (await hashFile(dmg.path)) === manifest.sha256 &&
      (await stat(dmg.path)).size === manifest.sizeBytes,
    'macos-manifest-integrity',
    'DMG bytes do not match the release manifest.'
  )
  const sidecar = artifacts.find((artifact) => artifact.label === 'sha256')
  requireRelease(
    sidecar &&
      (await readFile(sidecar.path, 'utf8')).trim() === `${manifest.sha256}  ${manifest.filename}`,
    'macos-sidecar',
    'DMG checksum sidecar does not match exact manifest.'
  )
  const feedArtifact = artifacts.find((artifact) => artifact.label === 'feed-manifest')
  const zip = artifacts.find((artifact) => artifact.label === 'feed-zip')
  const blockmap = artifacts.find((artifact) => artifact.label === 'feed-blockmap')
  requireRelease(
    feedArtifact && zip && blockmap && (await stat(blockmap.path)).size > 0,
    'macos-updater-files',
    'Updater feed, ZIP and blockmap are required.'
  )
  const feed = load(await readFile(feedArtifact.path, 'utf8'))
  const filename = zip.objectKey.split('/').at(-1)
  const file = feed.files?.find((entry) => entry.url === filename)
  const sha512 = await hashFile(zip.path, 'sha512', 'base64')
  requireRelease(
    feed.version === manifest.bundleVersion &&
      feed.path === filename &&
      feed.sha512 === sha512 &&
      file?.sha512 === sha512 &&
      file.size === (await stat(zip.path)).size,
    'macos-feed-integrity',
    'ZIP bytes do not match the exact updater feed.'
  )
  return {
    status: 'PASS',
    dmgSha256: manifest.sha256,
    zipSha512: sha512,
    blockmapSha256: await hashFile(blockmap.path)
  }
}
