import { verifyMacosBundleIntegrity } from './lib/release-macos-integrity.mjs'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReleaseControlStore, controlStoreConfig } from './lib/release-control-store.mjs'
import { requireRelease, createReleaseGithub } from './lib/release-github.mjs'
import { workerOperation } from './lib/release-control-client.mjs'
import { planReleaseUploadOrigins } from './lib/release-upload-origins.mjs'
import { buildSignedS3Request, createReleaseUploadS3Transport } from './lib/release-upload-s3.mjs'
import { downloadStagedBundle, restorePublicationPlan } from './lib/release-staging.mjs'
import { stageCoordinatedPlan } from './lib/release-coordinator.mjs'
import {
  finalizePublication,
  exactPublishedChangelog,
  publicationPlatformMap,
  inlinePublicationArtifact
} from './lib/release-publication.mjs'
import { readRemoteTextObject } from './lib/windows-release-publication.mjs'
import { releaseDigest } from './lib/release-state.mjs'

async function main() {
  const command = process.argv[2]
  requireRelease(
    process.env.GITHUB_REF === 'refs/heads/main' &&
      process.env.VIDEORC_RELEASE_CONTROLLER_ENABLED === 'true',
    'finalizer-context',
    'Finalization requires enabled protected-main workflow context.'
  )
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const requestId = process.env.RELEASE_REQUEST_ID
  const platform = process.env.RELEASE_PLATFORM
  const stage = process.env.RELEASE_STAGE ?? 'public'
  const configured = controlStoreConfig()
  const store = createReleaseControlStore(configured)
  const github = createReleaseGithub()
  try {
    let state = (await store.read('state.json')).value
    const request = state.requests[requestId]
    const phase = request?.platforms[platform]
    requireRelease(
      request && (stage === 'pilot' || phase?.acceptance) && phase?.candidate,
      'finalization-request',
      'Finalization requires accepted exact candidate.'
    )
    const originPlan = await planReleaseUploadOrigins()
    if (command === 'prepare-macos') {
      requireRelease(
        platform === 'macos',
        'finalizer-platform',
        'macOS preparation cannot publish another platform.'
      )
      const document = (await store.read(`bundles/${requestId}/macos.json`))?.value
      requireRelease(
        document?.manifestHash === phase.candidate.manifestHash,
        'macos-bundle',
        'Private staged manifest differs from registered candidate.'
      )
      const artifacts = await downloadStagedBundle({
        document,
        ...configured,
        config: configured.dataConfig,
        request: request.identity,
        outputDir: join(process.env.RUNNER_TEMP, 'macos-staged-bytes')
      })
      const releaseDir = join(root, 'apps/desktop/release')
      await mkdir(releaseDir, { recursive: true })
      for (const artifact of artifacts)
        await copyFile(artifact.path, join(releaseDir, basename(artifact.objectKey)))
      const dmg = artifacts.find((entry) => entry.label === 'dmg')
      requireRelease(dmg, 'macos-dmg', 'Staging bundle has no signed DMG.')
      execFileSync(
        process.execPath,
        [
          join(root, 'scripts/validate-macos-release-artifact.mjs'),
          join(releaseDir, basename(dmg.objectKey))
        ],
        { cwd: root, stdio: 'inherit', env: process.env }
      )
      const manifest = JSON.parse(await readFile(join(releaseDir, 'release.json'), 'utf8'))
      await verifyMacosBundleIntegrity({ releaseDir, manifest, artifacts })
      await stageCoordinatedPlan({
        repoRoot: root,
        platform,
        originPlan,
        plan: { releaseId: document.releaseId, artifacts }
      })
      return
    }
    requireRelease(
      command === 'publish' || command === 'recover',
      'finalizer-command',
      'Unknown finalization command.'
    )
    const document = (await store.read(`publication-plans/${requestId}/${platform}-${stage}.json`))
      ?.value
    requireRelease(
      document && document.manifestHash === phase.candidate.manifestHash,
      'finalization-plan',
      'Durable publication plan is missing or changed.'
    )
    const artifacts = restorePublicationPlan(document)
    const journalRoot = `journals/${requestId}/${platform}-${stage}`
    const operation = (type, extra = {}) =>
      workerOperation(store, github, { type, requestId, platform, ...extra })
    if (command === 'recover') {
      requireRelease(
        state.publication?.requestId === requestId && state.publication.platform === platform,
        'recovery-claim',
        'Recovery must own the unresolved generation.'
      )
      // Inspect every possibly committed write before resuming this same generation.
      // A conflict leaves the generation unknown and requires explicit recovery.
      for (const key of await store.list(`${journalRoot}/`)) {
        if (!key.endsWith('-intent.json')) continue
        const intent = (await store.read(key)).value
        const origin = originPlan.reachable.find(({ name }) => name === intent.origin)
        requireRelease(origin, 'recovery-origin', 'An origin with uncertain writes is unreachable.')
        const current = await readRemoteTextObject({
          config: origin.config,
          objectKey: intent.objectKey
        })
        if (current !== null) {
          const digest = releaseDigest({ bytes: Buffer.from(current).toString('base64') })
          requireRelease(
            digest === intent.nextDigest || digest === intent.previousDigest,
            'recovery-conflict',
            'Remote pointer matches neither pre-write nor intended bytes. Keep generation unknown.'
          )
        } else
          requireRelease(
            intent.previousDigest === null,
            'recovery-missing',
            'Previously published pointer disappeared.'
          )
      }
      await store.write(
        `evidence/${requestId}/${platform}/recovery-${state.publication.generation}.json`,
        { generation: state.publication.generation, inspected: true }
      )
      await operation('recover-publication')
      state = (await store.read('state.json')).value
    }
    const primary = originPlan.reachable.find(({ name }) => name === originPlan.primaryName)
    requireRelease(primary, 'primary-unavailable', 'Primary must be reachable before publication.')
    const primaryText = await readRemoteTextObject({
      config: primary.config,
      objectKey: 'changelog/changelog.json'
    })
    const primaryDocument = primaryText ? JSON.parse(primaryText) : null
    const maps = publicationPlatformMap(state, requestId, platform)
    const verifiedPlatforms = maps[request.identity.releaseIds[platform]]
    const originByConfig = new Map(originPlan.reachable.map((origin) => [origin.config, origin]))
    const publication = await finalizePublication({
      requestId,
      platform,
      artifacts,
      origins: originPlan.reachable,
      primaryName: originPlan.primaryName,
      blockedOrigins: originPlan.blocked,
      claim: async () => (await operation('claim', { stage })).claim,
      readRemote: (origin, key) => readRemoteTextObject({ config: origin.config, objectKey: key }),
      verifyImmutable: async ({ artifact, config }) => {
        const origin = originByConfig.get(config)
        const staged = document.immutableReceipts.find(
          (receipt) =>
            receipt.origin === origin.name &&
            receipt.objectKey === artifact.objectKey &&
            receipt.sha256 === artifact.sha256 &&
            receipt.sizeBytes === artifact.sizeBytes
        )
        requireRelease(
          staged?.etag,
          'staging-receipt',
          'Missing verified staging ETag; repeat preparation outside the publication lane.'
        )
        const transport = createReleaseUploadS3Transport({ config })
        try {
          const signed = buildSignedS3Request({
            config,
            method: 'HEAD',
            objectKey: artifact.objectKey
          })
          const response = await transport.request(signed.url, {
            method: 'HEAD',
            headers: signed.headers
          })
          response.body?.destroy?.()
          requireRelease(
            response.ok &&
              response.headers.get('etag') === staged.etag &&
              Number(response.headers.get('content-length')) === artifact.sizeBytes &&
              response.headers.get('x-amz-meta-videorc-sha256') === artifact.sha256,
            'staging-changed',
            'Immutable staging identity changed; reverify outside the publication lane.'
          )
          return { state: 'identical' }
        } finally {
          transport.close()
        }
      },
      buildChangelog:
        stage === 'pilot'
          ? null
          : async (origin) => {
              const text = await readRemoteTextObject({
                config: origin.config,
                objectKey: 'changelog/changelog.json'
              })
              const remote = text ? JSON.parse(text) : primaryDocument
              const combined =
                remote && primaryDocument
                  ? {
                      ...remote,
                      entries: [
                        ...remote.entries,
                        ...primaryDocument.entries.filter(
                          (entry) =>
                            !remote.entries.some((other) => other.version === entry.version)
                        )
                      ]
                    }
                  : remote
              const merged = exactPublishedChangelog({
                canonicalEntry: document.canonicalEntry,
                remoteDocument: combined,
                verifiedPlatforms,
                generatedAt: `${document.canonicalEntry.date}T00:00:00.000Z`
              })
              return inlinePublicationArtifact({
                objectKey: 'changelog/changelog.json',
                value: merged
              })
            },
      writeIntent: async (receipt) => {
        const origin = originPlan.reachable.find(({ name }) => name === receipt.origin)
        const previous = await readRemoteTextObject({
          config: origin.config,
          objectKey: receipt.objectKey
        })
        const key = releaseDigest({ origin: receipt.origin, objectKey: receipt.objectKey })
        // Store exact intended pointer body through the plan/changelog hashes;
        // journal input is immutable, and receipt verification determines retry.
        const old = await store.read(`${journalRoot}/${key}-intent.json`)
        if (old)
          requireRelease(
            old.value.sha256 === receipt.sha256,
            'journal-conflict',
            'Same generation proposed different pointer bytes.'
          )
        else
          await store.write(`${journalRoot}/${key}-intent.json`, {
            ...receipt,
            previousDigest:
              previous === null
                ? null
                : releaseDigest({ bytes: Buffer.from(previous).toString('base64') }),
            nextDigest: releaseDigest({ bytes: receipt.bodyBase64 })
          })
      },
      writeComplete: async (receipt) => {
        const key = releaseDigest({ origin: receipt.origin, objectKey: receipt.objectKey })
        await store.write(`${journalRoot}/${key}-verified.json`, receipt)
      },
      complete: async (receipt) => {
        await store.write(
          `evidence/${requestId}/${platform}/publication-${receipt.generation}.json`,
          receipt
        )
        await operation('published')
      },
      unknown: async () => {
        await operation('publication-unknown')
      }
    })
    console.log(
      JSON.stringify({
        requestId,
        platform,
        generation: publication.generation,
        phase: 'verifying',
        pendingOrigins: publication.pendingOrigins
      })
    )
  } finally {
    store.close()
  }
}
main().catch((error) => {
  console.error(`release-finalize: ${error.code ?? 'error'}: ${error.message}`)
  process.exitCode = 1
})
