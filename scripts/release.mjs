import { createReleaseClient } from './lib/release-client.mjs'
import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createReleaseGithub,
  requireRelease,
  RELEASE_REPOSITORY,
  readReleaseRun,
  readSourceIdentity,
  approveReleaseDeployment,
  preflightReleaseReviewer
} from './lib/release-github.mjs'
import { releaseRunMetrics, summarizeReleaseMetrics } from './lib/release-metrics.mjs'
import {
  renderReleaseStatus,
  writeReleaseRecord,
  prepareReleasePr,
  reconcileDispatch,
  reconcileSupersededBuilds
} from './lib/release-controller.mjs'
import { RELEASE_POLICY_VERSION } from './lib/release-state.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const github = createReleaseGithub()
const { positionals, values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  allowPositionals: true,
  options: Object.fromEntries(
    [
      'request',
      'run',
      'attempt',
      'source',
      'tooling',
      'release-id',
      'stage',
      'version',
      'platforms',
      'entries',
      'origin-identity',
      'record-url',
      'operation-file',
      'checkpoint',
      'cache'
    ]
      .map((name) => [name, { type: 'string' }])
      .concat(['json', 'dry-run', 'once', 'activate'].map((name) => [name, { type: 'boolean' }]))
  )
})
const command = positionals[0]

const { snapshot, submit } = createReleaseClient({ github })

async function legacyStatus() {
  requireRelease(
    values.run && values.source && values['release-id'],
    'exact-run-required',
    'Legacy monitoring needs --run, --source and --release-id; never select the latest run.'
  )
  const observation = await readReleaseRun(github, values.run)
  const source = await readSourceIdentity(github, values.source, values['release-id'])
  const expected = {
    runId: values.run,
    attempt: Number(values.attempt ?? observation.run.run_attempt),
    sourceSha: values.source,
    toolingSha: values.tooling ?? values.source,
    releaseId: values['release-id'],
    stage: values.stage ?? 'legacy-sign'
  }
  const decision = await approveReleaseDeployment(
    github,
    { ...observation, source, expected },
    { dryRun: command !== 'watch' || values['dry-run'] }
  )
  const report = { ...releaseRunMetrics(observation), approval: decision }
  console.log(JSON.stringify(report, null, 2))
  return observation.run.status === 'completed'
}

