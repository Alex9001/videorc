import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  requireRelease,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOWS,
  githubPages,
  readReleaseRun,
  readSourceIdentity
} from './release-github.mjs'
import {
  releaseDigest,
  validateReleaseIdentity,
  requestIsEligible,
  RELEASE_POLICY_VERSION
} from './release-state.mjs'
import { resolveWindowsAcceptanceRecord } from './windows-acceptance-record.mjs'
import { loadValidatedWindowsAcceptanceHistory } from './windows-acceptance-history.mjs'

export const CONTROL_WORKFLOW = 'release-control.yml'
export const workflowForStage = (stage) =>
  ({
    build: 'release-windows-alpha.yml',
    sign: 'sign-windows-alpha.yml',
    pilot: 'promote-windows-alpha.yml',
    public: 'promote-windows-alpha.yml',
    'macos-finalize': 'finalize-macos-beta.yml'
  })[stage]

export async function assertAncestor(github, sourceSha, mainSha) {
  const comparison = await github.api(
    `/repos/${RELEASE_REPOSITORY}/compare/${sourceSha}...${mainSha}`
  )
  requireRelease(
    ['ahead', 'identical'].includes(comparison.status) &&
      comparison.merge_base_commit?.sha === sourceSha,
    'source-not-main',
    'Source must remain reachable from protected main.'
  )
}

export async function verifyActivation({ github, identity, originIdentity }) {
  validateReleaseIdentity(identity)
  requireRelease(
    identity.originIdentity === originIdentity,
    'origin-identity',
    'Request storage configuration differs from trusted destinations.'
  )
  const branch = await github.api(`/repos/${RELEASE_REPOSITORY}/branches/main`)
  requireRelease(
    branch.protected === true &&
      branch.commit.sha === identity.sourceSha &&
      identity.toolingSha === identity.sourceSha,
    'activation-main',
    'New requests must freeze current protected main as source and tooling.'
  )
  for (const platform of identity.platforms) {
    const source = await readSourceIdentity(
      github,
      identity.sourceSha,
      identity.releaseIds[platform]
    )
    requireRelease(
      source.version === identity.version && source.changelog.platforms.includes(platform),
      'activation-version',
      'Frozen source package/changelog does not match this release.'
    )
  }
  return { identity }
}

export async function verifyProducer({
  github,
  request,
  runId,
  attempt,
  stage,
  requireSuccess = true
}) {
  const observation = await readReleaseRun(github, runId, attempt)
  const { run } = observation
  requireRelease(
    run.repository?.full_name === RELEASE_REPOSITORY &&
      run.path === RELEASE_WORKFLOWS[stage] &&
      run.event === 'workflow_dispatch' &&
      run.head_branch === 'main' &&
      run.run_attempt === attempt,
    'producer-identity',
    'Producer workflow, source, ref, event or attempt does not match.'
  )
  const main = await github.api(`/repos/${RELEASE_REPOSITORY}/commits/main`)
  await assertAncestor(github, run.head_sha, main.sha)
  const policyDiff = await github.api(
    `/repos/${RELEASE_REPOSITORY}/compare/${request.identity.toolingSha}...${run.head_sha}`
  )
  requireRelease(
    (policyDiff.files?.length ?? 301) < 300 &&
      !policyDiff.files.some((file) =>
        /^(scripts\/|\.github\/|package.json$|pnpm-lock.yaml$|rust-toolchain)/.test(file.filename)
      ),
    'tooling-policy-changed',
    'Release scripts, commands or toolchain changed after activation; reconcile the tooling policy before continuing.'
  )
  const policyPath = RELEASE_WORKFLOWS[stage]
  const [frozenPolicy, executedPolicy] = await Promise.all(
    [request.identity.toolingSha, run.head_sha].map((sha) =>
      github.api(`/repos/${RELEASE_REPOSITORY}/contents/${policyPath}?ref=${sha}`)
    )
  )
  requireRelease(
    frozenPolicy.sha === executedPolicy.sha,
    'workflow-policy-changed',
    'Workflow policy changed after activation; explicit tooling reconciliation is required.'
  )
  requireRelease(
    !requireSuccess || run.conclusion === 'success',
    'producer-incomplete',
    'Producer must have completed successfully.'
  )
  return observation
}

