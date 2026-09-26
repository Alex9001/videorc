import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { verifyMacosBundleIntegrity } from './release-macos-integrity.mjs'
test('macOS private staging binds DMG manifest/sidecar and ZIP feed hashes before acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'videorc-integrity-'))
  try {
    const dmg = Buffer.from('signed dmg fixture')
    const zip = Buffer.from('signed zip fixture')
    const sha256 = createHash('sha256').update(dmg).digest('hex')
    const sha512 = createHash('sha512').update(zip).digest('base64')
    const definitions = [
      ['dmg', 'Videorc.dmg', dmg],
      ['sha256', 'Videorc.dmg.sha256', `${sha256}  Videorc.dmg\n`],
      ['feed-zip', 'Videorc.zip', zip],
      ['feed-blockmap', 'Videorc.zip.blockmap', 'blockmap'],
      [
        'feed-manifest',
        'latest-mac.yml',
        `version: 1.2.3\npath: Videorc.zip\nsha512: ${sha512}\nfiles:\n  - url: Videorc.zip\n    sha512: ${sha512}\n    size: ${zip.length}\n`
      ]
    ]
    for (const [, name, body] of definitions) await writeFile(join(directory, name), body)
    const artifacts = definitions.map(([label, name]) => ({
      label,
      objectKey: `macos/${name}`,
      path: join(directory, name)
    }))
    const args = {
      releaseDir: directory,
      manifest: { filename: 'Videorc.dmg', sha256, sizeBytes: dmg.length, bundleVersion: '1.2.3' },
      artifacts
    }
    assert.equal((await verifyMacosBundleIntegrity(args)).status, 'PASS')
    await writeFile(join(directory, 'Videorc.zip'), 'stale same-version zip')
    await assert.rejects(verifyMacosBundleIntegrity(args), { code: 'macos-feed-integrity' })
    await writeFile(join(directory, 'Videorc.dmg'), 'stale same-version dmg')
    await assert.rejects(verifyMacosBundleIntegrity(args), { code: 'macos-manifest-integrity' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
