import { workerOperation } from './lib/release-control-client.mjs'
// Trusted workflow worker. Source bytes are always selected by the registry;
// workflow inputs are comparisons, never authority.
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createReleaseControlStore,
  controlStoreConfig,
  submitReleaseIntent,
  waitControlResult
} from './lib/release-control-store.mjs'
import { createReleaseGithub, requireRelease, RELEASE_REPOSITORY } from './lib/release-github.mjs'
import { verifyUnsignedProducer } from './lib/release-controller.mjs'
import { requestIsEligible, RELEASE_POLICY_VERSION } from './lib/release-state.mjs'
import { buildWindowsCandidateStoragePlan } from './lib/windows-release-candidate.mjs'

const github = createReleaseGithub()
const store = createReleaseControlStore(controlStoreConfig())
const requestId = process.env.RELEASE_REQUEST_ID
const platform = process.env.RELEASE_PLATFORM ?? 'windows'
const command = process.argv[2]
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

async function main() {
  requireRelease(
    process.env.GITHUB_REF === 'refs/heads/main',
    'worker-ref',
    'Release workers must run from protected main.'
  )
  const state = (await store.read('state.json'))?.value
  const request = state?.requests[requestId]
  requireRelease(
    request && requestIsEligible(state, requestId, platform),
    'worker-request',
    'Request is missing or superseded.'
  )
  const identity = request.identity
  if (process.env.RELEASE_REQUIRE_ACCEPTANCE === 'true')
    requireRelease(
      request.platforms[platform].acceptance && request.platforms[platform].candidate,
      'worker-acceptance',
      'Public promotion requires validated exact-candidate acceptance.'
    )
  requireRelease(
    !process.env.EXPECTED_SOURCE_COMMIT ||
      process.env.EXPECTED_SOURCE_COMMIT === identity.sourceSha,
    'worker-source',
    'Dispatch source differs from activated source.'
  )
  requireRelease(
    !process.env.VIDEORC_RELEASE_ID ||
      process.env.VIDEORC_RELEASE_ID === identity.releaseIds[platform],
    'worker-release',
    'Dispatch release ID differs from activated identity.'
  )
  execFileSync('git', ['fetch', '--no-tags', 'origin', 'main'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['merge-base', '--is-ancestor', identity.sourceSha, 'origin/main'], {
    cwd: root,
    stdio: 'pipe'
  })
  execFileSync('git', ['merge-base', '--is-ancestor', identity.toolingSha, 'origin/main'], {
    cwd: root,
    stdio: 'pipe'
  })
  if (command === 'verify' || command === 'unsigned') {
    const output = {
      source_sha: identity.sourceSha,
      tooling_sha: identity.toolingSha,
      release_id: identity.releaseIds[platform]
    }
    if (command === 'unsigned') {
      const unsigned = await verifyUnsignedProducer({ github, request })
      Object.assign(output, {
        artifact_id: unsigned.artifactId,
        artifact_digest: unsigned.artifactDigest,
        producer_run_id: unsigned.runId,
        producer_attempt: unsigned.attempt
      })
    }
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        Object.entries(output)
          .map(([key, value]) => `${key}=${value}\n`)
          .join('')
      )
    console.log(JSON.stringify(output))
    return
  }
  if (command === 'sign-start') {
    // Watcher must first register this exact run. Wait read-only for its durable
    // receipt rather than claiming caller-supplied run IDs as authority.
    const runId = Number(process.env.GITHUB_RUN_ID)
    const deadline = Date.now() + 120_000
    let registered = request.platforms.windows.dispatches.sign?.runId === runId
    while (!registered && Date.now() < deadline) {
      await delay(3000)
      registered =
        (await store.read('state.json')).value.requests[requestId].platforms.windows.dispatches.sign
          ?.runId === runId
    }
    requireRelease(
      registered,
      'sign-run-unregistered',
      'Watcher has not registered this signing run.'
    )
    await workerOperation(store, github, {
      type: 'sign-start',
      requestId,
      platform,
      runId,
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT)
    })
    return
  }
  if (command === 'candidate-receipt') {
    const releaseDir = resolve(
      process.env.VIDEORC_RELEASE_DIR ?? join(root, 'apps/desktop/release')
    )
    const manifestPath = join(releaseDir, 'release.json')
    const manifestBytes = await readFile(manifestPath)
    const manifest = JSON.parse(manifestBytes)
    const candidate = await buildWindowsCandidateStoragePlan({
      manifest,
      manifestPath,
      releaseDir,
      ffmpegLicensePath: join(releaseDir, 'win-unpacked/resources/ffmpeg/LICENSE.txt'),
      ffmpegSourcePath: join(releaseDir, 'win-unpacked/resources/ffmpeg/SOURCE.txt')
    })
    const receipt = {
      policyVersion: RELEASE_POLICY_VERSION,
      requestId,
      platform,
      sourceSha: identity.sourceSha,
      releaseId: identity.releaseIds[platform],
      manifestHash: createHash('sha256').update(manifestBytes).digest('hex'),
      artifacts: candidate.artifacts.map(
        ({ label, objectKey, sha256, sizeBytes, contentType, immutable }) => ({
          label,
          objectKey,
          sha256,
          sizeBytes,
          contentType,
          immutable: immutable !== false
        })
      ),
      installer: {
        filename: manifest.filename,
        sha256: manifest.sha256,
        publisherName: manifest.publisherName
      }
    }
    await store.write(`evidence/${requestId}/${platform}/candidate.json`, receipt)
    return
  }
  requireRelease(false, 'worker-command', 'Unknown release worker command.')
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main()
    .catch((error) => {
      console.error(`release-worker: ${error.code ?? 'error'}: ${error.message}`)
      process.exitCode = 1
    })
    .finally(() => store.close())
