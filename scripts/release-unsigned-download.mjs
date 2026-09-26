#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { requireRelease, RELEASE_REPOSITORY } from './lib/release-github.mjs'

async function main() {
  const artifactId = process.env.EXPECTED_ARTIFACT_ID
  const digest = process.env.EXPECTED_ARTIFACT_DIGEST
  requireRelease(
    /^[1-9][0-9]*$/.test(artifactId) && /^[a-f0-9]{64}$/.test(digest),
    'handoff-identity',
    'Exact unsigned artifact ID and digest are required.'
  )
  const destination = resolve('apps/desktop/release')
  await mkdir(destination, { recursive: true })
  const archive = join(process.env.RUNNER_TEMP, `unsigned-${artifactId}.zip`)
  try {
    const response = await fetch(
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/actions/artifacts/${artifactId}/zip`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json'
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000)
      }
    )
    const location = response.headers.get('location')
    requireRelease(
      response.status === 302 && location && new URL(location).protocol === 'https:',
      'handoff-download',
      'GitHub did not issue a valid artifact download.'
    )
    const bytes = await fetch(location, { signal: AbortSignal.timeout(600_000) })
    requireRelease(
      bytes.ok && bytes.body,
      'handoff-download',
      'Unsigned artifact could not be downloaded.'
    )
    const hash = createHash('sha256')
    const output = createWriteStream(archive, { flags: 'wx' })
    let size = 0
    try {
      for await (const chunk of bytes.body) {
        size += chunk.byteLength
        requireRelease(
          size <= 4 * 1024 ** 3,
          'handoff-size',
          'Unsigned artifact exceeds maximum size.'
        )
        hash.update(chunk)
        if (!output.write(chunk)) await once(output, 'drain')
      }
      output.end()
      await once(output, 'finish')
    } catch (error) {
      output.destroy()
      throw error
    }
    requireRelease(
      hash.digest('hex') === digest,
      'handoff-digest',
      'Unsigned artifact archive SHA-256 differs from the verified GitHub producer.'
    )
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($env:VIDEORC_HANDOFF_ZIP)
try {
  foreach ($entry in $zip.Entries) {
    $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($env:VIDEORC_HANDOFF_DEST, $entry.FullName))
    if (-not $target.StartsWith($env:VIDEORC_HANDOFF_DEST + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe artifact archive path.' }
  }
} finally { $zip.Dispose() }
[System.IO.Compression.ZipFile]::ExtractToDirectory($env:VIDEORC_HANDOFF_ZIP, $env:VIDEORC_HANDOFF_DEST, $true)`
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, VIDEORC_HANDOFF_ZIP: archive, VIDEORC_HANDOFF_DEST: destination },
      stdio: 'inherit'
    })
    requireRelease(
      result.status === 0,
      'handoff-extract',
      'Verified unsigned artifact extraction failed.'
    )
  } finally {
    await rm(archive, { force: true })
  }
}
main().catch((error) => {
  console.error(`unsigned-download: ${error.code ?? 'error'}: ${error.message}`)
  process.exitCode = 1
})
