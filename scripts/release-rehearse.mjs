import { rehearseRemotePublication } from './lib/release-remote-rehearsal.mjs'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import {
  createReleaseControlStore,
  controlStoreConfig,
  probeControlStore,
  submitReleaseIntent,
  reconcileReleaseIntents
} from './lib/release-control-store.mjs'
import { requireRelease } from './lib/release-github.mjs'
import { resolveReleaseUploadOrigins } from './lib/release-upload-origins.mjs'

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: { scenario: { type: 'string', default: 'all' }, remote: { type: 'boolean' } }
  })
  requireRelease(
    ['all', 'controller-resume', 'publication-recovery'].includes(values.scenario),
    'rehearsal-scenario',
    'Select all, controller-resume or publication-recovery.'
  )
  const tests =
    values.scenario === 'controller-resume'
      ? ['release-controller', 'release-state']
      : values.scenario === 'publication-recovery'
        ? ['release-publication', 'release-announcement']
        : [
            'release-controller',
            'release-state',
            'release-control-store',
            'release-publication',
            'release-announcement',
            'release-github',
            'release-metrics',
            'release-client',
            'release-production',
            'release-readiness',
            'release-macos-integrity',
            'release-workflow-contract'
          ]
  execFileSync(
    process.execPath,
    ['--test', ...tests.map((name) => `scripts/lib/${name}.test.mjs`)],
    { stdio: 'inherit' }
  )
  if (!values.remote) {
    console.log(
      JSON.stringify({
        mode: 'local-fault-injection',
        scenario: values.scenario,
        result: 'PASS',
        hostedSigning: 'not-run',
        remoteStorage: 'not-run'
      })
    )
    return
  }
  const configured = controlStoreConfig()
  requireRelease(
    /^videorc-release-control\/staging-[a-z0-9-]+$/.test(configured.prefix) &&
      [configured.config, configured.dataConfig].every((config) =>
        /^videorc-release-rehearsal-[a-z0-9-]+$/.test(config.bucket)
      ),
    'rehearsal-production-denied',
    'Remote rehearsal requires a dedicated videorc-release-rehearsal-* bucket and staging-* control prefix.'
  )
  const production = resolveReleaseUploadOrigins().origins
  requireRelease(
    production.every(({ config }) =>
      [configured.config, configured.dataConfig].every(
        (staging) => config.bucket !== staging.bucket || config.endpointUrl !== staging.endpointUrl
      )
    ),
    'rehearsal-production-denied',
    'Rehearsal destination overlaps a configured production origin.'
  )
  const store = createReleaseControlStore(configured)
  try {
    const probe = await probeControlStore(store)
    const first = (await store.read('state.json'))?.value
    const suffix = randomUUID()
    const identity = {
      id: `rehearsal-${suffix}`,
      version: `999.0.${Date.now()}`,
      platforms: ['windows'],
      releaseIds: { windows: `999.0.${Date.now()}-alpha.1` },
      sourceSha: 'a'.repeat(40),
      toolingSha: 'a'.repeat(40),
      policyVersion: 1,
      originIdentity: 'b'.repeat(64)
    }
    identity.releaseIds.windows = `${identity.version}-alpha.1`
    const operation = {
      id: `activate-${suffix}`,
      type: 'activate',
      expectedRevision: first?.revision ?? 0,
      identity
    }
    await submitReleaseIntent(store, operation)
    // Fresh transport replays the immutable intent after the submitting process
    // has lost local state. Only the isolated rehearsal namespace is writable.
    await reconcileReleaseIntents({ store, verifyOperation: async () => ({ identity }) })
    const replay = await reconcileReleaseIntents({
      store,
      verifyOperation: () => {
        throw new Error('A durable completed operation must not be applied twice.')
      }
    })
    requireRelease(
      replay.operations[operation.id].status === 'applied',
      'rehearsal-result',
      'Remote operation did not resume idempotently.'
    )
    const publicationRecovery =
      values.scenario === 'controller-resume'
        ? 'not-requested'
        : await rehearseRemotePublication(configured)
    console.log(
      JSON.stringify({
        publicationRecovery,
        mode: 'isolated-remote-storage',
        scenario: values.scenario,
        conditionalWrites: probe,
        durableResume: 'PASS',
        hostedSigning: 'not-run',
        productionWrites: 'denied'
      })
    )
  } finally {
    store.close()
  }
}
main().catch((error) => {
  console.error(`release-rehearse: ${error.code ?? 'error'}: ${error.message}`)
  process.exitCode = 1
})