export async function verifyUnsignedProducer({ github, request }) {
  const dispatch = request.platforms.windows.dispatches.build
  requireRelease(dispatch?.runId, 'producer-missing', 'Registered unsigned run is missing.')
  const { run, jobs } = await verifyProducer({
    github,
    request,
    runId: dispatch.runId,
    attempt: dispatch.attempt,
    stage: 'build'
  })
  for (const name of [
    'Windows candidate source and artifact gates',
    'Build and test unsigned candidate payload'
  ])
    requireRelease(
      jobs.some((job) => job.name === name && job.conclusion === 'success'),
      'producer-gates',
      `Required release gate did not pass: ${name}.`
    )
  const artifacts = await githubPages(
    github,
    `/repos/${RELEASE_REPOSITORY}/actions/runs/${run.id}/artifacts`,
    'artifacts'
  )
  const name = `windows-alpha-unsigned-${run.id}-${run.run_attempt}`
  const artifact = artifacts.find((entry) => entry.name === name && !entry.expired)
  requireRelease(
    artifact &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest) &&
      artifact.workflow_run?.head_sha === run.head_sha,
    'producer-artifact',
    'Unsigned immutable artifact is expired, missing or has no verified digest.'
  )
  return {
    runId: run.id,
    attempt: run.run_attempt,
    artifactId: artifact.id,
    artifactDigest: artifact.digest.slice(7),
    sourceSha: request.identity.sourceSha,
    toolingSha: request.identity.toolingSha
  }
}

export function validateArtifactReceipt(receipt, identity, platform) {
  requireRelease(
    receipt?.requestId === identity.id &&
      receipt.sourceSha === identity.sourceSha &&
      receipt.releaseId === identity.releaseIds[platform] &&
      receipt.platform === platform &&
      receipt.policyVersion === RELEASE_POLICY_VERSION,
    'receipt-identity',
    'Artifact receipt identity differs from activated request.'
  )
  requireRelease(
    /^[a-f0-9]{64}$/.test(receipt.manifestHash) &&
      Array.isArray(receipt.artifacts) &&
      receipt.artifacts.length > 0 &&
      receipt.artifacts.length < 100,
    'receipt-artifacts',
    'Artifact receipt needs bounded hash-bound artifacts.'
  )
  const artifacts = receipt.artifacts.map(
    ({ objectKey, sha256, sizeBytes, label, contentType, immutable }) => {
      requireRelease(
        /^[a-zA-Z0-9][a-zA-Z0-9/._-]+$/.test(objectKey) &&
          !objectKey.split('/').includes('..') &&
          /^[a-f0-9]{64}$/.test(sha256) &&
          Number.isSafeInteger(sizeBytes) &&
          sizeBytes > 0,
        'receipt-artifact',
        'Invalid artifact descriptor.'
      )
      requireRelease(
        typeof label === 'string' &&
          /^[a-z0-9-]+$/.test(label) &&
          typeof contentType === 'string' &&
          contentType.length < 100,
        'receipt-artifact-label',
        'Invalid artifact label/type.'
      )
      return { objectKey, sha256, sizeBytes, label, contentType, immutable: immutable === true }
    }
  )
  return {
    requestId: identity.id,
    sourceSha: identity.sourceSha,
    releaseId: identity.releaseIds[platform],
    platform,
    policyVersion: RELEASE_POLICY_VERSION,
    manifestHash: receipt.manifestHash,
    artifacts,
    ...(receipt.installer
      ? {
          installer: {
            filename: receipt.installer.filename,
            sha256: receipt.installer.sha256,
            publisherName: receipt.installer.publisherName
          }
        }
      : {})
  }
}

