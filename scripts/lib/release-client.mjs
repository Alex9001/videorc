import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createReleaseGithub,
  requireRelease,
  RELEASE_REPOSITORY,
  githubPages
} from './release-github.mjs'
import { CONTROL_WORKFLOW, findCorrelatedRuns } from './release-controller.mjs'
export function createReleaseClient({
  github = createReleaseGithub(),
  downloadSnapshot = null,
  sleep = delay,
  now = Date.now
} = {}) {
  const cache = new Map()
  let newest = null
  async function download(run) {
    if (cache.has(run.id)) return cache.get(run.id)
    let state
    if (downloadSnapshot) state = await downloadSnapshot(run)
    else {
      const directory = await mkdtemp(join(tmpdir(), 'videorc-state-'))
      try {
        execFileSync(
          'gh',
          [
            'run',
            'download',
            String(run.id),
            '--repo',
            RELEASE_REPOSITORY,
            '--name',
            `release-state-${run.id}`,
            '--dir',
            directory
          ],
          { stdio: 'pipe', timeout: 60_000 }
        )
        state = JSON.parse(await readFile(join(directory, 'release-state.json'), 'utf8'))
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
    cache.set(run.id, state)
    if (!newest || state.revision > newest.revision) newest = state
    return state
  }
  async function snapshot({ operation = null } = {}) {
    const correlation = operation ? `control-${operation.id}` : null
    let exactRun = null
    if (operation) {
      const dispatched = await github.api(
        `/repos/${RELEASE_REPOSITORY}/actions/workflows/${CONTROL_WORKFLOW}/dispatches`,
        {
          method: 'POST',
          body: {
            ref: 'main',
            return_run_details: true,
            inputs: { operation: JSON.stringify(operation), correlation }
          }
        }
      )
      exactRun = dispatched?.workflow_run_id
    }
    const deadline = now() + 180_000
    while (now() < deadline) {
      if (!correlation) {
        // The serialized apply job holds its lane through artifact upload. Run
        // creation order is irrelevant: choose newest uploaded state artifact.
        const artifacts = (
          await githubPages(github, `/repos/${RELEASE_REPOSITORY}/actions/artifacts`, 'artifacts')
        )
          .filter((artifact) => !artifact.expired && /^release-state-\d+$/.test(artifact.name))
          .sort((a, b) => b.id - a.id)
        for (const artifact of artifacts) {
          const runId = Number(artifact.name.slice('release-state-'.length))
          if (artifact.workflow_run?.id !== runId) continue
          const run = await github.api(`/repos/${RELEASE_REPOSITORY}/actions/runs/${runId}`)
          if (
            run.path !== '.github/workflows/release-control.yml' ||
            run.head_branch !== 'main' ||
            !['workflow_dispatch', 'schedule'].includes(run.event)
          )
            continue
          // Upload succeeded while apply held the lock, even if workflow teardown
          // remains in progress. download() validates the named immutable artifact.
          return download(run)
        }
        throw new Error('Provision and probe the controller before reading its durable snapshot.')
      }
      const runs = exactRun
        ? [await github.api(`/repos/${RELEASE_REPOSITORY}/actions/runs/${exactRun}`)]
        : await findCorrelatedRuns(github, { workflow: CONTROL_WORKFLOW, correlation })
      const trusted = runs.filter(
        (run) =>
          run.path === '.github/workflows/release-control.yml' &&
          run.head_branch === 'main' &&
          ['workflow_dispatch', 'schedule'].includes(run.event)
      )
      requireRelease(
        trusted.length <= 1,
        'control-duplicate',
        'Duplicate control runs need reconciliation.'
      )
      const run = trusted[0]
      if (run?.status === 'completed') {
        requireRelease(
          run.conclusion === 'success',
          'control-failed',
          `Control run ${run.id} failed. Its durable intent will be reconciled; inspect the run.`
        )
        return download(run)
      }
      await sleep(3000)
    }
    throw new Error(
      'Control operation remains pending. Resume its durable operation ID; do not dispatch a new release.'
    )
  }

  async function submit(operation) {
    let state = await snapshot({ operation })
    let result = state.operations[operation.id]
    // Independent platform callbacks may race on the shared state revision. Retry
    // only a durably rejected precondition, with a new intent ID and unchanged fact.
    for (let retry = 0; result?.code === 'stale-revision' && retry < 3; retry++) {
      operation = { ...operation, id: randomUUID(), expectedRevision: state.revision }
      state = await snapshot({ operation })
      result = state.operations[operation.id]
    }
    requireRelease(
      result && !['rejected'].includes(result.status),
      result?.code ?? 'control-pending',
      'Control operation was rejected or remains pending.'
    )
    return result
  }

  return { snapshot, submit }
}
