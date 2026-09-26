import { randomUUID } from 'node:crypto'
import { submitReleaseIntent, waitControlResult } from './release-control-store.mjs'
import { requireRelease, RELEASE_REPOSITORY } from './release-github.mjs'

export async function workerOperation(store, github, operation) {
  for (let retry = 0; retry < 4; retry++) {
    const state = (await store.read('state.json'))?.value
    const intent = { ...operation, id: randomUUID(), expectedRevision: state?.revision ?? 0 }
    await submitReleaseIntent(store, intent)
    // Submit was already durably stored before this dispatch. The periodic
    // reconciler owns recovery if Actions displaces this pending apply job.
    await github
      .api(`/repos/${RELEASE_REPOSITORY}/actions/workflows/release-control.yml/dispatches`, {
        method: 'POST',
        body: { ref: 'main', inputs: { correlation: `control-${intent.id}` } }
      })
      .catch(() => {})
    const result = await waitControlResult(store, intent.id, { timeoutMs: 360_000 })
    if (result.code === 'stale-revision') continue
    requireRelease(result.status !== 'rejected', result.code, 'Control rejected worker operation.')
    return result
  }
  throw new Error('Control state kept advancing; durable facts remain available for resume.')
}