export function createOperationVerifier({
  github,
  store,
  originIdentity,
  repoRoot,
  readEvidence = async (key) => (await store.read(key))?.value
}) {
  return async (operation, state) => {
    if (operation.type === 'activate')
      return verifyActivation({ github, identity: operation.identity, originIdentity })
    const request = state.requests[operation.requestId]
    requireRelease(request, 'request-missing', 'Unknown request.')
    const platform = request.platforms[operation.platform]
    requireRelease(platform, 'platform-missing', 'Platform not requested.')
    const main = await github.api(`/repos/${RELEASE_REPOSITORY}/commits/main`)
    await assertAncestor(github, request.identity.sourceSha, main.sha)
    await assertAncestor(github, request.identity.toolingSha, main.sha)
    if (operation.type === 'dispatch' && operation.stage === 'sign')
      await verifyUnsignedProducer({ github, request })
    if (
      ['cancel', 'retry-build', 'dispatch', 'dispatch-start', 'publication-unknown'].includes(
        operation.type
      )
    )
      return {}
    if (operation.type === 'run') {
      const observation = await verifyProducer({
        github,
        request,
        runId: operation.runId,
        attempt: operation.attempt,
        stage: operation.stage,
        requireSuccess: false
      })
      // Correlation is a discovery hint only; the immutable request identity and
      // provenance above are authority, and the controller rejects duplicates.
      requireRelease(
        observation.run.display_title === platform.dispatches[operation.stage]?.correlation,
        'dispatch-correlation',
        'Run does not carry the persisted dispatch correlation.'
      )
      return {
        run: {
          correlation: observation.run.display_title,
          runId: observation.run.id,
          attempt: observation.run.run_attempt,
          url: observation.run.html_url,
          toolingSha: observation.run.head_sha
        }
      }
    }
    if (operation.type === 'sign-start')
      return {
        unsigned: await verifyUnsignedProducer({ github, request }),
        runId: operation.runId,
        attempt: operation.attempt
      }
    if (operation.type === 'signed' || operation.type === 'staged') {
      if (operation.type === 'signed') {
        const dispatch = platform.dispatches.sign
        requireRelease(dispatch, 'signing-missing', 'Signing run is unregistered.')
        await verifyProducer({
          github,
          request,
          runId: dispatch.runId,
          attempt: dispatch.attempt,
          stage: 'sign'
        })
      }
      const receipt = await readEvidence(
        `evidence/${operation.requestId}/${operation.platform}/candidate.json`
      )
      return validateArtifactReceipt(receipt, request.identity, operation.platform)
    }
    if (operation.type === 'acceptance') {
      requireRelease(
        platform.candidate,
        'candidate-missing',
        'Acceptance needs the immutable candidate.'
      )
      if (operation.platform === 'windows') {
        const installer = platform.candidate.installer
        requireRelease(installer, 'installer-missing', 'Candidate installer receipt missing.')
        const priorAcceptedReleaseIds = (
          await loadValidatedWindowsAcceptanceHistory(
            join(repoRoot, 'docs/acceptance/windows-alpha')
          )
        ).filter((id) => id !== request.identity.releaseIds.windows)
        const resolved = await resolveWindowsAcceptanceRecord({
          url: operation.recordUrl,
          expectations: {
            ...installer,
            installerSha256: installer.sha256,
            sourceCommit: request.identity.sourceSha,
            releaseId: request.identity.releaseIds.windows,
            priorAcceptedReleaseIds
          }
        })
        await assertAncestor(github, resolved.recordCommit, main.sha)
        return {
          status: resolved.record.status === 'OWNER_WAIVED' ? 'waived' : 'PASS',
          sourceSha: request.identity.sourceSha,
          releaseId: request.identity.releaseIds.windows,
          installerSha256: installer.sha256,
          recordUrl: resolved.publicUrl
        }
      }
      const receipt = await readEvidence(`evidence/${operation.requestId}/macos/acceptance.json`)
      requireRelease(
        receipt?.status === 'PASS' &&
          receipt.manifestHash === platform.candidate.manifestHash &&
          receipt.sourceSha === request.identity.sourceSha &&
          receipt.releaseId === request.identity.releaseIds.macos &&
          receipt.previousVersionUpdate === 'PASS' &&
          receipt.physicalGates === 'PASS',
        'macos-acceptance',
        'macOS requires exact-artifact physical acceptance and previous-version update evidence.'
      )
      return {
        status: 'PASS',
        sourceSha: receipt.sourceSha,
        releaseId: receipt.releaseId,
        manifestHash: receipt.manifestHash
      }
    }
    if (operation.type === 'claim') {
      requireRelease(
        requestIsEligible(state, operation.requestId, operation.platform) ||
          (state.publication?.requestId === operation.requestId &&
            state.publication.platform === operation.platform &&
            state.publication.stage === (operation.stage ?? 'public') &&
            state.publication.status === 'active'),
        'superseded',
        'Superseded requests cannot claim publication.'
      )
      requireRelease(
        request.identity.originIdentity === originIdentity,
        'origin-identity',
        'Publication destinations changed.'
      )
      // Finalizer revalidates actual bytes and acceptance before asking for claim.
      const evidence = await readEvidence(
        `evidence/${operation.requestId}/${operation.platform}/finalization-${operation.stage ?? 'public'}.json`
      )
      requireRelease(
        evidence?.manifestHash === platform.candidate?.manifestHash &&
          evidence.sourceSha === request.identity.sourceSha &&
          evidence.validated === true,
        'finalization-proof',
        'Missing exact finalizer validation evidence.'
      )
      return { eligible: true }
    }
    if (['write-intent', 'write-complete'].includes(operation.type)) {
      const write = operation.write
      requireRelease(
        write &&
          /^[a-z0-9/-]+$/.test(write.origin) &&
          /^[a-f0-9]{64}$/.test(write.sha256) &&
          /^[a-zA-Z0-9/._-]+$/.test(write.objectKey) &&
          !write.objectKey.includes('..'),
        'write-receipt',
        'Invalid publication write receipt.'
      )
      return {
        write: {
          key: `${write.origin}/${write.objectKey}`,
          origin: write.origin,
          objectKey: write.objectKey,
          sha256: write.sha256
        }
      }
    }
    if (operation.type === 'recover-publication') {
      const receipt = await readEvidence(
        `evidence/${operation.requestId}/${operation.platform}/recovery-${state.publication?.generation}.json`
      )
      requireRelease(
        receipt?.inspected === true && receipt.generation === state.publication?.generation,
        'recovery-proof',
        'Missing exact-generation reconciliation evidence.'
      )
      return { inspected: true, generation: receipt.generation }
    }
    if (operation.type === 'published') {
      const receipt = await readEvidence(
        `evidence/${operation.requestId}/${operation.platform}/publication-${state.publication?.generation}.json`
      )
      requireRelease(
        receipt?.generation === state.publication?.generation &&
          receipt.requestId === operation.requestId &&
          receipt.primaryVerified === true,
        'publication-proof',
        'Publication receipt does not match active generation.'
      )
      return { publication: receipt }
    }
    if (operation.type === 'mirror-synced') {
      requireRelease(
        !state.publication &&
          operation.generation === state.lastPublished?.[operation.platform] &&
          platform.publication?.generation === operation.generation,
        'mirror-stale',
        'Mirror receipt must match the current published generation with no unresolved writer.'
      )
      const receipt = await readEvidence(
        `evidence/${operation.requestId}/${operation.platform}/mirror-${operation.origin}-${operation.generation}.json`
      )
      requireRelease(
        receipt?.verified === true &&
          receipt.origin === operation.origin &&
          receipt.generation === operation.generation &&
          receipt.requestId === operation.requestId,
        'mirror-proof',
        'Missing exact-generation mirror catch-up proof.'
      )
      return { mirror: { origin: operation.origin, generation: operation.generation } }
    }
    if (operation.type === 'production') {
      const receipt = operation.production
      const expectedArtifacts = platform.publication?.artifacts ?? []
      const expectedRoutes = expectedArtifacts.filter((artifact) =>
        ['feed-installer', 'feed-zip', 'feed-blockmap', 'feed-manifest'].includes(artifact.label)
      )
      const installer = expectedArtifacts.find(
        (artifact) => artifact.label === (operation.platform === 'windows' ? 'installer' : 'dmg')
      )
      const matches = (route, artifact) =>
        route?.status === 'PASS' &&
        route.sha256 === artifact?.sha256 &&
        route.sizeBytes === artifact?.sizeBytes
      requireRelease(
        expectedRoutes.length >= 3 &&
          receipt?.routes?.length === expectedRoutes.length + 1 &&
          expectedRoutes.every((artifact) =>
            matches(
              receipt.routes.find((route) => route.label === artifact.label),
              artifact
            )
          ) &&
          matches(
            receipt.routes.find((route) => route.label === 'signed-in-download'),
            installer
          ) &&
          receipt.releasePage === 'PASS' &&
          (platform.publication.origins.length < 2 || receipt.mirrorRoute === 'PASS'),
        'production-observation',
        'Production observation must bind every canonical updater artifact, signed-in installer and exact release page plus configured mirror routes.'
      )

      requireRelease(
        receipt?.generation === platform.publication?.generation &&
          receipt.requestId === operation.requestId &&
          receipt.complete === true,
        'production-proof',
        'Production evidence does not match publication generation.'
      )
      return { production: receipt }
    }
    if (operation.type.startsWith('announcement-')) {
      requireRelease(
        operation.announcement && /^[a-f0-9]{64}$/.test(operation.announcement.key),
        'announcement-key',
        'Invalid announcement receipt key.'
      )
      const { key, channel, contentHash, messageId, status } = operation.announcement
      requireRelease(
        ['discord', 'blog'].includes(channel) &&
          /^[a-f0-9]{64}$/.test(contentHash) &&
          (!messageId || /^[a-zA-Z0-9_-]{1,100}$/.test(messageId)),
        'announcement-receipt',
        'Invalid announcement receipt.'
      )
      return {
        announcement: {
          key,
          channel,
          contentHash,
          ...(messageId ? { messageId } : {}),
          ...(status ? { status } : {})
        }
      }
    }
    requireRelease(false, 'operation-type', 'Unsupported control operation.')
  }
}