async function step(state) {
  await reconcileSupersededBuilds(github, state)
  const request = state.requests[values.request]
  requireRelease(request, 'request-missing', 'Unknown release request.')
  for (const [platform, phase] of Object.entries(request.platforms)) {
    if (phase.phase === 'superseded' || phase.phase === 'live') continue
    if (platform === 'macos' && phase.phase === 'preparing') continue // local keychain host owns the build
    if (platform === 'windows' && ['preparing', 'building', 'signing'].includes(phase.phase)) {
      const stage = phase.phase === 'signing' ? 'sign' : 'build'
      const result = await reconcileDispatch({
        github,
        request,
        platform,
        stage,
        submit,
        stateRevision: state.revision
      })
      if (result.next !== 'observe') return
      requireRelease(
        !['failure', 'cancelled', 'timed_out', 'action_required'].includes(result.run.conclusion),
        'release-run-failed',
        `Exact ${stage} run ${result.run.id} ended ${result.run.conclusion}; preserve evidence and reconcile.`
      )
      if (result.run.conclusion === 'success') {
        const type = stage === 'build' ? 'dispatch' : 'signed'
        await submit({
          id: randomUUID(),
          type,
          requestId: values.request,
          platform,
          ...(type === 'dispatch' ? { stage: 'sign' } : {}),
          expectedRevision: state.revision
        })
        return
      }
      if (stage === 'sign') {
        const observation = await readReleaseRun(github, result.run.id)
        const source = await readSourceIdentity(
          github,
          request.identity.sourceSha,
          request.identity.releaseIds.windows
        )
        const expected = {
          requestId: values.request,
          runId: result.run.id,
          attempt: result.run.run_attempt,
          sourceSha: source.sha,
          toolingSha: result.run.head_sha,
          releaseId: source.releaseId,
          stage: 'sign'
        }
        const decision = await approveReleaseDeployment(
          github,
          {
            ...observation,
            expected,
            source,
            request: {
              ...request.identity,
              toolingSha: result.run.head_sha,
              superseded: state.active.windows !== values.request
            }
          },
          { dryRun: values['dry-run'] }
        )
        console.log(JSON.stringify({ platform, approval: decision }))
      }
    }
    if (
      phase.phase === 'ready-to-publish' ||
      (platform === 'windows' && phase.phase === 'awaiting-acceptance')
    ) {
      const stage =
        phase.phase === 'awaiting-acceptance'
          ? 'pilot'
          : platform === 'windows'
            ? 'public'
            : 'macos-finalize'
      const result = await reconcileDispatch({
        github,
        request,
        platform,
        stage,
        submit,
        stateRevision: state.revision
      })
      if (result.next === 'observe') {
        requireRelease(
          !['failure', 'cancelled', 'timed_out', 'action_required'].includes(result.run.conclusion),
          'release-run-failed',
          `Promotion run ${result.run.id} ended ${result.run.conclusion}; reconcile exact publication state.`
        )
        if (platform === 'windows' && result.run.status !== 'completed') {
          const observation = await readReleaseRun(github, result.run.id)
          const source = await readSourceIdentity(
            github,
            request.identity.sourceSha,
            request.identity.releaseIds.windows
          )
          const expected = {
            requestId: values.request,
            runId: result.run.id,
            attempt: result.run.run_attempt,
            sourceSha: source.sha,
            toolingSha: result.run.head_sha,
            releaseId: source.releaseId,
            stage,
            installerSha256: phase.candidate.installer.sha256
          }
          console.log(
            JSON.stringify({
              platform,
              approval: await approveReleaseDeployment(github, {
                ...observation,
                expected,
                source,
                request: {
                  ...request.identity,
                  toolingSha: result.run.head_sha,
                  superseded: state.active.windows !== values.request
                },
                acceptance: phase.acceptance
              })
            })
          )
        }
      }
      return
    }
  }
}

