#!/usr/bin/env node
// D3 retains its own sealed reservation/attestation protocol. Its special lane
// cannot overlap unresolved controller transactions or be silently migrated.
import { createReleaseControlStore, controlStoreConfig } from './lib/release-control-store.mjs'
import { requireRelease } from './lib/release-github.mjs'
async function main() {
  if (process.env.VIDEORC_RELEASE_CONTROLLER_ENABLED !== 'true') return
  const store = createReleaseControlStore(controlStoreConfig())
  try {
    const state = (await store.read('state.json'))?.value
    requireRelease(
      state && !state.publication,
      'legacy-publication-unknown',
      'A controller publication is active or unknown; reconcile it before D3.'
    )
    requireRelease(
      Object.values(state.requests).every(
        (request) =>
          !Object.values(request.platforms).some((phase) =>
            ['ready-to-publish', 'publishing', 'verifying'].includes(phase.phase)
          )
      ),
      'legacy-publication-pending',
      'D3 special publication requires a quiescent ordinary release controller.'
    )
    // Controller rollout contract refuses D3 accepted/unresolved at cutover. A new
    // D3 acceptance after cutover must explicitly suspend ordinary publication.
    requireRelease(
      process.env.VIDEORC_D3_CONTROLLER_QUIESCED === 'true',
      'd3-explicit-quiescence',
      'D3 special publication requires the documented explicit controller quiescence ceremony.'
    )
  } finally {
    store.close()
  }
}
main().catch((error) => {
  console.error(`release-legacy-guard: ${error.code ?? 'error'}: ${error.message}`)
  process.exitCode = 1
})