export async function findCorrelatedRuns(github, { workflow, correlation }) {
  const runs = await githubPages(
    github,
    `/repos/${RELEASE_REPOSITORY}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=main`,
    'workflow_runs'
  )
  return runs.filter((run) => run.display_title === correlation)
}

export async function reconcileDispatch({
  github,
  request,
  platform,
  stage,
  submit,
  stateRevision
}) {
  const workflow = workflowForStage(stage)
  requireRelease(workflow, 'dispatch-stage', 'Unknown dispatch stage.')
  let dispatch = request.platforms[platform].dispatches[stage]
  if (!dispatch) {
    await submit({
      id: randomUUID(),
      type: 'dispatch',
      requestId: request.identity.id,
      platform,
      stage,
      expectedRevision: stateRevision
    })
    return { next: 'refresh-state' }
  }
  const runs = dispatch.runId
    ? [(await readReleaseRun(github, dispatch.runId, dispatch.attempt)).run]
    : await findCorrelatedRuns(github, { workflow, correlation: dispatch.correlation })
  requireRelease(
    runs.length <= 1,
    'duplicate-dispatch',
    'Multiple correlated runs require reconciliation; no signing or publication will proceed.'
  )
  if (runs[0]) {
    if (!dispatch.runId)
      await submit({
        id: randomUUID(),
        type: 'run',
        requestId: request.identity.id,
        platform,
        stage,
        runId: runs[0].id,
        attempt: runs[0].run_attempt,
        expectedRevision: stateRevision
      })
    return { next: 'observe', run: runs[0] }
  }
  // The intent is durable before dispatch. A lost response is ambiguous: caller
  // must inspect workflow runs, not create another correlation or version.
  requireRelease(
    dispatch.state === 'intent',
    'dispatch-missing',
    'Recorded run disappeared; inspect remote Actions state.'
  )
  const lease = await submit({
    id: randomUUID(),
    type: 'dispatch-start',
    requestId: request.identity.id,
    platform,
    stage,
    expectedRevision: stateRevision
  })
  requireRelease(
    lease.status === 'applied',
    'dispatch-owned',
    'Another controller owns this dispatch. Reconcile its run.'
  )
  const inputs = {
    request_id: request.identity.id,
    source_commit: request.identity.sourceSha,
    correlation: dispatch.correlation,
    release_id: request.identity.releaseIds[platform]
  }
  if (['pilot', 'public'].includes(stage))
    Object.assign(inputs, {
      stage,
      installer_sha256: request.platforms[platform].candidate.installer.sha256,
      acceptance_record_url: request.platforms[platform].acceptance?.recordUrl ?? ''
    })
  const dispatched = await github.api(
    `/repos/${RELEASE_REPOSITORY}/actions/workflows/${workflow}/dispatches`,
    { method: 'POST', body: { ref: 'main', inputs, return_run_details: true } }
  )
  if (dispatched?.workflow_run_id)
    await submit({
      id: randomUUID(),
      type: 'run',
      requestId: request.identity.id,
      platform,
      stage,
      runId: dispatched.workflow_run_id,
      attempt: 1,
      expectedRevision: lease.revision
    })
  return { next: 'reconcile-dispatch' }
}

