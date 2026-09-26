import { verifyMacosBundleIntegrity } from './lib/release-macos-integrity.mjs'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createReleaseControlStore, controlStoreConfig } from './lib/release-control-store.mjs'
import { requireRelease, createReleaseGithub } from './lib/release-github.mjs'
import { buildReleaseUploadPlan } from './lib/release-upload-s3.mjs'
import { sha256File } from './lib/beta-release-manifest.mjs'
import { parseChangelogEntry } from './lib/changelog.mjs'
import { stagePrivateBundle } from './lib/release-staging.mjs'
import { workerOperation } from './lib/release-control-client.mjs'
import { RELEASE_POLICY_VERSION } from './lib/release-state.mjs'

async function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const requestId = process.env.RELEASE_REQUEST_ID
  const configured = controlStoreConfig()
  const store = createReleaseControlStore(configured)
  try {
    const state = (await store.read('state.json')).value
    const request = state.requests[requestId]
    requireRelease(
      request && state.active.macos === requestId,
      'macos-request',
      'Select an active macOS request.'
    )
    requireRelease(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() ===
        request.identity.sourceSha,
      'macos-source',
      'Local signed build must come from the frozen source checkout.'
    )
    requireRelease(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: root,
        encoding: 'utf8'
      }).trim() === '',
      'macos-dirty',
      'Signed candidate checkout has tracked changes.'
    )
    execFileSync(process.execPath, [join(root, 'scripts/validate-macos-release-artifact.mjs')], {
      cwd: root,
      stdio: 'inherit',
      env: process.env
    })
    const releaseDir = resolve(
      process.env.VIDEORC_RELEASE_DIR ?? join(root, 'apps/desktop/release')
    )
    const manifestPath = join(releaseDir, 'release.json')
    const manifestBytes = await readFile(manifestPath)
    const manifest = JSON.parse(manifestBytes)
    requireRelease(
      manifest.releaseId === request.identity.releaseIds.macos,
      'macos-release',
      'Signed artifact version differs from frozen request.'
    )
    const manifestHash = createHash('sha256').update(manifestBytes).digest('hex')
    const acceptance = JSON.parse(
      await readFile(process.env.VIDEORC_MACOS_ACCEPTANCE_RECEIPT, 'utf8')
    )
    requireRelease(
      acceptance.status === 'PASS' &&
        acceptance.manifestHash === manifestHash &&
        acceptance.sourceSha === request.identity.sourceSha &&
        acceptance.releaseId === manifest.releaseId &&
        acceptance.physicalGates === 'PASS' &&
        acceptance.previousVersionUpdate === 'PASS',
      'macos-acceptance',
      'Exact signed macOS candidate needs real physical and previous-version update evidence.'
    )
    const canonicalEntry = parseChangelogEntry(
      await readFile(join(root, 'changelog', `${manifest.releaseId}.md`), 'utf8'),
      { filename: `${manifest.releaseId}.md` }
    )
    const plan = await buildReleaseUploadPlan({ manifest, manifestPath, releaseDir })
    await verifyMacosBundleIntegrity({ releaseDir, manifest, artifacts: plan.artifacts })
    const buildReceipt = (await store.read(`local-builds/${requestId}/macos-complete.json`))?.value
    requireRelease(
      buildReceipt?.sourceSha === request.identity.sourceSha &&
        buildReceipt.manifestHash === manifestHash &&
        buildReceipt.integrity?.status === 'PASS',
      'macos-build-receipt',
      'Signed bundle lacks the maintained frozen-source build receipt. Use release:build:macos.'
    )
    const artifacts = await Promise.all(
      plan.artifacts.map(async (artifact) => ({
        ...artifact,
        immutable: !['latest-manifest', 'feed-manifest', 'changelog'].includes(artifact.label),
        sha256: await sha256File(artifact.path)
      }))
    )
    for (const artifact of artifacts)
      requireRelease(
        buildReceipt.artifacts.some(
          (entry) => entry.objectKey === artifact.objectKey && entry.sha256 === artifact.sha256
        ),
        'macos-build-bytes',
        'Signed bundle changed after its build receipt.'
      )
    await stagePrivateBundle({
      ...configured,
      config: configured.dataConfig,
      store,
      identity: request.identity,
      platform: 'macos',
      artifacts,
      canonicalEntry,
      acceptance,
      manifestHash
    })
    await store.write(`evidence/${requestId}/macos/candidate.json`, {
      policyVersion: RELEASE_POLICY_VERSION,
      requestId,
      sourceSha: request.identity.sourceSha,
      platform: 'macos',
      releaseId: manifest.releaseId,
      manifestHash,
      artifacts: artifacts.map(
        ({ label, objectKey, sha256, sizeBytes, contentType, immutable }) => ({
          label,
          objectKey,
          sha256,
          sizeBytes,
          contentType,
          immutable
        })
      )
    })
    const github = createReleaseGithub()
    await workerOperation(store, github, { type: 'staged', requestId, platform: 'macos' })
    await workerOperation(store, github, { type: 'acceptance', requestId, platform: 'macos' })
    execFileSync(
      process.execPath,
      [join(root, 'scripts/release.mjs'), 'resume', '--request', requestId, '--once'],
      { cwd: root, stdio: 'inherit', env: process.env }
    )
  } finally {
    store.close()
  }
}
main().catch((error) => {
  console.error(`stage-macos: ${error.code ?? 'error'}: ${error.message}`)
  process.exitCode = 1
})