async function main() {
  requireRelease(
    [
      'start',
      'status',
      'watch',
      'resume',
      'cancel',
      'accept',
      'retry-build',
      'record',
      'submit'
    ].includes(command),
    'command',
    'Choose a documented release command.'
  )
  if (values.run) {
    do {
      if (await legacyStatus()) break
      if (command !== 'watch' || values.once) break
      await delay(10_000)
    } while (true)
    return
  }
  if (values['dry-run'] && !['status', 'watch', 'resume'].includes(command))
    throw new Error(
      'Dry-run refuses preparation, activation or mutation commands. Use status/watch --dry-run to inspect an existing exact request.'
    )
  if (command === 'start' && (values.platforms ?? 'macos,windows').split(',').includes('windows'))
    await preflightReleaseReviewer(github)
  if (command === 'start' && !values.activate) {
    const prepared = await prepareReleasePr({
      repoRoot: root,
      version: values.version,
      platforms: (values.platforms ?? 'macos,windows').split(','),
      entriesDirectory: resolve(values.entries ?? '.')
    })
    console.log(JSON.stringify(prepared, null, 2))
    return
  }
  let state = await snapshot()
  if (command === 'start') {
    requireRelease(
      values.request && values.source && values.version && values['origin-identity'],
      'activation-inputs',
      'Activation needs --request, --source, --version and --origin-identity after the one preparation PR merges.'
    )
    const platforms = (values.platforms ?? 'macos,windows').split(',')
    await submit({
      id: randomUUID(),
      type: 'activate',
      expectedRevision: state.revision,
      identity: {
        id: values.request,
        version: values.version,
        sourceSha: values.source,
        toolingSha: values.source,
        policyVersion: RELEASE_POLICY_VERSION,
        originIdentity: values['origin-identity'],
        platforms,
        releaseIds: Object.fromEntries(
          platforms.map((platform) => [
            platform,
            `${values.version}-${platform === 'windows' ? 'alpha' : 'beta'}.1`
          ])
        )
      }
    })
    state = await snapshot()
  }
  requireRelease(values.request, 'request-required', 'Supply an exact --request ID.')
  if (command === 'cancel') {
    for (const platform of Object.keys(state.requests[values.request]?.platforms ?? {})) {
      await submit({
        id: randomUUID(),
        type: 'cancel',
        requestId: values.request,
        platform,
        expectedRevision: state.revision
      })
      state = await snapshot()
    }
  }
  if (command === 'cancel') await reconcileSupersededBuilds(github, state)
  if (command === 'retry-build') {
    await submit({
      id: randomUUID(),
      type: 'retry-build',
      requestId: values.request,
      platform: 'windows',
      expectedRevision: state.revision
    })
    state = await snapshot()
  }
  if (command === 'accept') {
    await submit({
      id: randomUUID(),
      type: 'acceptance',
      requestId: values.request,
      platform: values.platforms ?? 'windows',
      recordUrl: values['record-url'],
      expectedRevision: state.revision
    })
    state = await snapshot()
  }
  if (command === 'submit') {
    const operation = JSON.parse(await readFile(values['operation-file'], 'utf8'))
    console.log(JSON.stringify(await submit(operation)))
    return
  }
  do {
    const report = renderReleaseStatus(state, values.request)
    const checkedAt = new Date().toISOString()
    for (const [platform, phase] of Object.entries(report.platforms)) {
      phase.metrics = await Promise.all(
        Object.values(phase.runs)
          .filter((run) => run.runId)
          .map(async (run) =>
            releaseRunMetrics(await readReleaseRun(github, run.runId, run.attempt))
          )
      )
      phase.blocker = phase.metrics.find((run) => run.blocker)?.blocker ?? phase.blocker
      phase.elapsedMs = phase.metrics.reduce((total, run) => total + (run.elapsedMs ?? 0), 0)
      phase.elapsedBasis = 'sum-of-workflow-elapsed; overlapping-workflows-may-overlap'
      const candidateRuns = phase.metrics.filter((run) =>
        ['build', 'sign'].some((stage) => phase.runs[stage]?.runId === run.runId)
      )
      phase.candidateTiming = {
        cache: values.cache ?? 'unknown',
        candidateMs:
          candidateRuns.length === 2 && candidateRuns.every((run) => run.conclusion === 'success')
            ? Math.max(...candidateRuns.map((run) => Date.parse(run.completedAt))) -
              Math.min(...candidateRuns.map((run) => Date.parse(run.createdAt)))
            : null
      }
      phase.timingSummary = summarizeReleaseMetrics([phase.candidateTiming])
    }
    console.log(JSON.stringify(report, null, 2))
    const evidencePath =
      values.checkpoint ?? join(root, 'dist', 'release-watch', `${values.request}.json`)
    let history = []
    try {
      history = JSON.parse(await readFile(evidencePath, 'utf8')).observations ?? []
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const observations = [...history.slice(-999), { checkedAt, report }]
    await mkdir(resolve(evidencePath, '..'), { recursive: true })
    await writeFile(
      evidencePath,
      JSON.stringify({ request: values.request, revision: state.revision, observations }),
      { mode: 0o600 }
    )
    if (command === 'record')
      await writeReleaseRecord(state, values.request, join(root, 'docs/releases'), {
        report,
        observations
      })
    if (!['start', 'resume', 'watch'].includes(command)) break
    if (!values['dry-run']) await step(state)
    if (values.once || command === 'start') break
    if (
      Object.values(state.requests[values.request].platforms).every((entry) =>
        ['live', 'superseded'].includes(entry.phase)
      )
    )
      break
    await delay(10_000)
    state = await snapshot()
  } while (true)
}
main().catch((error) => {
  console.error(`release: ${error.code ?? 'error'}: ${error.message}`)
  process.exitCode = 1
})
