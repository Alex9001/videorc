#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReleaseGithub, requireRelease } from './lib/release-github.mjs'
import {
  createReleaseControlStore,
  controlStoreConfig,
  probeControlStore,
  submitReleaseIntent,
  reconcileReleaseIntents
} from './lib/release-control-store.mjs'
import { createOperationVerifier } from './lib/release-controller.mjs'
import { resolveReleaseUploadOrigins } from './lib/release-upload-origins.mjs'
import { releaseDigest, newReleaseState } from './lib/release-state.mjs'

export function publicationOriginIdentity(env = process.env) {
  // Read only destination variables; the control job never needs public writer keys.
  const mapped = { ...env }
  for (const origin of ['NEON', 'HETZNER'])
    if (mapped[`VIDEORC_RELEASE_UPLOAD_${origin}_S3_BUCKET`]) {
      mapped[`VIDEORC_RELEASE_UPLOAD_${origin}_S3_ACCESS_KEY_ID`] = 'identity-only'
      mapped[`VIDEORC_RELEASE_UPLOAD_${origin}_S3_SECRET_ACCESS_KEY`] = 'identity-only'
    }
  if (mapped.VIDEORC_RELEASE_UPLOAD_S3_BUCKET) {
    mapped.VIDEORC_RELEASE_UPLOAD_S3_ACCESS_KEY_ID = 'identity-only'
    mapped.VIDEORC_RELEASE_UPLOAD_S3_SECRET_ACCESS_KEY = 'identity-only'
  }
  const { origins, primaryName } = resolveReleaseUploadOrigins(mapped)
  return releaseDigest({
    primaryName,
    origins: origins.map(({ name, config }) => ({
      name,
      bucket: config.bucket,
      endpoint: config.endpointUrl ?? null,
      region: config.region,
      pathStyle: config.forcePathStyle
    }))
  })
}

async function main() {
  requireRelease(
    process.env.GITHUB_REF === 'refs/heads/main',
    'control-ref',
    'Control operations run only from protected main.'
  )
  const [command] = process.argv.slice(2)
  const store = createReleaseControlStore(controlStoreConfig())
  try {
    if (command === 'probe') return console.log(JSON.stringify(await probeControlStore(store)))
    if (command === 'submit') {
      const operation = JSON.parse(
        process.env.RELEASE_OPERATION_JSON ?? (await readFile(process.argv[3], 'utf8'))
      )
      await submitReleaseIntent(store, operation)
      return
    } else if (command === 'apply') {
      const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
      await reconcileReleaseIntents({
        store,
        verifyOperation: createOperationVerifier({
          github: createReleaseGithub(),
          store,
          repoRoot,
          originIdentity: publicationOriginIdentity()
        })
      })
    } else requireRelease(command === 'snapshot', 'control-command', 'Unknown control command.')
    const state = (await store.read('state.json'))?.value ?? newReleaseState()
    const output =
      process.env.RELEASE_CONTROL_SNAPSHOT ??
      join(process.env.RUNNER_TEMP ?? '.', 'release-state.json')
    await mkdir(resolve(output, '..'), { recursive: true })
    await writeFile(output, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    console.log(
      JSON.stringify({ revision: state.revision, requests: Object.keys(state.requests).length })
    )
  } finally {
    store.close()
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(`release-control: ${error.code ?? 'error'}: ${error.message}`)
    process.exitCode = 1
  })