export function renderReleaseStatus(state, requestId) {
  const request = state.requests[requestId]
  requireRelease(request, 'request-missing', 'Unknown release request.')
  return {
    id: requestId,
    revision: state.revision,
    version: request.identity.version,
    sourceSha: request.identity.sourceSha,
    platforms: Object.fromEntries(
      Object.entries(request.platforms).map(([platform, value]) => [
        platform,
        {
          phase: value.phase,
          blocker:
            {
              'awaiting-acceptance':
                'Physical acceptance or existing owner-authored Windows waiver required',
              'publication-unknown': 'Reconcile remote writes before another publication',
              superseded: 'A newer request owns preparation'
            }[value.phase] ?? null,
          next:
            {
              preparing: 'dispatch build',
              building: 'observe source gates and package',
              signing: 'approve eligible deployment and observe immutable candidate',
              'ready-to-publish': 'dispatch finalization',
              verifying: 'verify production routes',
              live: 'finish pending announcements'
            }[value.phase] ?? null,
          publication: value.publication
            ? {
                generation: value.publication.generation,
                origins: value.publication.origins,
                pendingOrigins: value.publication.pendingOrigins,
                mirrorReceipts: value.mirrorReceipts ?? {}
              }
            : null,
          runs: value.dispatches
        }
      ])
    )
  }
}

