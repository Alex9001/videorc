import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createReleaseGithub, requireRelease, RELEASE_REPOSITORY } from './release-github.mjs'
import { createReleaseControlStore, controlStoreConfig } from './release-control-store.mjs'
import { workerOperation } from './release-control-client.mjs'
import { stageImmutableArtifacts } from './release-publication.mjs'
import { publicationPlanDocument } from './release-staging.mjs'
import { parseChangelogEntry } from './changelog.mjs'

export async function releaseControllerEnabled(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') return env.VIDEORC_RELEASE_CONTROLLER_ENABLED === 'true'
  const value = await createReleaseGithub()
    .api(`/repos/${RELEASE_REPOSITORY}/actions/variables/VIDEORC_RELEASE_CONTROLLER_ENABLED`)
    .catch((error) => {
      // The variable does not exist on legacy installations. Read-only gh output
      // is used only for the capability check; authentication failures fail closed.
      const output = execFileSync(
        'gh',
        ['variable', 'list', '--repo', RELEASE_REPOSITORY, '--json', 'name,value'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      )
      const entry = JSON.parse(output).find(
        (item) => item.name === 'VIDEORC_RELEASE_CONTROLLER_ENABLED'
      )
      return entry ?? { value: 'false' }
    })
  return value.value === 'true'
}

export async function stageCoordinatedPlan({ repoRoot, platform, plan, originPlan }) {
  requireRelease(
    process.env.GITHUB_REF === 'refs/heads/main',
    'publication-ref',
    'Immutable public staging runs only on trusted main.'
  )
  const store = createReleaseControlStore(controlStoreConfig())
  try {
    const requestId = process.env.RELEASE_REQUEST_ID
    const state = (await store.read('state.json')).value
    const request = state.requests[requestId]
    requireRelease(
      request &&
        state.active[platform] === requestId &&
        request.identity.releaseIds[platform] === plan.releaseId,
      'publication-request',
      'Staging request is missing, superseded or mismatched.'
    )
    const stage = plan.stage ?? 'public'
    const candidate = request.platforms[platform].candidate
    requireRelease(
      candidate && (stage === 'pilot' || request.platforms[platform].acceptance),
      'publication-acceptance',
      'Immutable public staging requires accepted exact candidate.'
    )
    const content = execFileSync(
      'git',
      ['show', `${request.identity.sourceSha}:changelog/${plan.releaseId}.md`],
      { cwd: repoRoot, encoding: 'utf8' }
    )
    const canonicalEntry = parseChangelogEntry(content, { filename: `${plan.releaseId}.md` })
    const immutableReceipts = await stageImmutableArtifacts({
      artifacts: plan.artifacts,
      origins: originPlan.reachable
    })
    const document = await publicationPlanDocument({
      requestId,
      platform,
      manifestHash: candidate.manifestHash,
      artifacts: plan.artifacts,
      canonicalEntry,
      immutableReceipts
    })
    await store.write(`publication-plans/${requestId}/${platform}-${stage}.json`, document)
    await store.write(`evidence/${requestId}/${platform}/finalization-${stage}.json`, {
      manifestHash: candidate.manifestHash,
      sourceSha: request.identity.sourceSha,
      validated: true
    })
    return document
  } finally {
    store.close()
  }
}