export async function writeReleaseRecord(state, requestId, directory, evidence = null) {
  const summary = renderReleaseStatus(state, requestId)
  const request = state.requests[requestId]
  const lines = [
    `# Videorc ${summary.version}`,
    '',
    `Request: \`${requestId}\``,
    `Source: \`${summary.sourceSha}\``,
    `Policy: ${request.identity.policyVersion}`,
    '',
    '| Platform | Release | State | Acceptance |',
    '| --- | --- | --- | --- |'
  ]
  for (const [platform, value] of Object.entries(request.platforms))
    lines.push(
      `| ${platform} | ${request.identity.releaseIds[platform]} | ${value.phase} | ${value.acceptance?.status ?? 'pending'} |`
    )
  lines.push(
    '',
    'Generated from sanitized durable control receipts. A successful build is not a production verification.',
    ''
  )
  await mkdir(directory, { recursive: true })
  if (evidence)
    lines.push(
      '## Observed workflow timings',
      '',
      'Queue and approval durations are unknown between watcher observations. Workflow elapsed time includes dependencies.',
      '',
      '```json',
      JSON.stringify(evidence.report, null, 2),
      '```',
      ''
    )
  await writeFile(join(directory, `${summary.version}.md`), lines.join('\n'))
  if (evidence)
    await writeFile(
      join(directory, `${summary.version}.timings.json`),
      JSON.stringify(evidence, null, 2) + '\n'
    )
}

export async function prepareReleasePr({
  repoRoot,
  version,
  platforms,
  entriesDirectory,
  execute = execFileSync
}) {
  requireRelease(
    /^\d+\.\d+\.\d+$/.test(version),
    'prepare-version',
    'Supply the selected numeric release version.'
  )
  requireRelease(
    execute('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim() === '',
    'prepare-dirty',
    'Prepare a release in a clean worktree.'
  )
  const pkgPath = join(repoRoot, 'apps/desktop/package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  const { compareNumericVersions } = await import('./windows-alpha-release.mjs')
  requireRelease(
    compareNumericVersions(version, pkg.version) > 0,
    'prepare-version-regression',
    'New release version must advance the package version.'
  )
  const { parseChangelogEntry } = await import('./changelog.mjs')
  const entries = []
  for (const platform of platforms) {
    const id = `${version}-${platform === 'windows' ? 'alpha' : 'beta'}.1`
    const content = await readFile(join(entriesDirectory, `${id}.md`), 'utf8')
    const parsed = parseChangelogEntry(content, { filename: `${id}.md` })
    requireRelease(
      parsed.platforms.includes(platform),
      'prepare-platform',
      'Changelog entry must include the requested platform.'
    )
    entries.push({ id, content })
  }
  execute('git', ['switch', '-c', `release/${version}`], { cwd: repoRoot })
  await writeFile(pkgPath, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`)
  for (const entry of entries)
    await writeFile(join(repoRoot, 'changelog', `${entry.id}.md`), entry.content)
  return {
    version,
    files: ['apps/desktop/package.json', ...entries.map(({ id }) => `changelog/${id}.md`)],
    next: 'Review these prepared files, run changelog:check and the repository commit checkpoint, open one preparation PR, and activate the merged source. Windows and the local macOS build then proceed independently.'
  }
}

export async function reconcileSupersededBuilds(github, state) {
  for (const request of Object.values(state.requests)) {
    const platform = request.platforms.windows
    if (
      !platform ||
      platform.phase !== 'superseded' ||
      state.active.windows === request.identity.id
    )
      continue
    const dispatch = platform.dispatches.build
    if (!dispatch?.runId) continue
    const { run } = await readReleaseRun(github, dispatch.runId, dispatch.attempt)
    requireRelease(
      run.path === RELEASE_WORKFLOWS.build &&
        run.repository?.full_name === RELEASE_REPOSITORY &&
        run.event === 'workflow_dispatch' &&
        run.head_branch === 'main' &&
        run.display_title === dispatch.correlation,
      'cancel-ownership',
      'Cannot establish ownership of superseded unsigned workflow.'
    )
    // Controlled build workflow has no signing job; legacy runs have no matching
    // registered request correlation and are never reaped here.
    if (['queued', 'pending', 'in_progress', 'waiting'].includes(run.status))
      await github.api(`/repos/${RELEASE_REPOSITORY}/actions/runs/${run.id}/cancel`, {
        method: 'POST'
      })
  }
}
